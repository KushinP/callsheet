-- ============================================================================
-- How many open tasks a lead has, on the lead — and the flow chart splitting on
-- it.
--
-- The flow's "No next step yet" bucket was every lead sitting at a stage,
-- whether or not anything was queued for it. So the moment outcome playbooks
-- started creating callbacks, the label became a lie about the very leads it
-- had just fixed: a lead with three tasks still filed under "no next step".
--
-- Answering it per lead means a NOT EXISTS against tasks, which PostgREST
-- cannot express on a lead list and which no filter could then use. Kept on the
-- row instead, maintained by a trigger, so the chart, the lead filter and the
-- session builder all read the same number.
-- ============================================================================

alter table public.leads
  add column if not exists open_task_count integer not null default 0;

create index if not exists leads_open_tasks_idx
  on public.leads (workspace_id, open_task_count);

create or replace function public.recount_lead_open_tasks()
returns trigger
language plpgsql
set search_path = public
as $$
declare touched uuid[];
begin
  -- Both sides, because a task can move between leads or change status, and
  -- either way two rows may need recounting.
  touched := array_remove(array[new.lead_id, old.lead_id], null);
  if array_length(touched, 1) is null then return coalesce(new, old); end if;

  update public.leads l
     set open_task_count = (
       select count(*) from public.tasks t
       where t.lead_id = l.id and t.status = 'open'
     )
   where l.id = any (touched);

  return coalesce(new, old);
end;
$$;

drop trigger if exists tasks_recount_lead on public.tasks;
create trigger tasks_recount_lead
  after insert or delete or update of status, lead_id on public.tasks
  for each row execute function public.recount_lead_open_tasks();

update public.leads l
   set open_task_count = (
     select count(*) from public.tasks t
     where t.lead_id = l.id and t.status = 'open'
   );

-- ---------------------------------------------------------------------------
-- The waiting bucket splits: a lead with an open task is being worked, a lead
-- with none is the leak.
-- ---------------------------------------------------------------------------
drop function if exists public.workspace_pipeline_flow(uuid);

create or replace function public.workspace_pipeline_flow(ws uuid)
returns table (
  reached public.pipeline_stage,
  exited_as public.pipeline_stage,
  has_next_step boolean,
  exact boolean,
  leads bigint
)
language plpgsql
security invoker
stable
set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  with resolved as (
    select
      l.id,
      (
        select e.to_stage
        from public.lead_stage_events e
        where e.lead_id = l.id
          and e.to_stage not in ('demo_no_show', 'lost', 'not_a_fit')
        order by array_position(enum_range(null::public.pipeline_stage), e.to_stage) desc
        limit 1
      ) as reached,
      case
        when l.pipeline_stage in ('demo_no_show', 'lost', 'not_a_fit')
          then l.pipeline_stage
        else null::public.pipeline_stage
      end as exited_as,
      l.open_task_count > 0 as has_next_step,
      not exists (
        select 1 from public.lead_stage_events e
        where e.lead_id = l.id
          and e.source = 'backfill'
          and e.from_stage is null
          and e.to_stage <> 'new'
      ) as exact
    from public.leads l
    where l.workspace_id = ws
  )
  select
    coalesce(r.reached, 'new'::public.pipeline_stage),
    r.exited_as,
    r.has_next_step,
    r.exact,
    count(*)
  from resolved r
  group by 1, 2, 3, 4
  order by array_position(
    enum_range(null::public.pipeline_stage),
    coalesce(r.reached, 'new'::public.pipeline_stage)
  );
end;
$$;

revoke execute on function public.workspace_pipeline_flow(uuid) from public, anon;
grant  execute on function public.workspace_pipeline_flow(uuid) to authenticated, service_role;
