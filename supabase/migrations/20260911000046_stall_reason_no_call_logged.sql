-- ============================================================================
-- "Never actually dialled" was false. The reason is renamed to what it proves.
--
-- A worked lead with no call on its log was labelled as never dialled. All six
-- leads first filed there HAD been dialled — from a mobile on 3 Sep, before the
-- dialer was in use — and moved to Called in bulk on 6 Sep without their calls
-- being logged. One of them, tier A, had called back and left a voicemail, and
-- sat in a grey bucket whose name said nobody had ever rung it.
--
-- no_call_logged says only what the data shows: at Called, nothing on the log.
-- ============================================================================
create or replace function public.workspace_pipeline_flow(ws uuid)
returns table (
  reached public.pipeline_stage,
  exited_as public.pipeline_stage,
  has_next_step boolean,
  stall_reason text,
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
      case
        when l.pipeline_stage in ('new', 'demo_no_show', 'lost', 'not_a_fit')
          or l.open_task_count > 0 then null
        when l.outcome is not null then l.outcome::text
        when l.last_called_at is null then 'no_call_logged'
        else 'no_outcome'
      end as stall_reason,
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
    r.stall_reason,
    r.exact,
    count(*)
  from resolved r
  group by 1, 2, 3, 4, 5
  order by array_position(
    enum_range(null::public.pipeline_stage),
    coalesce(r.reached, 'new'::public.pipeline_stage)
  );
end;
$$;
