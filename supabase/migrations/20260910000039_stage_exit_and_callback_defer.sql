-- ============================================================================
-- Leaving a stage ends that stage's work, and a callback with no agreed time
-- is not a task.
--
-- Stage exits. Only lost and not_a_fit cancelled open work, so a cancelled demo
-- left "send the booking confirmation" and "put it on the calendar" open for a
-- demo that was not happening. Moving out of ANY stage now cancels that stage's
-- playbook tasks. Outcome playbooks are deliberately untouched by a stage move:
-- a callback promise does not lapse because the lead changed stage.
--
-- That needed the uniqueness rule to change first. tasks_one_per_step allowed
-- one task per playbook step EVER, so a cancelled task held its slot for good
-- and a rebook — the common case after a cancellation — could never recreate
-- the confirmation or its reminders. The real invariant is one OPEN task per
-- step. Finished and cancelled rows are history.
--
-- Callbacks. With no agreed time the playbook guessed the next morning, and a
-- callback at a guessed hour reads as a kept promise: three for three wrong in
-- the first week. A 'callback' step with no time now waits, like a 'scheduled'
-- step with no date. Setting the time creates the work; clearing it removes it.
-- ============================================================================

-- ── 1. At most one OPEN task per playbook step ────────────────────────────
alter table public.tasks drop constraint if exists tasks_one_per_step;
drop index if exists public.tasks_one_per_step;
create unique index if not exists tasks_one_open_per_step
  on public.tasks (lead_id, playbook_id, playbook_step_id)
  where status = 'open';

-- ── 2. A 'callback' step with no agreed time waits instead of guessing ────
create or replace function public.playbook_step_due(
  step jsonb, ws_tz text, scheduled timestamptz, callback timestamptz default null
)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select case coalesce(step ->> 'anchor', 'stage')
    when 'scheduled' then
      case
        when scheduled is null then null
        else greatest(
          ((date_trunc('day', timezone(ws_tz, scheduled))
              + ((step ->> 'offset_days')::int) * interval '1 day'
              + coalesce((step ->> 'due_time')::time, time '09:00')
            ) at time zone ws_tz),
          now())
      end
    when 'callback' then
      case
        when callback is null then null
        else greatest(callback + ((step ->> 'offset_days')::int) * interval '1 day', now())
      end
    else
      ((date_trunc('day', timezone(ws_tz, now()))
          + ((step ->> 'offset_days')::int) * interval '1 day'
          + coalesce((step ->> 'due_time')::time, time '09:00')
        ) at time zone ws_tz)
  end;
$$;

-- ── 3. Spawning uses the new arbiter ──────────────────────────────────────
create or replace function public.spawn_playbook_tasks(
  p_workspace uuid,
  p_lead uuid,
  p_scheduled_at timestamptz,
  p_playbook uuid,
  p_callback_at timestamptz default null
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
    select s as step,
           public.playbook_step_due(s, ws_tz, p_scheduled_at, p_callback_at) as due
    from public.playbooks p
    cross join lateral jsonb_array_elements(p.steps) as s
    where p.id = p_playbook
  ) candidates
  where due is not null
  on conflict (lead_id, playbook_id, playbook_step_id) where status = 'open' do nothing;
end;
$$;

-- ── 4. Leaving a stage cancels that stage's playbook work ─────────────────
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

  update public.tasks t
     set status = 'cancelled', closed_at = now(), closed_by = 'system',
         outcome_note = format('Cancelled automatically — lead left %s.', old.pipeline_stage)
    from public.playbooks p
   where t.lead_id = new.id
     and t.status = 'open'
     and t.playbook_id = p.id
     and p.trigger_stage = old.pipeline_stage;

  select p.id into pb from public.playbooks p
   where p.workspace_id = new.workspace_id
     and p.trigger_stage = new.pipeline_stage
     and p.is_active;

  if pb is not null then
    perform public.spawn_playbook_tasks(
      new.workspace_id, new.id, new.scheduled_at, pb, new.callback_at);
  end if;

  return new;
end;
$$;

-- ── 5. Moving a demo does not redo steps already finished this stint ─────
-- "This stint" is everything created since the lead last entered its stage. A
-- step finished before a cancellation belongs to the old booking and SHOULD be
-- recreated for the new one; a step finished before the date merely moved
-- should not.
create or replace function public.reanchor_scheduled_tasks()
returns trigger language plpgsql set search_path = public
as $$
declare ws_tz text;
begin
  if new.scheduled_at is not distinct from old.scheduled_at then
    return new;
  end if;

  if new.scheduled_at is null then
    update public.tasks t
       set status = 'cancelled', closed_at = now(), closed_by = 'system',
           outcome_note = 'Cancelled automatically — the appointment date was cleared.'
      from public.playbooks p
     where t.lead_id = new.id
       and t.status = 'open'
       and t.playbook_id = p.id
       and exists (
         select 1 from jsonb_array_elements(p.steps) s
         where s ->> 'id' = t.playbook_step_id
           and coalesce(s ->> 'anchor', 'stage') = 'scheduled'
       );
    return new;
  end if;

  select coalesce(w.timezone, 'UTC') into ws_tz
    from public.workspaces w where w.id = new.workspace_id;

  insert into public.tasks (
    workspace_id, lead_id, title, body_md, kind, due_at,
    playbook_id, playbook_step_id, source
  )
  select
    new.workspace_id, new.id,
    btrim(step ->> 'title'),
    nullif(btrim(coalesce(step ->> 'body_md', '')), ''),
    coalesce(step ->> 'kind', 'other'),
    due, playbook_id, step ->> 'id', 'playbook'
  from (
    select p.id as playbook_id, s as step,
           public.playbook_step_due(s, ws_tz, new.scheduled_at, new.callback_at) as due
    from public.playbooks p
    cross join lateral jsonb_array_elements(p.steps) as s
    where p.workspace_id  = new.workspace_id
      and p.trigger_stage = new.pipeline_stage
      and p.is_active
      and coalesce(s ->> 'anchor', 'stage') = 'scheduled'
  ) candidates
  where due is not null
    and not exists (
      select 1 from public.tasks t
      where t.lead_id = new.id
        and t.playbook_id = candidates.playbook_id
        and t.playbook_step_id = candidates.step ->> 'id'
        and t.status = 'done'
        and t.created_at >= new.stage_changed_at
    )
  on conflict (lead_id, playbook_id, playbook_step_id) where status = 'open'
    do update set due_at = excluded.due_at;

  return new;
end;
$$;

-- ── 6. Pending steps count only this stint's live work ────────────────────
create or replace function public.lead_pending_steps(lead_id uuid)
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::int
  from public.leads l
  join public.playbooks p
    on p.workspace_id = l.workspace_id
   and p.trigger_stage = l.pipeline_stage
   and p.is_active
  cross join lateral jsonb_array_elements(p.steps) as s
  where l.id = lead_pending_steps.lead_id
    and l.scheduled_at is null
    and coalesce(s ->> 'anchor', 'stage') = 'scheduled'
    and not exists (
      select 1 from public.tasks t
      where t.lead_id = l.id
        and t.playbook_id = p.id
        and t.playbook_step_id = s ->> 'id'
        and t.status <> 'cancelled'
        and t.created_at >= l.stage_changed_at
    );
$$;

-- ── 7. The agreed time creates, moves and removes callback work ───────────
create or replace function public.reanchor_callback_tasks()
returns trigger language plpgsql set search_path = public
as $$
declare ws_tz text;
begin
  if new.callback_at is not distinct from old.callback_at then return new; end if;

  if new.callback_at is null then
    update public.tasks t
       set status = 'cancelled', closed_at = now(), closed_by = 'system',
           outcome_note = 'Cancelled automatically — the agreed callback time was cleared.'
      from public.playbooks p
     where t.lead_id = new.id
       and t.status = 'open'
       and t.playbook_id = p.id
       and exists (
         select 1 from jsonb_array_elements(p.steps) s
         where s ->> 'id' = t.playbook_step_id
           and coalesce(s ->> 'anchor', 'stage') = 'callback'
       );
    return new;
  end if;

  select coalesce(w.timezone, 'UTC') into ws_tz
    from public.workspaces w where w.id = new.workspace_id;

  update public.tasks t
     set due_at = public.playbook_step_due(s.step, ws_tz, new.scheduled_at, new.callback_at)
    from public.playbooks p
    cross join lateral jsonb_array_elements(p.steps) as s(step)
   where t.playbook_id = p.id
     and t.playbook_step_id = s.step ->> 'id'
     and t.lead_id = new.id
     and t.status = 'open'
     and coalesce(s.step ->> 'anchor', 'stage') = 'callback';

  insert into public.tasks (
    workspace_id, lead_id, title, body_md, kind, due_at,
    playbook_id, playbook_step_id, source
  )
  select
    new.workspace_id, new.id,
    btrim(step ->> 'title'),
    nullif(btrim(coalesce(step ->> 'body_md', '')), ''),
    coalesce(step ->> 'kind', 'other'),
    due, playbook_id, step ->> 'id', 'playbook'
  from (
    select p.id as playbook_id, s as step,
           public.playbook_step_due(s, ws_tz, new.scheduled_at, new.callback_at) as due
    from public.playbooks p
    cross join lateral jsonb_array_elements(p.steps) as s
    where p.workspace_id = new.workspace_id
      and p.trigger_outcome = new.outcome
      and p.is_active
      and coalesce(s ->> 'anchor', 'stage') = 'callback'
  ) candidates
  where due is not null
  on conflict (lead_id, playbook_id, playbook_step_id) where status = 'open' do nothing;

  return new;
end;
$$;

-- ── 8. The callback playbook stops promising a fallback it no longer makes ─
update public.playbooks
   set steps = '[
     {"id":"call_back","title":"Call back as agreed","kind":"call","anchor":"callback","offset_days":0,
      "body_md":"Rings at the time they gave you. No agreed time means no task — set the Callback time on the lead and this appears."},
     {"id":"second_attempt","title":"Second attempt — ask for them by name","kind":"call","anchor":"callback","offset_days":3,
      "body_md":"No answer on the agreed callback. Try the alt number if there is one, and ask for them by name rather than opening cold — you have an agreement to refer to."},
     {"id":"last_try","title":"Last try, then park it or mark not a fit","kind":"call","anchor":"callback","offset_days":9,
      "body_md":"Third and final. If this one goes nowhere, decide rather than leaving it open: back to the cold list, or Not a fit."}
   ]'::jsonb
 where trigger_outcome = 'callback_requested';
