-- ============================================================================
-- Server-side logic: phone normalization, CSV import, session building, and
-- dashboard aggregation.
--
-- These exist so the client never pulls tens of thousands of rows down just to
-- count them or to dedup a list.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Phone normalization. Strip to digits, then drop the US country code so that
-- "+1 (555) 010-9999", "555-010-9999" and "15550109999" all dedup together.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_phone(raw text)
returns text
language sql
immutable
as $$
  select case
    when raw is null then null
    when length(regexp_replace(raw, '[^0-9]', '', 'g')) = 11
         and left(regexp_replace(raw, '[^0-9]', '', 'g'), 1) = '1'
      then substr(regexp_replace(raw, '[^0-9]', '', 'g'), 2)
    else nullif(regexp_replace(raw, '[^0-9]', '', 'g'), '')
  end;
$$;

create or replace function public.is_connected_outcome(o public.call_outcome)
returns boolean
language sql
immutable
as $$
  -- Every one of these required a human on the other end of the line.
  select o in (
    'connected_dm', 'connected_gk', 'connected_other',
    'appointment_set', 'callback_requested', 'not_interested', 'do_not_call'
  );
$$;

-- ---------------------------------------------------------------------------
-- CSV import. Idempotent by normalized phone within the workspace: re-running
-- an overlapping list refreshes business details but never resets a lead's
-- status, outcome, notes, or do_not_call flag.
-- ---------------------------------------------------------------------------
create or replace function public.import_leads(ws uuid, payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_inserted integer := 0;
  n_updated integer := 0;
  n_received integer := coalesce(jsonb_array_length(payload), 0);
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  with parsed as (
    select
      coalesce(nullif(trim(r ->> 'business_name'), ''), 'Unknown business') as business_name,
      nullif(trim(r ->> 'phone'), '') as phone,
      public.normalize_phone(r ->> 'phone') as phone_normalized,
      nullif(trim(r ->> 'address'), '') as address,
      nullif(trim(r ->> 'city'), '') as city,
      nullif(trim(r ->> 'state'), '') as state,
      nullif(trim(r ->> 'zip'), '') as zip,
      nullif(trim(r ->> 'website'), '') as website,
      nullif(trim(r ->> 'email'), '') as email,
      nullif(trim(r ->> 'notes'), '') as notes,
      coalesce(r -> 'metadata_json', '{}'::jsonb) as metadata_json
    from jsonb_array_elements(payload) as r
  ),
  -- A single upload can contain the same number twice; collapse before the
  -- upsert so ON CONFLICT never sees a duplicate inside one statement.
  deduped as (
    select distinct on (phone_normalized) *
    from parsed
    where phone_normalized is not null
      and length(phone_normalized) >= 10
    order by phone_normalized, length(business_name) desc
  ),
  upserted as (
    insert into public.leads (
      workspace_id, business_name, phone, phone_normalized,
      address, city, state, zip, website, email, notes, metadata_json
    )
    select
      ws, business_name, phone, phone_normalized,
      address, city, state, zip, website, email, notes, metadata_json
    from deduped
    on conflict (workspace_id, phone_normalized) do update set
      business_name = excluded.business_name,
      phone         = excluded.phone,
      address       = coalesce(excluded.address, public.leads.address),
      city          = coalesce(excluded.city, public.leads.city),
      state         = coalesce(excluded.state, public.leads.state),
      zip           = coalesce(excluded.zip, public.leads.zip),
      website       = coalesce(excluded.website, public.leads.website),
      email         = coalesce(excluded.email, public.leads.email),
      metadata_json = public.leads.metadata_json || excluded.metadata_json,
      updated_at    = now()
    -- xmax = 0 is true only for a freshly inserted row, which is how we tell
    -- inserts from updates inside one upsert.
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into n_inserted, n_updated
  from upserted;

  return jsonb_build_object(
    'received', n_received,
    'inserted', n_inserted,
    'updated', n_updated,
    'skipped', n_received - (n_inserted + n_updated)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Session building. Takes the same filter shape the Leads page uses and
-- freezes the matching slice into an ordered queue.
--
-- filters: { search, statuses[], outcomes[], city, state, not_called_since,
--            never_called }
-- ---------------------------------------------------------------------------
create or replace function public.build_session(
  ws uuid,
  session_name text,
  filters jsonb default '{}'::jsonb,
  max_leads integer default 500
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_session uuid;
  queued integer := 0;
  f_search text := nullif(trim(filters ->> 'search'), '');
  f_city text := nullif(trim(filters ->> 'city'), '');
  f_state text := nullif(trim(filters ->> 'state'), '');
  f_statuses text[] := case
    when filters ? 'statuses' then array(select jsonb_array_elements_text(filters -> 'statuses'))
    else null end;
  f_outcomes text[] := case
    when filters ? 'outcomes' then array(select jsonb_array_elements_text(filters -> 'outcomes'))
    else null end;
  f_not_called_since timestamptz := (filters ->> 'not_called_since')::timestamptz;
  f_never_called boolean := coalesce((filters ->> 'never_called')::boolean, false);
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  insert into public.calling_sessions (workspace_id, name, filters_json, created_by)
  values (ws, session_name, filters, auth.uid())
  returning id into new_session;

  with eligible as (
    -- distinct on (phone_normalized) is the "highest-priority lead per
    -- number" rule. Leads is already unique on it per workspace, so this is
    -- belt-and-braces, but it keeps the guarantee if that ever relaxes.
    select distinct on (l.phone_normalized) l.*
    from public.leads l
    where l.workspace_id = ws
      -- Compliance: a flagged number never enters a queue in the first place.
      and not l.do_not_call
      and (f_search is null or l.search_blob like '%' || lower(f_search) || '%')
      and (f_city is null or l.city ilike f_city)
      and (f_state is null or l.state ilike f_state)
      and (f_statuses is null or l.status::text = any (f_statuses))
      and (f_outcomes is null or l.outcome::text = any (f_outcomes))
      and (not f_never_called or l.last_called_at is null)
      and (f_not_called_since is null
           or l.last_called_at is null
           or l.last_called_at < f_not_called_since)
    order by l.phone_normalized, l.last_called_at asc nulls first, l.created_at asc
  ),
  ordered as (
    select
      id, phone_normalized,
      row_number() over (order by last_called_at asc nulls first, created_at asc) as queue_order
    from eligible
    limit greatest(max_leads, 0)
  ),
  inserted as (
    insert into public.session_leads
      (session_id, lead_id, workspace_id, phone_normalized, queue_order)
    select new_session, id, ws, phone_normalized, queue_order
    from ordered
    returning 1
  )
  select count(*) into queued from inserted;

  update public.calling_sessions
     set total_leads = queued
   where id = new_session;

  return new_session;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dashboard KPIs. Aggregated in Postgres so the client fetches six numbers
-- instead of the call log.
-- ---------------------------------------------------------------------------
create or replace function public.workspace_call_stats(ws uuid, tz text default 'UTC')
returns jsonb
language plpgsql
security invoker
stable
set search_path = public
as $$
declare
  result jsonb;
  day_start timestamptz;
  week_start timestamptz;
  month_start timestamptz;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  day_start   := (date_trunc('day',   timezone(tz, now())) at time zone tz);
  week_start  := (date_trunc('week',  timezone(tz, now())) at time zone tz);
  month_start := (date_trunc('month', timezone(tz, now())) at time zone tz);

  select jsonb_build_object(
    'calls_today',        count(*) filter (where called_at >= day_start),
    'calls_week',         count(*) filter (where called_at >= week_start),
    'calls_month',        count(*) filter (where called_at >= month_start),
    'leads_today',        count(distinct lead_id) filter (where called_at >= day_start),
    'leads_week',         count(distinct lead_id) filter (where called_at >= week_start),
    'leads_month',        count(distinct lead_id) filter (where called_at >= month_start),
    'calls_total',        count(*),
    'talk_seconds_today', coalesce(sum(duration_seconds) filter (where called_at >= day_start), 0),
    'connected_month',    count(*) filter (
                            where called_at >= month_start
                              and public.is_connected_outcome(outcome)),
    'dispositioned_month', count(*) filter (
                            where called_at >= month_start and outcome is not null)
  )
  into result
  from public.dial_call_logs
  where workspace_id = ws;

  return result || jsonb_build_object(
    'connection_rate',
    case
      when (result ->> 'dispositioned_month')::numeric > 0
        then round(
          (result ->> 'connected_month')::numeric
          / (result ->> 'dispositioned_month')::numeric * 100, 1)
      else 0
    end
  );
end;
$$;

create or replace function public.workspace_daily_calls(
  ws uuid, days integer default 14, tz text default 'UTC'
)
returns table (day date, calls bigint, connects bigint)
language plpgsql
security invoker
stable
set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select
    d::date as day,
    count(c.id) as calls,
    count(c.id) filter (where public.is_connected_outcome(c.outcome)) as connects
  from generate_series(
         (timezone(tz, now()))::date - (greatest(days, 1) - 1),
         (timezone(tz, now()))::date,
         interval '1 day'
       ) as d
  left join public.dial_call_logs c
    on c.workspace_id = ws
   and (timezone(tz, c.called_at))::date = d::date
  group by d
  order by d;
end;
$$;

-- Distinct cities/states for the filter dropdowns, without shipping the list.
create or replace function public.lead_filter_options(ws uuid)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  select jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(c order by c)
      from (select distinct city as c from public.leads
            where workspace_id = ws and city is not null limit 500) x
    ), '[]'::jsonb),
    'states', coalesce((
      select jsonb_agg(s order by s)
      from (select distinct state as s from public.leads
            where workspace_id = ws and state is not null limit 100) y
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
