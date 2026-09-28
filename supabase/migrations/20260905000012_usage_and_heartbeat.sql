-- ============================================================================
-- Month-to-date usage, and the liveness ping.
--
-- Catch-up migration — see 20260905000009.
-- ============================================================================

-- Raw counters rather than a dollar figure: rates are list prices that change,
-- and they belong in one visible place in the client rather than buried here.
create or replace function public.workspace_month_usage(ws uuid, tz text default 'UTC')
returns jsonb
language plpgsql security invoker stable set search_path = public
as $$
declare
  month_start timestamptz;
  result jsonb;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  month_start := (date_trunc('month', timezone(tz, now())) at time zone tz);

  select jsonb_build_object(
    'month_start', month_start,
    'calls', count(*),
    'inbound_calls', count(*) filter (where direction = 'inbound'),
    -- Twilio rounds every leg up to the next whole minute, so summing raw
    -- seconds understates the bill. Round each call, then total.
    'billed_minutes', coalesce(sum(ceil(greatest(duration_seconds, 0)::numeric / 60)), 0),
    'talk_seconds', coalesce(sum(duration_seconds), 0),
    'recorded_minutes', coalesce(sum(ceil(greatest(recording_duration, 0)::numeric / 60))
                                 filter (where recording_sid is not null), 0),
    'transcribed_calls', count(*) filter (where transcribed_at is not null
                                            and transcription_error is null)
  )
  into result
  from public.dial_call_logs
  where workspace_id = ws and called_at >= month_start;

  -- What the model work has actually cost, which is measured rather than
  -- inferred: both tables store what each call and each brief was billed.
  return result
    || jsonb_build_object(
      'transcription_usd', coalesce((
        select round(sum(t.cost_usd), 4) from public.call_transcripts t
        join public.dial_call_logs c on c.id = t.call_id
        where c.workspace_id = ws and c.called_at >= month_start), 0),
      'documents_usd', coalesce((
        select round(sum(d.cost_usd), 4) from public.documents d
        where d.workspace_id = ws and d.created_at >= month_start), 0));
end;
$$;

revoke execute on function public.workspace_month_usage(uuid, text) from public, anon;
grant  execute on function public.workspace_month_usage(uuid, text) to authenticated, service_role;

-- ── Liveness ────────────────────────────────────────────────────────────────
-- Keeps the project out of the free plan's 7-day inactivity pause. Supabase
-- counts USER DATABASE QUERIES; dashboard visits do not qualify, so this has to
-- actually touch the database rather than return a constant the planner folds
-- away. Called by a Cloudflare Worker cron (workers/heartbeat).
create or replace function public.heartbeat()
returns boolean
language plpgsql stable security invoker set search_path = public
as $$
declare n bigint;
begin
  -- INVOKER, not DEFINER: anon already holds SELECT on workspaces (PostgREST
  -- needs it) and RLS returns zero rows, so the count still runs a real query
  -- without this executing as the owner. The result is discarded — only the
  -- fact that a query ran counts toward the inactivity timer.
  select count(*) into n from public.workspaces;
  return true;
end;
$$;

revoke execute on function public.heartbeat() from public;
grant  execute on function public.heartbeat() to anon, authenticated, service_role;

comment on function public.heartbeat() is
  'Liveness ping for the free-plan inactivity timer. Returns true, exposes nothing.';

-- ── Leads still needing a brief ─────────────────────────────────────────────
-- PostgREST cannot express NOT EXISTS cleanly, and doing it client-side would
-- mean pulling every lead id to diff against every document. This doubles as
-- the idempotency guard: a lead that already has a brief is never selected, so
-- re-running costs nothing.
create or replace function public.leads_needing_brief(ws uuid, max_rows integer default 25)
returns table (
  id uuid, business_name text, phone text, address text, city text,
  state text, zip text, website text, email text, notes text, metadata_json jsonb
)
language plpgsql security invoker stable set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select l.id, l.business_name, l.phone, l.address, l.city, l.state, l.zip,
         l.website, l.email, l.notes, l.metadata_json
  from public.leads l
  where l.workspace_id = ws
    and not l.do_not_call
    and not exists (
      select 1 from public.documents d
      where d.lead_id = l.id and d.kind = 'lead_brief'
    )
  order by l.created_at desc
  limit greatest(least(max_rows, 50), 1);
end;
$$;

revoke execute on function public.leads_needing_brief(uuid, integer) from public, anon;
grant  execute on function public.leads_needing_brief(uuid, integer) to authenticated, service_role;
