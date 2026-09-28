-- ============================================================================
-- Callsheet — initial schema
--
-- Every workspace-scoped table carries workspace_id and is covered by a Row
-- Level Security policy, so the database itself keeps two workspaces apart.
-- ============================================================================

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Enums. All values are snake_case; the UI maps them to human labels.
-- ---------------------------------------------------------------------------
create type public.workspace_role as enum ('owner', 'admin', 'agent');

create type public.lead_status as enum ('new', 'in_progress', 'completed', 'disqualified');

create type public.call_outcome as enum (
  'connected_dm',
  'connected_gk',
  'connected_other',
  'voicemail',
  'busy',
  'no_answer',
  'bad_number',
  'not_interested',
  'do_not_call',
  'callback_requested',
  'appointment_set',
  'dialed'
);

create type public.session_status as enum ('pending', 'active', 'paused', 'completed');

create type public.session_lead_status as enum ('queued', 'dialing', 'done', 'skipped');

create type public.call_status as enum (
  'initiated', 'ringing', 'in_progress', 'completed',
  'busy', 'failed', 'no_answer', 'canceled'
);

-- ---------------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role public.workspace_role not null default 'agent',
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

-- Membership checks run inside RLS policies on workspace_members itself, so
-- they must be SECURITY DEFINER to avoid recursive policy evaluation.
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_admin(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces on delete cascade,
  business_name text not null,
  phone text not null,
  -- Digits-only form. Dedup and Twilio dialing both key off this, never off
  -- the raw imported string.
  phone_normalized text not null,
  address text,
  city text,
  state text,
  zip text,
  website text,
  email text,
  notes text,
  status public.lead_status not null default 'new',
  outcome public.call_outcome,
  -- Hard compliance flag. Separate from `outcome` because an outcome is the
  -- result of one call, while this is a standing instruction about the number.
  do_not_call boolean not null default false,
  last_called_at timestamptz,
  call_count integer not null default 0,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Makes CSV import idempotent by phone number within a workspace.
  unique (workspace_id, phone_normalized)
);

create index leads_workspace_status_idx on public.leads (workspace_id, status);
create index leads_workspace_outcome_idx on public.leads (workspace_id, outcome);
create index leads_workspace_city_idx on public.leads (workspace_id, city);
create index leads_workspace_state_idx on public.leads (workspace_id, state);
create index leads_workspace_last_called_idx on public.leads (workspace_id, last_called_at desc nulls last);
create index leads_workspace_created_idx on public.leads (workspace_id, created_at desc);
create index leads_dnc_idx on public.leads (workspace_id) where do_not_call;

-- One column to search instead of four OR'd ilikes.
alter table public.leads
  add column search_blob text
  generated always as (
    lower(
      coalesce(business_name, '') || ' ' ||
      coalesce(phone, '') || ' ' ||
      coalesce(phone_normalized, '') || ' ' ||
      coalesce(city, '') || ' ' ||
      coalesce(state, '') || ' ' ||
      coalesce(address, '')
    )
  ) stored;

create index leads_search_idx on public.leads using gin (search_blob gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Calling sessions
-- ---------------------------------------------------------------------------
create table public.calling_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces on delete cascade,
  name text not null,
  status public.session_status not null default 'pending',
  filters_json jsonb not null default '{}'::jsonb,
  total_leads integer not null default 0,
  completed_leads integer not null default 0,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index calling_sessions_workspace_idx
  on public.calling_sessions (workspace_id, created_at desc);

create table public.session_leads (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.calling_sessions on delete cascade,
  lead_id uuid not null references public.leads on delete cascade,
  workspace_id uuid not null references public.workspaces on delete cascade,
  -- Denormalized from leads purely so the unique constraint below can exist.
  phone_normalized text not null,
  queue_order integer not null,
  status public.session_lead_status not null default 'queued',
  outcome public.call_outcome,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, lead_id),
  -- Session-level dedup, enforced by the database: the same number can never
  -- be queued twice in one session even if the filter matched it twice.
  unique (session_id, phone_normalized)
);

create index session_leads_queue_idx
  on public.session_leads (session_id, status, queue_order);

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------
create table public.dial_call_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces on delete cascade,
  lead_id uuid references public.leads on delete set null,
  session_id uuid references public.calling_sessions on delete set null,
  user_id uuid references auth.users on delete set null,
  business_name text,
  phone text not null,
  phone_normalized text not null,
  direction text not null default 'outbound',
  mode text not null default 'direct',
  twilio_call_sid text,
  parent_call_sid text,
  conference_name text,
  call_status public.call_status not null default 'initiated',
  outcome public.call_outcome,
  duration_seconds integer not null default 0,
  recording_sid text,
  recording_url text,
  recording_duration integer,
  notes text,
  called_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);

create index dial_call_logs_workspace_called_idx
  on public.dial_call_logs (workspace_id, called_at desc);
create index dial_call_logs_lead_idx on public.dial_call_logs (lead_id, called_at desc);
create index dial_call_logs_session_idx on public.dial_call_logs (session_id);
create index dial_call_logs_parent_sid_idx on public.dial_call_logs (parent_call_sid);
create index dial_call_logs_outcome_idx on public.dial_call_logs (workspace_id, outcome);

create table public.call_transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.dial_call_logs on delete cascade,
  workspace_id uuid not null references public.workspaces on delete cascade,
  transcript_text text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (call_id)
);

-- ---------------------------------------------------------------------------
-- Saved filter presets (server-side mirror of the localStorage-first presets)
-- ---------------------------------------------------------------------------
create table public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  filters_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, name)
);

-- ---------------------------------------------------------------------------
-- Twilio configuration
--
-- Split in two on purpose. Members read the settings row to see how the
-- workspace is wired up; the secrets row has RLS on with no policies at all,
-- so only the service role (i.e. edge functions) can ever read it. Postgres
-- RLS is row-level, not column-level, which is why this is two tables.
-- ---------------------------------------------------------------------------
create table public.workspace_twilio_settings (
  workspace_id uuid primary key references public.workspaces on delete cascade,
  account_sid text,
  phone_number text,
  api_key_sid text,
  twiml_app_sid text,
  is_configured boolean not null default false,
  last_verified_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.workspace_twilio_secrets (
  workspace_id uuid primary key references public.workspaces on delete cascade,
  auth_token text not null,
  api_key_secret text,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- Triggers
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger workspaces_touch before update on public.workspaces
  for each row execute function public.touch_updated_at();
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();
create trigger calling_sessions_touch before update on public.calling_sessions
  for each row execute function public.touch_updated_at();
create trigger dial_call_logs_touch before update on public.dial_call_logs
  for each row execute function public.touch_updated_at();

-- Every signup gets a profile, a workspace, and an owner membership.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
  workspace_name text;
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  );

  workspace_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'workspace_name'), ''),
    initcap(split_part(new.email, '@', 1)) || '''s Workspace'
  );

  insert into public.workspaces (name, created_by)
  values (workspace_name, new.id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  insert into public.workspace_twilio_settings (workspace_id)
  values (new_workspace_id);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Section 12 hardening: a do_not_call lead is blocked at the database, not
-- just filtered out of the UI.
create or replace function public.block_do_not_call()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.lead_id is not null
     and exists (select 1 from public.leads l where l.id = new.lead_id and l.do_not_call)
  then
    raise exception 'Lead % is flagged do_not_call and cannot be dialed', new.lead_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger dial_call_logs_dnc_guard
  before insert on public.dial_call_logs
  for each row execute function public.block_do_not_call();

-- Placing a call touches the lead's activity counters.
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
           status = case when status = 'new' then 'in_progress' else status end
     where id = new.lead_id;
  end if;
  return new;
end;
$$;

create trigger dial_call_logs_touch_lead
  after insert on public.dial_call_logs
  for each row execute function public.touch_lead_on_call();

-- A logged do_not_call outcome raises the standing flag on the lead, so the
-- next session built from a filter can never pick that number back up.
create or replace function public.sync_dnc_flag()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.outcome = 'do_not_call' and new.lead_id is not null then
    update public.leads
       set do_not_call = true,
           outcome = 'do_not_call',
           status = 'disqualified'
     where id = new.lead_id;
  end if;
  return new;
end;
$$;

create trigger dial_call_logs_sync_dnc
  after insert or update of outcome on public.dial_call_logs
  for each row execute function public.sync_dnc_flag();

-- Session progress stays correct without the client recounting rows.
create or replace function public.sync_session_progress()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_session uuid := coalesce(new.session_id, old.session_id);
begin
  if target_session is null then
    return coalesce(new, old);
  end if;

  update public.calling_sessions s
     set total_leads = counts.total,
         completed_leads = counts.done,
         status = case
           when counts.total > 0 and counts.done >= counts.total then 'completed'
           else s.status
         end,
         completed_at = case
           when counts.total > 0 and counts.done >= counts.total then coalesce(s.completed_at, now())
           else s.completed_at
         end
    from (
      select
        count(*) as total,
        count(*) filter (where sl.status in ('done', 'skipped')) as done
      from public.session_leads sl
      where sl.session_id = target_session
    ) as counts
   where s.id = target_session;

  return coalesce(new, old);
end;
$$;

-- Deliberately not ON INSERT: build_session() bulk-inserts the whole queue and
-- sets total_leads itself, so firing per row there would be O(n) pointless
-- updates. Progress only needs recomputing as leads get dialed or removed.
create trigger session_leads_sync_progress
  after update or delete on public.session_leads
  for each row execute function public.sync_session_progress();
