-- ============================================================================
-- The period summary says which day it stopped at.
--
-- A report for "3–9 Sep" was built by passing end = 9 Sep, which under the
-- half-open contract counts through the 8th. by_day, by_hour and totals all read
-- the same scoped rows and so agreed with each other — but the 9th was missing
-- from all of them, and that got written up as the daily series dropping a day.
-- The contract was in the tool's argument description. It is now in the
-- response too, where the misreading happens.
-- ============================================================================
create or replace function public.workspace_period_summary(
  ws uuid, start_date date, end_date date, tz text default 'UTC'
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  from_ts timestamptz;
  to_ts   timestamptz;
  result  jsonb;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;
  if end_date <= start_date then
    raise exception 'end_date must be after start_date (the range is half-open)'
      using errcode = '22007';
  end if;

  from_ts := (start_date::timestamp at time zone tz);
  to_ts   := (end_date::timestamp   at time zone tz);

  with scoped as (
    select * from public.dial_call_logs
    where workspace_id = ws and called_at >= from_ts and called_at < to_ts
  ),
  totals as (
    select
      count(*)                                                     as calls,
      count(*) filter (where outcome is not null)                  as dispositioned,
      count(*) filter (where public.is_connected_outcome(outcome)) as connected,
      count(*) filter (where outcome = 'appointment_set')          as appointments,
      count(*) filter (where outcome = 'callback_requested')       as callbacks,
      count(distinct lead_id) filter (where lead_id is not null)   as unique_leads,
      coalesce(sum(duration_seconds), 0)                           as talk_seconds
    from scoped
  ),
  by_outcome as (
    select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb) as v
    from (select outcome, count(*) n from scoped where outcome is not null group by outcome) x
  ),
  by_day as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'day', d, 'calls', calls, 'connects', connects) order by d), '[]'::jsonb) as v
    from (
      select date(timezone(tz, s.called_at)) as d, count(*) as calls,
             count(*) filter (where public.is_connected_outcome(s.outcome)) as connects
      from scoped s group by 1
    ) x
  ),
  by_hour as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'hour', h, 'calls', calls, 'connects', connects) order by h), '[]'::jsonb) as v
    from (
      select extract(hour from timezone(tz, s.called_at))::int as h, count(*) as calls,
             count(*) filter (where public.is_connected_outcome(s.outcome)) as connects
      from scoped s group by 1
    ) x
  ),
  notable as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'call_id', id, 'business_name', business_name, 'outcome', outcome,
             'duration_seconds', duration_seconds, 'called_at', called_at,
             'notes', notes) order by called_at), '[]'::jsonb) as v
    from (
      select * from scoped
      where outcome in ('appointment_set', 'callback_requested', 'connected_dm')
         or (notes is not null and length(btrim(notes)) > 0)
      order by called_at limit 40
    ) x
  )
  select jsonb_build_object(
    'period', jsonb_build_object('start', start_date, 'end', end_date,
                                 'last_day_included', (end_date - 1),
                                 'timezone', tz, 'days', (end_date - start_date)),
    'totals', to_jsonb(t) || jsonb_build_object(
      'connection_rate',
      case when t.dispositioned > 0
        then round(t.connected::numeric / t.dispositioned::numeric * 100, 1)
        else 0 end),
    'by_outcome', o.v, 'by_day', d.v, 'by_hour', h.v, 'notable_calls', n.v
  ) into result
  from totals t, by_outcome o, by_day d, by_hour h, notable n;

  return result;
end;
$$;
