-- ============================================================================
-- Playbooks that fire on a call outcome, not only on a stage.
--
-- "Callback requested" is a promise to a person, and it created nothing: there
-- is no stage for it, so no playbook could trigger on it, so a lead with an
-- agreement to ring back sat in the pipeline with no task saying so. Same for a
-- voicemail left and a gatekeeper reached — real next steps with nowhere to
-- live. Every one of those leads showed as "No next step yet" on the flow
-- chart, which was accurate and not much help.
--
-- A stage is something you decide about a lead. An outcome is something that
-- happened to you on a call. Both leave work behind, so a playbook now hangs
-- off exactly one of them.
-- ============================================================================

alter table public.playbooks alter column trigger_stage drop not null;
alter table public.playbooks add column if not exists trigger_outcome public.call_outcome;

alter table public.playbooks drop constraint if exists playbooks_one_trigger;
alter table public.playbooks add constraint playbooks_one_trigger
  check (num_nonnulls(trigger_stage, trigger_outcome) = 1);

-- Terminal outcomes close a lead. They do not open work, for the same reason
-- lost and not_a_fit do not.
alter table public.playbooks drop constraint if exists playbooks_outcome_not_terminal;
alter table public.playbooks add constraint playbooks_outcome_not_terminal
  check (trigger_outcome is null or trigger_outcome not in ('do_not_call', 'bad_number'));

drop index if exists playbooks_one_active_per_stage_idx;
create unique index playbooks_one_active_per_stage_idx
  on public.playbooks (workspace_id, trigger_stage)
  where is_active and trigger_stage is not null;
create unique index playbooks_one_active_per_outcome_idx
  on public.playbooks (workspace_id, trigger_outcome)
  where is_active and trigger_outcome is not null;

-- ---------------------------------------------------------------------------
-- The step-to-task expansion, once.
--
-- It was inline in apply_stage_playbook, and the outcome trigger would have
-- made it the second copy of the timezone handling, the anchor handling and the
-- conflict rule. The anchor work already warned that two copies of this drift.
-- ---------------------------------------------------------------------------
create or replace function public.spawn_playbook_tasks(
  p_workspace uuid, p_lead uuid, p_scheduled_at timestamptz, p_playbook uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare ws_tz text;
begin
  select coalesce(w.timezone, 'UTC') into ws_tz
    from public.workspaces w where w.id = p_workspace;

  insert into public.tasks (
    workspace_id, lead_id, title, body_md, kind, due_at,
    playbook_id, playbook_step_id, source
  )
  select
    p_workspace, p_lead,
    btrim(step ->> 'title'),
    nullif(btrim(coalesce(step ->> 'body_md', '')), ''),
    coalesce(step ->> 'kind', 'other'),
    due, p_playbook, step ->> 'id', 'playbook'
  from (
    select s as step, public.playbook_step_due(s, ws_tz, p_scheduled_at) as due
    from public.playbooks p
    cross join lateral jsonb_array_elements(p.steps) as s
    where p.id = p_playbook
  ) candidates
  -- A scheduled-anchored step with no date yet is deferred, not dropped: the
  -- re-anchor trigger creates it when the date arrives.
  where due is not null
  on conflict (lead_id, playbook_id, playbook_step_id) do nothing;
end;
$$;

create or replace function public.apply_stage_playbook()
returns trigger language plpgsql set search_path = public
as $$
declare pb uuid;
begin
  if new.pipeline_stage is not distinct from old.pipeline_stage then
    return new;
  end if;

  if new.pipeline_stage in ('lost', 'not_a_fit') then
    update public.tasks
       set status = 'cancelled', closed_at = now(), closed_by = 'system',
           outcome_note = format('Cancelled automatically — lead moved to %s.',
                                 new.pipeline_stage)
     where lead_id = new.id and status = 'open';
    return new;
  end if;

  select p.id into pb from public.playbooks p
   where p.workspace_id = new.workspace_id
     and p.trigger_stage = new.pipeline_stage
     and p.is_active;

  if pb is not null then
    perform public.spawn_playbook_tasks(new.workspace_id, new.id, new.scheduled_at, pb);
  end if;

  return new;
end;
$$;

create or replace function public.apply_outcome_playbook()
returns trigger language plpgsql set search_path = public
as $$
declare pb uuid;
begin
  -- Same belt and braces as the stage trigger: supabase-js sends every column,
  -- so "outcome listed but unchanged" is the common case.
  if new.outcome is null or new.outcome is not distinct from old.outcome then
    return new;
  end if;

  select p.id into pb from public.playbooks p
   where p.workspace_id = new.workspace_id
     and p.trigger_outcome = new.outcome
     and p.is_active;

  if pb is not null then
    perform public.spawn_playbook_tasks(new.workspace_id, new.id, new.scheduled_at, pb);
  end if;

  return new;
end;
$$;

drop trigger if exists leads_apply_outcome_playbook on public.leads;
create trigger leads_apply_outcome_playbook
  after update of outcome on public.leads
  for each row when (new.outcome is distinct from old.outcome)
  execute function public.apply_outcome_playbook();

-- ---------------------------------------------------------------------------
-- Activating a playbook deactivates its rivals — the ones sharing its trigger,
-- which is now either a stage or an outcome. Reading only trigger_stage meant
-- an outcome playbook matched nothing, so activating a second one left both on
-- and tripped the unique index instead of swapping them.
-- ---------------------------------------------------------------------------
create or replace function public.activate_playbook(ws uuid, playbook uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_stage   public.pipeline_stage;
  target_outcome public.call_outcome;
begin
  select p.trigger_stage, p.trigger_outcome
    into target_stage, target_outcome
    from public.playbooks p
   where p.id = playbook and p.workspace_id = ws;

  if not found then
    raise exception 'playbook % not found in workspace %', playbook, ws;
  end if;

  update public.playbooks
     set is_active = (id = playbook)
   where workspace_id = ws
     and (
       (target_stage is not null and trigger_stage = target_stage)
       or (target_outcome is not null and trigger_outcome = target_outcome)
     );
end;
$$;

revoke execute on function public.activate_playbook(uuid, uuid) from public, anon;
grant  execute on function public.activate_playbook(uuid, uuid) to authenticated, service_role;
