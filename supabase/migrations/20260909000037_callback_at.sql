-- ============================================================================
-- A callback happens at a time they gave you.
--
-- The callback playbook guessed "next morning at 9:30" and left a note telling
-- you to move the task yourself — which is the app asking you to remember the
-- thing it exists to remember. Prospects say "Tuesday at nine"; that is the
-- due date, and nothing was carrying it.
--
-- Deliberately NOT leads.scheduled_at. That means the demo, it anchors the demo
-- reminders, and overloading it would put a callback in the demo playbook's
-- reminders and vice versa.
-- ============================================================================
alter table public.leads
  add column if not exists callback_at timestamptz;

comment on column public.leads.callback_at is
  'When they asked to be rung back. Steps anchored to "callback" land here.';

-- ── A third anchor ─────────────────────────────────────────────────────────
-- 'stage'     due = now + offset          (default)
-- 'scheduled' due = the demo date + offset, at the step's own time of day
-- 'callback'  due = the exact instant they gave, + offset
--
-- 'callback' keeps the time of day, which is the whole point: a step anchored
-- to "Tuesday at nine" that lands at 09:00 because the arithmetic truncated to
-- the day is a step that missed by an hour. Falls back to the stage
-- calculation when no time was captured, so a callback with no agreed time
-- still gets tomorrow morning rather than nothing at all.
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
        when callback is not null then
          greatest(callback + ((step ->> 'offset_days')::int) * interval '1 day', now())
        else
          ((date_trunc('day', timezone(ws_tz, now()))
              + ((step ->> 'offset_days')::int) * interval '1 day'
              + coalesce((step ->> 'due_time')::time, time '09:00')
            ) at time zone ws_tz)
      end
    else
      ((date_trunc('day', timezone(ws_tz, now()))
          + ((step ->> 'offset_days')::int) * interval '1 day'
          + coalesce((step ->> 'due_time')::time, time '09:00')
        ) at time zone ws_tz)
  end;
$$;

-- The validator learns it too, or a playbook using it fails the CHECK.
create or replace function public.validate_playbook_steps(steps jsonb)
returns text
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
    if anchor not in ('stage', 'scheduled', 'callback') then
      return format('step "%s" anchor must be "stage", "scheduled" or "callback", got "%s"',
                    s ->> 'id', anchor);
    end if;

    if (s ->> 'offset_days') is null or (s ->> 'offset_days') !~ '^-?\d{1,2}$' then
      return format('step "%s" needs offset_days as a whole number of days', s ->> 'id');
    end if;
    off := (s ->> 'offset_days')::int;
    if abs(off) > 90 then
      return format('step "%s" offset_days must be within 90 days', s ->> 'id');
    end if;
    -- Only a scheduled anchor may count backwards: "one day before the demo"
    -- is a real instruction, "one day before now" is not.
    if anchor <> 'scheduled' and off < 0 then
      return format(
        'step "%s" offset_days cannot be negative unless anchored to "scheduled"',
        s ->> 'id');
    end if;
    if (s ? 'due_time') and (s ->> 'due_time') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
      return format('step "%s" due_time must be HH:MM', s ->> 'id');
    end if;
  end loop;

  return null;
end;
$$;

-- ── Pass the callback time through ─────────────────────────────────────────
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
  on conflict (lead_id, playbook_id, playbook_step_id) do nothing;
end;
$$;

create or replace function public.apply_outcome_playbook()
returns trigger language plpgsql set search_path = public
as $$
declare pb uuid;
begin
  if new.outcome is null or new.outcome is not distinct from old.outcome then
    return new;
  end if;

  select p.id into pb from public.playbooks p
   where p.workspace_id = new.workspace_id
     and p.trigger_outcome = new.outcome
     and p.is_active;

  if pb is not null then
    perform public.spawn_playbook_tasks(
      new.workspace_id, new.id, new.scheduled_at, pb, new.callback_at);
  end if;

  return new;
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
    perform public.spawn_playbook_tasks(
      new.workspace_id, new.id, new.scheduled_at, pb, new.callback_at);
  end if;

  return new;
end;
$$;

-- ── Moving the callback moves its task ─────────────────────────────────────
-- Same contract as the demo re-anchor: changing the time you agreed changes
-- when you are told about it, rather than leaving the old one to fire.
create or replace function public.reanchor_callback_tasks()
returns trigger language plpgsql set search_path = public
as $$
declare ws_tz text;
begin
  if new.callback_at is not distinct from old.callback_at then return new; end if;

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
     and coalesce(s.step ->> 'anchor', 'stage') = 'callback'
     and public.playbook_step_due(s.step, ws_tz, new.scheduled_at, new.callback_at) is not null;

  return new;
end;
$$;

drop trigger if exists leads_reanchor_callback on public.leads;
create trigger leads_reanchor_callback
  after update of callback_at on public.leads
  for each row when (new.callback_at is distinct from old.callback_at)
  execute function public.reanchor_callback_tasks();

-- ── The callback playbook now lands on the time they gave ──────────────────
update public.playbooks
   set steps = '[
     {"id":"call_back","title":"Call back as agreed","kind":"call","anchor":"callback","offset_days":0,
      "due_time":"09:30",
      "body_md":"Rings at the time they gave you. If no time was captured this falls back to the next morning."},
     {"id":"second_attempt","title":"Second attempt — ask for them by name","kind":"call","anchor":"callback","offset_days":3,
      "due_time":"10:00",
      "body_md":"No answer on the agreed callback. Try the alt number if there is one, and ask for them by name rather than opening cold — you have an agreement to refer to."},
     {"id":"last_try","title":"Last try, then park it or mark not a fit","kind":"call","anchor":"callback","offset_days":9,
      "due_time":"10:00",
      "body_md":"Third and final. If this one goes nowhere, decide rather than leaving it open: back to the cold list, or Not a fit."}
   ]'::jsonb
 where trigger_outcome = 'callback_requested';
