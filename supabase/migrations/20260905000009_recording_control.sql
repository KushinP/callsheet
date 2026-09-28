-- ============================================================================
-- Recording control.
--
-- Catch-up migration: this was applied through the management API and never
-- written down, so the repo stopped describing the schema. Written with
-- `if not exists` / `create or replace` so it is safe against the live database
-- and against a fresh one.
-- ============================================================================

-- Workspace policy. It belongs on `workspaces`, whose update policy is already
-- admin-only, and specifically NOT on workspace_twilio_settings, where
-- re-provisioning rewrites the row and would silently reset it.
alter table public.workspaces
  add column if not exists recording_enabled boolean not null default true;

-- Three-state on purpose: NULL means "inherit the workspace default", which has
-- to stay distinguishable from an explicit off.
alter table public.calling_sessions
  add column if not exists record_calls boolean;

-- What actually happened, on the call itself. This is the compliance record:
-- "was this call recorded" must be answerable from the log alone, not
-- re-derived from two settings rows that have since changed.
alter table public.dial_call_logs
  add column if not exists recorded boolean not null default false;

-- The precedence rule, in one place, out of TypeScript.
create or replace function public.call_should_record(log uuid)
returns boolean
language sql stable security invoker set search_path = public
as $$
  select coalesce(s.record_calls, w.recording_enabled)
  from public.dial_call_logs c
  join public.workspaces w on w.id = c.workspace_id
  left join public.calling_sessions s on s.id = c.session_id
  where c.id = log;
$$;

-- Only edge functions call this, and the service role bypasses RLS, so
-- SECURITY INVOKER is both sufficient and the safer default.
revoke execute on function public.call_should_record(uuid) from public, anon, authenticated;
grant  execute on function public.call_should_record(uuid) to service_role;
