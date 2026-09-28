-- ============================================================================
-- Stage history.
--
-- The flow chart could not say where a lost lead died, because nothing recorded
-- it: leads.pipeline_stage is a current value and stage_changed_at is when it
-- last moved, so a deal that reached a demo and then died was indistinguishable
-- from one that died on the first dial. The chart placed those by evidence on
-- the row and said so. This replaces the inference with the fact.
--
-- Append-only by design. A stage change is something that happened; editing or
-- deleting one would make the history agree with the present, which is the one
-- thing history must never be able to do.
-- ============================================================================

create table if not exists public.lead_stage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces on delete cascade,
  lead_id uuid not null references public.leads on delete cascade,
  -- null means the lead entered the pipeline here rather than moved.
  from_stage public.pipeline_stage,
  to_stage public.pipeline_stage not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users on delete set null,
  -- 'live' was observed as it happened. 'backfill' was reconstructed from
  -- evidence that predates this table, and is the only kind that can be
  -- incomplete. Keeping the distinction in the data is what lets the chart say
  -- how much of itself is measured rather than inferred.
  source text not null default 'live' check (source in ('live', 'backfill'))
);

create index if not exists lead_stage_events_lead_idx
  on public.lead_stage_events (lead_id, changed_at);
create index if not exists lead_stage_events_ws_idx
  on public.lead_stage_events (workspace_id, changed_at desc);

alter table public.lead_stage_events enable row level security;

-- Readable by the workspace, writable by nobody: every row comes from the
-- trigger below, so there is no path by which a person can write their own
-- version of what happened.
drop policy if exists "stage events readable by members" on public.lead_stage_events;
create policy "stage events readable by members" on public.lead_stage_events
  for select using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
create or replace function public.record_stage_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.lead_stage_events
      (workspace_id, lead_id, from_stage, to_stage, changed_at, changed_by)
    values
      (new.workspace_id, new.id, null, new.pipeline_stage,
       coalesce(new.created_at, clock_timestamp()), auth.uid());
    return null;
  end if;

  -- `update of pipeline_stage` fires when the column is MENTIONED, not only
  -- when it changes, and the app writes whole rows — so without this every
  -- lead edit would log a stage change that never happened.
  if new.pipeline_stage is distinct from old.pipeline_stage then
    insert into public.lead_stage_events
      (workspace_id, lead_id, from_stage, to_stage, changed_at, changed_by)
    values
      (new.workspace_id, new.id, old.pipeline_stage, new.pipeline_stage,
       -- clock_timestamp(), not now(): now() is transaction time, so two moves
       -- in one transaction would land on the same instant and the log would
       -- lose their order.
       clock_timestamp(), auth.uid());
  end if;

  return null;
end;
$$;

drop trigger if exists leads_record_stage_event on public.leads;
create trigger leads_record_stage_event
  after insert or update of pipeline_stage on public.leads
  for each row execute function public.record_stage_event();

-- ---------------------------------------------------------------------------
-- Backfill: everything the existing rows can actually prove, and nothing more.
--
-- Three kinds of evidence, in descending confidence:
--   1. every lead entered at 'new' when it was created — true by construction;
--   2. an outbound call proves it reached 'called', and the call log has the
--      timestamp;
--   3. a scheduled_at, or sitting in demo_no_show, proves a demo was booked.
-- Its current stage is then recorded with a null from_stage, which is the
-- honest statement "it ended up here and this table cannot say how".
-- ---------------------------------------------------------------------------
insert into public.lead_stage_events
  (workspace_id, lead_id, from_stage, to_stage, changed_at, source)
select l.workspace_id, l.id, null, 'new'::public.pipeline_stage, l.created_at, 'backfill'
from public.leads l
where not exists (
  select 1 from public.lead_stage_events e where e.lead_id = l.id
);

insert into public.lead_stage_events
  (workspace_id, lead_id, from_stage, to_stage, changed_at, source)
select l.workspace_id, l.id, 'new'::public.pipeline_stage,
       'called'::public.pipeline_stage, f.first_call, 'backfill'
from public.leads l
join lateral (
  select min(c.called_at) as first_call
  from public.dial_call_logs c
  where c.lead_id = l.id and c.direction = 'outbound'
) f on f.first_call is not null
where not exists (
  select 1 from public.lead_stage_events e
  where e.lead_id = l.id and e.to_stage = 'called'
);

insert into public.lead_stage_events
  (workspace_id, lead_id, from_stage, to_stage, changed_at, source)
select l.workspace_id, l.id, null, 'demo_booked'::public.pipeline_stage,
       coalesce(l.scheduled_at, l.stage_changed_at), 'backfill'
from public.leads l
where (l.scheduled_at is not null or l.pipeline_stage = 'demo_no_show')
  and not exists (
    select 1 from public.lead_stage_events e
    where e.lead_id = l.id and e.to_stage = 'demo_booked'
  );

insert into public.lead_stage_events
  (workspace_id, lead_id, from_stage, to_stage, changed_at, source)
select l.workspace_id, l.id, null, l.pipeline_stage, l.stage_changed_at, 'backfill'
from public.leads l
where l.pipeline_stage <> 'new'
  and not exists (
    select 1 from public.lead_stage_events e
    where e.lead_id = l.id and e.to_stage = l.pipeline_stage
  );

revoke insert, update, delete on public.lead_stage_events from authenticated, anon;
grant select on public.lead_stage_events to authenticated;

-- ---------------------------------------------------------------------------
-- The flow, now read from what happened rather than inferred from what remains.
--
-- `reached` is the furthest FORWARD stage the lead has ever been recorded in —
-- exact for anything that moved since this table existed, including a lost deal
-- that got as far as a completed demo, which the previous version could not see
-- at all.
--
-- `exact` marks whether that path was observed or reconstructed. The only
-- uncertain rows are backfilled ones with no from_stage: "it ended up here and
-- we cannot say how". Everything else — created at new, first dial, booked
-- demo — is evidence, not a guess.
-- ---------------------------------------------------------------------------
drop function if exists public.workspace_pipeline_flow(uuid);

create or replace function public.workspace_pipeline_flow(ws uuid)
returns table (
  reached public.pipeline_stage,
  exited_as public.pipeline_stage,
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
      -- Ordered by enum position among the forward stages only. demo_no_show
      -- sits between demo_booked and demo_completed in the enum so that the
      -- funnel reads in order, which means it has to be excluded here by name
      -- rather than by position.
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
    r.exact,
    count(*)
  from resolved r
  group by 1, 2, 3
  order by array_position(
    enum_range(null::public.pipeline_stage),
    coalesce(r.reached, 'new'::public.pipeline_stage)
  );
end;
$$;

revoke execute on function public.workspace_pipeline_flow(uuid) from public, anon;
grant  execute on function public.workspace_pipeline_flow(uuid) to authenticated, service_role;
