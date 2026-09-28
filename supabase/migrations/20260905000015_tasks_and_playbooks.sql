-- ============================================================================
-- Tasks, and the playbooks that create them.
--
-- Deliberately NOT a workflow engine. A workflow engine running unattended
-- needs a scheduler, retries, idempotency and somewhere to surface failures. A
-- playbook is one level down: a named list of task templates with relative due
-- dates that fires when a lead enters a stage. A trigger creates the tasks, and
-- the "engine" is whoever reads the list.
--
-- Neither table belongs in `documents`: that has one row per lead per kind, a
-- required body, and no due_at, status or completed_at to index. A task is a
-- work queue row, not a document.
-- ============================================================================

create type public.task_status as enum ('open', 'done', 'cancelled');

create or replace function public.validate_playbook_steps(steps jsonb)
returns text                          -- null when valid, else the first problem
language plpgsql immutable set search_path = public
as $$
declare ids text[]; s jsonb; n int;
begin
  if steps is null or jsonb_typeof(steps) <> 'array' then
    return 'steps must be a JSON array';
  end if;
  n := jsonb_array_length(steps);
  if n = 0 then return 'a playbook needs at least one step'; end if;
  -- The spam ceiling, and the answer to "what stops Claude writing forty tasks".
  -- Eight is more follow-up than any single stage change justifies.
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
    if (s ->> 'offset_days') is null
       or (s ->> 'offset_days') !~ '^\d{1,2}$'
       or (s ->> 'offset_days')::int > 90 then
      return format('step "%s" needs offset_days as a whole number of days, 0-90', s ->> 'id');
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

create table public.playbooks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces on delete cascade,
  name          text not null,
  description   text,
  trigger_stage public.pipeline_stage not null,
  -- [{ id, title, kind, offset_days, due_time?, body_md? }]
  steps         jsonb not null default '[]'::jsonb,
  is_active     boolean not null default true,
  created_by    uuid references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint playbooks_name_nonempty check (length(btrim(name)) > 0),
  constraint playbooks_steps_valid   check (public.validate_playbook_steps(steps) is null),
  -- Terminal stages cancel work; they do not create it.
  constraint playbooks_stage_not_terminal
    check (trigger_stage not in ('lost', 'not_a_fit'))
);

-- One ACTIVE playbook per stage: two both firing on Demo is how you get
-- duplicate work nobody ordered. Neither index is ever an upsert arbiter —
-- put_playbook resolves the target id itself, exactly as put_script does — so
-- the bare-ON CONFLICT rule does not apply to them.
create unique index playbooks_one_active_per_stage_idx
  on public.playbooks (workspace_id, trigger_stage) where is_active;
create unique index playbooks_workspace_name_idx
  on public.playbooks (workspace_id, lower(name));

create trigger playbooks_touch before update on public.playbooks
  for each row execute function public.touch_updated_at();

create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces on delete cascade,
  -- Nullable: a task can be about the workspace rather than one lead.
  lead_id       uuid,

  title         text not null,
  body_md       text,
  kind          text not null default 'other'
                  check (kind in ('email','call','research','prep','admin','other')),
  status        public.task_status not null default 'open',
  due_at        timestamptz not null,

  playbook_id      uuid references public.playbooks on delete set null,
  playbook_step_id text,
  source        text not null default 'playbook'
                  check (source in ('playbook', 'human', 'claude')),
  created_by    uuid references auth.users on delete set null,

  -- What happened. result_json is the audit trail: for an email Claude sent
  -- through its own connector this holds the message id, so the rep can open the
  -- actual email rather than trusting a one-line summary.
  closed_at     timestamptz,
  closed_by     text check (closed_by in ('human', 'claude', 'system')),
  outcome_note  text,
  result_json   jsonb not null default '{}'::jsonb,
  snooze_count  integer not null default 0,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- The composite FK from documents: the database refuses a task whose lead
  -- lives in another workspace rather than trusting every writer.
  foreign key (workspace_id, lead_id)
    references public.leads (workspace_id, id) on delete cascade,

  constraint tasks_title_nonempty  check (length(btrim(title)) > 0),
  constraint tasks_title_bounded   check (length(title) <= 120),
  constraint tasks_body_bounded    check (body_md is null or length(body_md) <= 4000),
  constraint tasks_closed_has_time check ((status = 'open') = (closed_at is null)),

  -- Re-entering a stage must not duplicate work already planned. A REAL unique
  -- constraint so the trigger's bare ON CONFLICT has an arbiter; NULLs being
  -- distinct is what scopes it, so ad-hoc human and Claude tasks never collide.
  constraint tasks_one_per_step unique (lead_id, playbook_id, playbook_step_id)
);

create index tasks_queue_idx    on public.tasks (workspace_id, status, due_at);
create index tasks_lead_idx     on public.tasks (lead_id, status);
create index tasks_open_due_idx on public.tasks (workspace_id, due_at) where status = 'open';

create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

-- ── The playbook trigger ────────────────────────────────────────────────────
-- SECURITY INVOKER (the default), deliberately: the caller is already a member
-- who could insert these rows by hand, so running as them means RLS applies to
-- the insert too and a stage change can never plant tasks in a workspace the
-- caller cannot see.
create or replace function public.apply_stage_playbook()
returns trigger language plpgsql set search_path = public
as $$
declare ws_tz text;
begin
  -- Belt and braces with the trigger's WHEN clause. supabase-js sends every
  -- column on an update, so "stage listed but unchanged" is the common case.
  if new.pipeline_stage is not distinct from old.pipeline_stage then
    return new;
  end if;

  -- Leaving the pipeline. Outstanding work is cancelled with a reason — not
  -- deleted, so the record of what was planned survives, and not left open,
  -- which is the failure mode that kills task systems: tomorrow's list full of
  -- work on leads that are dead.
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
    new.workspace_id,
    new.id,
    btrim(s ->> 'title'),
    nullif(btrim(coalesce(s ->> 'body_md', '')), ''),
    coalesce(s ->> 'kind', 'other'),
    -- "+3d at 09:00" against the workspace's own clock. Truncating to the local
    -- day first is what makes it land at 9am rather than at whatever o'clock the
    -- stage happened to change.
    ((date_trunc('day', timezone(ws_tz, now()))
        + ((s ->> 'offset_days')::int) * interval '1 day'
        + coalesce((s ->> 'due_time')::time, time '09:00')
      ) at time zone ws_tz),
    p.id,
    s ->> 'id',
    'playbook'
  from public.playbooks p
  cross join lateral jsonb_array_elements(p.steps) as s
  where p.workspace_id  = new.workspace_id
    and p.trigger_stage = new.pipeline_stage
    and p.is_active
  -- Re-entry is a silent no-op rather than an error. A task cancelled when the
  -- lead was lost keeps its slot: re-entering Demo must not resurrect a
  -- follow-up whose due date is three weeks in the past.
  on conflict (lead_id, playbook_id, playbook_step_id) do nothing;

  return new;
end;
$$;

-- Both guards are needed and neither is sufficient. `OF pipeline_stage` skips
-- the trigger entirely for a notes edit or a DNC toggle; the WHEN clause catches
-- the case that happens all day — a full-row update that names the column
-- without changing it.
drop trigger if exists leads_apply_playbook on public.leads;
create trigger leads_apply_playbook
  after update of pipeline_stage on public.leads
  for each row when (new.pipeline_stage is distinct from old.pipeline_stage)
  execute function public.apply_stage_playbook();

-- Deactivate the old and activate the new in one statement: the partial unique
-- index means doing it in two transiently violates.
create or replace function public.activate_playbook(ws uuid, playbook uuid)
returns void language plpgsql security invoker set search_path = public
as $$
declare target_stage public.pipeline_stage;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  select trigger_stage into target_stage
    from public.playbooks where id = playbook and workspace_id = ws;
  if target_stage is null then
    raise exception 'playbook % is not in workspace %', playbook, ws using errcode = '42501';
  end if;

  update public.playbooks
     set is_active = (id = playbook)
   where workspace_id = ws and trigger_stage = target_stage;
end;
$$;

alter table public.tasks     enable row level security;
alter table public.playbooks enable row level security;

create policy "tasks readable by members" on public.tasks
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "tasks insertable by members" on public.tasks
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "tasks updatable by members" on public.tasks
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy "tasks deletable by members" on public.tasks
  for delete to authenticated using (public.is_workspace_member(workspace_id));

create policy "playbooks readable by members" on public.playbooks
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "playbooks insertable by members" on public.playbooks
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "playbooks updatable by members" on public.playbooks
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy "playbooks deletable by members" on public.playbooks
  for delete to authenticated using (public.is_workspace_member(workspace_id));

revoke execute on function public.apply_stage_playbook() from public, anon, authenticated;
revoke execute on function public.validate_playbook_steps(jsonb) from public, anon;
revoke execute on function public.activate_playbook(uuid, uuid) from public, anon;
grant  execute on function public.validate_playbook_steps(jsonb) to authenticated, service_role;
grant  execute on function public.activate_playbook(uuid, uuid) to authenticated, service_role;
