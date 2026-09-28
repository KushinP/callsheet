-- ============================================================================
-- Follow-ups that count backwards from the appointment.
--
-- offset_days only ever counted forward from the stage change, so a demo
-- booked ten days out got its "day before" reminder on day two. The T-1
-- confirm is the touch that prevents no-shows, and on Calendly's free tier
-- nothing else sends one — it was the single part of the demo sequence that
-- could not be expressed at all.
--
-- A step now names what it counts from:
--
--   anchor: "stage"      (default)  due = stage change + offset_days
--   anchor: "scheduled"             due = scheduled_at  + offset_days
--
-- and only a scheduled anchor may go negative, because "one day before the
-- stage change" is a date in the past that nothing can act on.
-- ============================================================================

alter table public.leads
  add column if not exists scheduled_at timestamptz;

comment on column public.leads.scheduled_at is
  'The next appointment with this lead — the demo, usually. Playbook steps '
  'anchored to "scheduled" count from this, so moving it moves the reminders.';

create index if not exists leads_scheduled_idx
  on public.leads (workspace_id, scheduled_at) where scheduled_at is not null;

-- ── One definition of when a step is due ────────────────────────────────────
-- Shared by the stage trigger and the re-anchor trigger. Two copies of this
-- arithmetic would disagree the first time either was touched, and the symptom
-- would be a reminder silently landing on the wrong day.
create or replace function public.playbook_step_due(
  step jsonb, ws_tz text, scheduled timestamptz
)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select case
    when coalesce(step ->> 'anchor', 'stage') = 'scheduled' then
      case
        -- No date yet: no due date can be computed, and inventing one is worse
        -- than waiting. The caller skips the step; the re-anchor trigger
        -- creates it the moment a date is set.
        when scheduled is null then null
        else greatest(
          ((date_trunc('day', timezone(ws_tz, scheduled))
              + ((step ->> 'offset_days')::int) * interval '1 day'
              + coalesce((step ->> 'due_time')::time, time '09:00')
            ) at time zone ws_tz),
          -- A demo booked for tomorrow makes T-1 today, and one booked for
          -- this afternoon makes it yesterday. Clamping means it shows up as
          -- due now rather than arriving already overdue.
          now())
      end
    else
      ((date_trunc('day', timezone(ws_tz, now()))
          + ((step ->> 'offset_days')::int) * interval '1 day'
          + coalesce((step ->> 'due_time')::time, time '09:00')
        ) at time zone ws_tz)
  end;
$$;

-- ── The validator learns the anchor ─────────────────────────────────────────
create or replace function public.validate_playbook_steps(steps jsonb)
returns text                          -- null when valid, else the first problem
language plpgsql immutable set search_path = public
as $$
declare ids text[]; s jsonb; n int; anchor text; off int;
begin
  if steps is null or jsonb_typeof(steps) <> 'array' then
    return 'steps must be a JSON array';
  end if;
  n := jsonb_array_length(steps);
  if n = 0 then return 'a playbook needs at least one step'; end if;
  if n > 8 then
    return format('a playbook cannot exceed 8 steps, got %s — split it across stages', n);
  end if;

  select array_agg(x ->> 'id') into ids from jsonb_array_elements(steps) x;
  if (select count(distinct i) from unnest(ids) i) <> array_length(ids, 1) then
    return 'step ids must be unique within a playbook';
  end if;

  for s in select * from jsonb_array_elements(steps) loop
    if coalesce(s ->> 'id', '') !~ '^[a-z0-9_]{1,40}$' then
      return format('step id "%s" must be lowercase alphanumeric or underscore, 1-40 chars',
                    s ->> 'id');
    end if;
    if length(btrim(coalesce(s ->> 'title', ''))) = 0 then
      return format('step "%s" has no title', s ->> 'id');
    end if;
    if length(s ->> 'title') > 120 then
      return format('step "%s" title exceeds 120 characters', s ->> 'id');
    end if;
    if coalesce(s ->> 'kind', '') not in ('email','call','research','prep','admin','other') then
      return format('step "%s" has an unknown kind "%s"', s ->> 'id', s ->> 'kind');
    end if;

    anchor := coalesce(s ->> 'anchor', 'stage');
    if anchor not in ('stage', 'scheduled') then
      return format('step "%s" anchor must be "stage" or "scheduled", got "%s"',
                    s ->> 'id', anchor);
    end if;

    if (s ->> 'offset_days') is null or (s ->> 'offset_days') !~ '^-?\d{1,2}$' then
      return format('step "%s" needs offset_days as a whole number of days', s ->> 'id');
    end if;
    off := (s ->> 'offset_days')::int;
    if anchor = 'stage' and off < 0 then
      return format(
        'step "%s" counts from the stage change, so offset_days cannot be negative — '
        'set anchor to "scheduled" to count back from the appointment',
        s ->> 'id');
    end if;
    if off > 90 or off < -30 then
      return format('step "%s" offset_days must be between -30 and 90, got %s',
                    s ->> 'id', off);
    end if;

    if (s ? 'due_time') and (s ->> 'due_time') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
      return format('step "%s" due_time must be HH:MM', s ->> 'id');
    end if;
    if length(coalesce(s ->> 'body_md', '')) > 2000 then
      return format('step "%s" body_md exceeds 2000 characters', s ->> 'id');
    end if;
  end loop;

  return null;
end;
$$;

-- ── The stage trigger skips what it cannot date yet ─────────────────────────
create or replace function public.apply_stage_playbook()
returns trigger language plpgsql set search_path = public
as $$
declare ws_tz text;
begin
  if new.pipeline_stage is not distinct from old.pipeline_stage then
    return new;
  end if;

  if new.pipeline_stage in ('lost', 'not_a_fit') then
    update public.tasks
       set status       = 'cancelled',
           closed_at    = now(),
           closed_by    = 'system',
           outcome_note = format('Cancelled automatically — lead moved to %s.',
                                 new.pipeline_stage)
     where lead_id = new.id and status = 'open';
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
    due,
    playbook_id,
    step ->> 'id',
    'playbook'
  from (
    select p.id as playbook_id, s as step,
           public.playbook_step_due(s, ws_tz, new.scheduled_at) as due
    from public.playbooks p
    cross join lateral jsonb_array_elements(p.steps) as s
    where p.workspace_id  = new.workspace_id
      and p.trigger_stage = new.pipeline_stage
      and p.is_active
  ) candidates
  -- A scheduled-anchored step with no date yet is not dropped, only deferred:
  -- setting scheduled_at fires the trigger below, which creates it then.
  where due is not null
  on conflict (lead_id, playbook_id, playbook_step_id) do nothing;

  return new;
end;
$$;

-- ── Moving the appointment moves the reminders ──────────────────────────────
create or replace function public.reanchor_scheduled_tasks()
returns trigger language plpgsql set search_path = public
as $$
declare ws_tz text;
begin
  if new.scheduled_at is not distinct from old.scheduled_at then
    return new;
  end if;

  -- The appointment was cleared. An open reminder counting back from a date
  -- that no longer exists is worse than no reminder, so it is cancelled with
  -- the reason rather than left pointing at nothing.
  if new.scheduled_at is null then
    update public.tasks t
       set status       = 'cancelled',
           closed_at    = now(),
           closed_by    = 'system',
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
    due,
    playbook_id,
    step ->> 'id',
    'playbook'
  from (
    select p.id as playbook_id, s as step,
           public.playbook_step_due(s, ws_tz, new.scheduled_at) as due
    from public.playbooks p
    cross join lateral jsonb_array_elements(p.steps) as s
    where p.workspace_id  = new.workspace_id
      and p.trigger_stage = new.pipeline_stage
      and p.is_active
      and coalesce(s ->> 'anchor', 'stage') = 'scheduled'
  ) candidates
  where due is not null
  -- Rescheduling moves an OPEN reminder. One already done or cancelled stays
  -- closed: re-opening finished work because a date moved is how a task list
  -- stops being believed.
  on conflict (lead_id, playbook_id, playbook_step_id) do update
    set due_at = excluded.due_at
    where public.tasks.status = 'open';

  return new;
end;
$$;

drop trigger if exists leads_reanchor_scheduled on public.leads;
create trigger leads_reanchor_scheduled
  after update of scheduled_at on public.leads
  for each row when (new.scheduled_at is distinct from old.scheduled_at)
  execute function public.reanchor_scheduled_tasks();

revoke execute on function public.reanchor_scheduled_tasks() from public, anon, authenticated;
revoke execute on function public.playbook_step_due(jsonb, text, timestamptz) from public, anon;
grant  execute on function public.playbook_step_due(jsonb, text, timestamptz)
  to authenticated, service_role;
