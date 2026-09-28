-- ============================================================================
-- Hardening pass, driven by the Supabase database linter.
--
-- Two themes: pin search_path on the remaining functions, and stop exposing
-- internals as PostgREST RPC endpoints.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. search_path on the two pure SQL helpers that were missed.
-- ---------------------------------------------------------------------------
alter function public.normalize_phone(text) set search_path = public;
alter function public.is_connected_outcome(public.call_outcome) set search_path = public;

-- ---------------------------------------------------------------------------
-- 2. Move pg_trgm out of the public schema.
--
-- Indexes reference their operator class by OID, so the existing GIN index on
-- leads.search_blob keeps working across the move.
-- ---------------------------------------------------------------------------
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
alter extension pg_trgm set schema extensions;

-- ---------------------------------------------------------------------------
-- 3. Lock down function execution.
--
-- Postgres grants EXECUTE on every new function to PUBLIC, and anon and
-- authenticated inherit it from there. Revoking from those two roles alone is
-- a no-op while the PUBLIC grant stands — the revoke has to name PUBLIC, then
-- grant back only to the roles that genuinely need it.
-- ---------------------------------------------------------------------------

-- Trigger functions are not API. They only ever run from a trigger, and
-- Postgres checks EXECUTE when a trigger is created rather than when it fires,
-- so removing every client grant does not affect the triggers already in place.
revoke execute on function public.handle_new_user()        from public, anon, authenticated;
revoke execute on function public.touch_updated_at()       from public, anon, authenticated;
revoke execute on function public.block_do_not_call()      from public, anon, authenticated;
revoke execute on function public.touch_lead_on_call()     from public, anon, authenticated;
revoke execute on function public.sync_dnc_flag()          from public, anon, authenticated;
revoke execute on function public.sync_session_progress()  from public, anon, authenticated;

-- RLS helper predicates. `authenticated` must keep EXECUTE: a policy
-- expression is evaluated with the querying role's privileges, so revoking it
-- there would break every policy. They leak nothing — each only answers a
-- question about the caller's own membership — but a signed-out user has no
-- membership to ask about.
revoke execute on function public.is_workspace_member(uuid)     from public, anon;
revoke execute on function public.is_workspace_admin(uuid)      from public, anon;
revoke execute on function public.shares_workspace_with(uuid)   from public, anon;
grant  execute on function public.is_workspace_member(uuid)     to authenticated, service_role;
grant  execute on function public.is_workspace_admin(uuid)      to authenticated, service_role;
grant  execute on function public.shares_workspace_with(uuid)   to authenticated, service_role;

-- Application RPCs are for signed-in members. Each already checks membership
-- itself; this removes the endpoint from the anon role entirely.
revoke execute on function public.import_leads(uuid, jsonb)                    from public, anon;
revoke execute on function public.build_session(uuid, text, jsonb, integer)    from public, anon;
revoke execute on function public.workspace_call_stats(uuid, text)             from public, anon;
revoke execute on function public.workspace_daily_calls(uuid, integer, text)   from public, anon;
revoke execute on function public.lead_filter_options(uuid)                    from public, anon;
grant  execute on function public.import_leads(uuid, jsonb)                    to authenticated, service_role;
grant  execute on function public.build_session(uuid, text, jsonb, integer)    to authenticated, service_role;
grant  execute on function public.workspace_call_stats(uuid, text)             to authenticated, service_role;
grant  execute on function public.workspace_daily_calls(uuid, integer, text)   to authenticated, service_role;
grant  execute on function public.lead_filter_options(uuid)                    to authenticated, service_role;

-- Pure helpers. These are called from inside the SECURITY INVOKER functions
-- above, which run as the caller, so `authenticated` needs EXECUTE on them too.
revoke execute on function public.normalize_phone(text)                        from public, anon;
revoke execute on function public.is_connected_outcome(public.call_outcome)    from public, anon;
grant  execute on function public.normalize_phone(text)                        to authenticated, service_role;
grant  execute on function public.is_connected_outcome(public.call_outcome)    to authenticated, service_role;
