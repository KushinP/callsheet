-- ============================================================================
-- Sales pipeline.
--
-- Deliberately NOT `leads.status`. Three triggers already write that column,
-- and one is fatal to the idea: touch_lead_on_call fires after every logged
-- call and forces 'in_progress', so a lead moved to Demo would be stomped back
-- the moment it was called — which is exactly when it would have been moved.
-- The two also mean different things: status is "have we worked this row",
-- stage is "where is this deal". A lead can be worked and paying at once.
-- ============================================================================

create type public.pipeline_stage as enum
  ('new', 'called', 'demo', 'pilot', 'paying', 'lost', 'not_a_fit');

alter table public.leads
  add column if not exists pipeline_stage public.pipeline_stage not null default 'new',
  add column if not exists stage_changed_at timestamptz not null default now();

create index if not exists leads_workspace_stage_idx
  on public.leads (workspace_id, pipeline_stage);

-- Time-in-stage is the number that tells you a deal has gone quiet, so it has
-- to be maintained by the database rather than by whoever remembers to set it.
create or replace function public.touch_stage_changed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.pipeline_stage is distinct from old.pipeline_stage then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists leads_touch_stage on public.leads;
create trigger leads_touch_stage
  before update of pipeline_stage on public.leads
  for each row execute function public.touch_stage_changed();

-- Auto-advance lives INSIDE the existing trigger rather than beside it: one
-- write, no ordering question between two triggers touching the same row.
-- It only ever moves 'new' → 'called', so a human or Claude moving a lead
-- further along is never walked back by dialling it again.
create or replace function public.touch_lead_on_call()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.lead_id is not null then
    update public.leads
       set last_called_at = new.called_at,
           call_count = call_count + 1,
           status = case when status = 'new' then 'in_progress' else status end,
           pipeline_stage = case
             when pipeline_stage = 'new' then 'called'::public.pipeline_stage
             else pipeline_stage
           end,
           stage_changed_at = case
             when pipeline_stage = 'new' then now() else stage_changed_at
           end
     where id = new.lead_id;
  end if;
  return new;
end;
$$;

-- ── The funnel ──────────────────────────────────────────────────────────────
-- Counts every stage, including the ones with nobody in them, so the shape of
-- the funnel does not change as stages empty and refill.
create or replace function public.workspace_funnel(ws uuid)
returns table (stage public.pipeline_stage, leads bigint, oldest_days integer)
language plpgsql security invoker stable set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select
    s.stage,
    count(l.id),
    -- How long the most stagnant lead has sat here. A stage with a big number
    -- is where deals go to die, which a bare count cannot show.
    coalesce(max(extract(day from now() - l.stage_changed_at))::integer, 0)
  from unnest(enum_range(null::public.pipeline_stage)) as s(stage)
  left join public.leads l
    on l.workspace_id = ws and l.pipeline_stage = s.stage
  group by s.stage
  order by array_position(enum_range(null::public.pipeline_stage), s.stage);
end;
$$;

revoke execute on function public.workspace_funnel(uuid) from public, anon;
grant  execute on function public.workspace_funnel(uuid) to authenticated, service_role;
