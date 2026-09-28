-- ============================================================================
-- Missed calls.
--
-- Inbound calls were already logged — the row is written before the phone
-- rings, so a caller who hangs up mid-ring still leaves a record. What was
-- missing is any way to tell an answered one from a missed one.
--
-- Derived, not stored: a boolean anyone can forget to set drifts the first
-- time a new code path writes a call. Generated from the two columns that
-- already carry the fact, it cannot.
--
-- 'ringing' and 'in_progress' are deliberately NOT missed. A call still in
-- flight is not a call you failed to take, and a dashboard that says otherwise
-- cries wolf for twenty seconds on every single call.
-- ============================================================================

alter table public.dial_call_logs
  add column if not exists missed boolean
  generated always as (
    direction = 'inbound'
    and call_status in ('no_answer', 'busy', 'failed', 'canceled')
  ) stored;

-- Partial: the whole point of this index is "show me the few that were missed",
-- so it has no business carrying a row for every call ever placed.
create index if not exists dial_call_logs_missed_idx
  on public.dial_call_logs (workspace_id, called_at desc)
  where missed;

-- ---------------------------------------------------------------------------
-- How many are still unheard, for the dashboard. A missed call nobody is told
-- about is the same as no record at all.
--
-- "Dealt with" means the lead has been called back since, or the call has been
-- given an outcome by hand — either way somebody looked at it.
-- ---------------------------------------------------------------------------
create or replace function public.workspace_missed_calls(ws uuid, since_days int default 14)
returns table (
  id uuid,
  lead_id uuid,
  business_name text,
  phone text,
  called_at timestamptz,
  has_voicemail boolean,
  called_back boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    c.id,
    c.lead_id,
    c.business_name,
    c.phone,
    c.called_at,
    c.recording_sid is not null as has_voicemail,
    exists (
      select 1 from public.dial_call_logs later
      where later.workspace_id = c.workspace_id
        and later.direction = 'outbound'
        and later.called_at > c.called_at
        and (
          later.lead_id = c.lead_id
          -- An inbound call from a number not yet in the leads table has no
          -- lead_id, so fall back to the number itself.
          or later.phone_normalized = c.phone_normalized
        )
    ) as called_back
  from public.dial_call_logs c
  where c.workspace_id = ws
    and c.missed
    and c.outcome is null
    and c.called_at >= now() - make_interval(days => greatest(since_days, 1))
  order by c.called_at desc
  limit 50;
$$;

revoke execute on function public.workspace_missed_calls(uuid, int) from public, anon;
grant  execute on function public.workspace_missed_calls(uuid, int) to authenticated, service_role;
