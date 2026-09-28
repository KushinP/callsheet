-- ============================================================================
-- Analytics RPCs.
--
-- Catch-up migration — see 20260905000009. All follow workspace_daily_calls:
-- security invoker, membership gate first, aggregation in Postgres, and
-- revoke-from-PUBLIC before granting back (EXECUTE is granted to PUBLIC by
-- default, so revoking from anon alone is a silent no-op).
-- ============================================================================

-- ── When to call ────────────────────────────────────────────────────────────
-- The highest-value chart for a solo dialer: it says what time to work.
-- generate_series so hours with no calls render as zero rather than as gaps.
create or replace function public.workspace_hourly_performance(
  ws uuid, days integer default 30, tz text default 'UTC'
)
returns table (hour integer, dials bigint, connects bigint,
               appointments bigint, connect_rate numeric)
language plpgsql security invoker stable set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select
    h::integer,
    count(c.id),
    count(c.id) filter (where public.is_connected_outcome(c.outcome)),
    count(c.id) filter (where c.outcome = 'appointment_set'),
    case when count(c.id) filter (where c.outcome is not null) > 0
      then round(count(c.id) filter (where public.is_connected_outcome(c.outcome))::numeric
                 / count(c.id) filter (where c.outcome is not null) * 100, 1)
      else 0 end
  from generate_series(0, 23) as h
  left join public.dial_call_logs c
    on c.workspace_id = ws
   and extract(hour from timezone(tz, c.called_at)) = h
   and c.called_at >= now() - make_interval(days => greatest(days, 1))
  group by h
  order by h;
end;
$$;

create or replace function public.workspace_dow_performance(
  ws uuid, days integer default 90, tz text default 'UTC'
)
returns table (dow integer, dials bigint, connects bigint, connect_rate numeric)
language plpgsql security invoker stable set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select
    d::integer,
    count(c.id),
    count(c.id) filter (where public.is_connected_outcome(c.outcome)),
    case when count(c.id) filter (where c.outcome is not null) > 0
      then round(count(c.id) filter (where public.is_connected_outcome(c.outcome))::numeric
                 / count(c.id) filter (where c.outcome is not null) * 100, 1)
      else 0 end
  from generate_series(0, 6) as d
  left join public.dial_call_logs c
    on c.workspace_id = ws
   and extract(dow from timezone(tz, c.called_at)) = d
   and c.called_at >= now() - make_interval(days => greatest(days, 1))
  group by d
  order by d;
end;
$$;

-- ── What's working ──────────────────────────────────────────────────────────
-- The flat call-count line hides the thing that matters: a rising voicemail
-- share is a leading indicator the dashboard cannot otherwise show.
create or replace function public.workspace_daily_outcomes(
  ws uuid, days integer default 30, tz text default 'UTC'
)
returns table (day date, outcome public.call_outcome, calls bigint)
language plpgsql security invoker stable set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select date(timezone(tz, c.called_at)), c.outcome, count(*)
  from public.dial_call_logs c
  where c.workspace_id = ws
    and c.outcome is not null
    and c.called_at >= now() - make_interval(days => greatest(days, 1))
  group by 1, 2
  order by 1, 2;
end;
$$;

-- ── Which script actually books ─────────────────────────────────────────────
-- Reads all-null until dial_call_logs.script_id has been written for a while.
create or replace function public.workspace_script_performance(
  ws uuid, days integer default 90
)
returns table (script_id uuid, name text, dials bigint, connects bigint,
               appointments bigint, connect_rate numeric)
language plpgsql security invoker stable set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select
    c.script_id,
    coalesce(s.name, 'No script attached'),
    count(*),
    count(*) filter (where public.is_connected_outcome(c.outcome)),
    count(*) filter (where c.outcome = 'appointment_set'),
    case when count(*) filter (where c.outcome is not null) > 0
      then round(count(*) filter (where public.is_connected_outcome(c.outcome))::numeric
                 / count(*) filter (where c.outcome is not null) * 100, 1)
      else 0 end
  from public.dial_call_logs c
  left join public.call_scripts s on s.id = c.script_id
  where c.workspace_id = ws
    and c.called_at >= now() - make_interval(days => greatest(days, 1))
  group by c.script_id, s.name
  order by count(*) desc;
end;
$$;

-- ── List quality and segment success ────────────────────────────────────────
-- Groups by something about the LEAD rather than the call. `dimension` is a
-- column on leads or a key inside a brief's summary_json — whitelisted rather
-- than interpolated, because a dimension string reaching SQL unchecked is an
-- injection either way.
create or replace function public.workspace_segment_performance(
  ws uuid, dimension text default 'state', days integer default 365
)
returns table (segment text, leads_touched bigint, dials bigint,
               connects bigint, appointments bigint, connect_rate numeric)
language plpgsql security invoker stable set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  if dimension not in ('city', 'state', 'business_type', 'segment', 'size_band', 'independent') then
    raise exception 'unsupported dimension %', dimension using errcode = '22023';
  end if;

  return query
  with scoped as (
    select
      c.id, c.outcome, c.lead_id,
      coalesce(
        case dimension
          when 'city'  then l.city
          when 'state' then l.state
          else d.summary_json ->> dimension
        end,
        'unknown'
      ) as seg
    from public.dial_call_logs c
    join public.leads l on l.id = c.lead_id
    left join public.documents d
      on d.lead_id = l.id and d.kind = 'lead_brief'
    where c.workspace_id = ws
      and c.called_at >= now() - make_interval(days => greatest(days, 1))
  )
  select
    seg,
    count(distinct lead_id),
    count(*),
    count(*) filter (where public.is_connected_outcome(outcome)),
    count(*) filter (where outcome = 'appointment_set'),
    case when count(*) filter (where outcome is not null) > 0
      then round(count(*) filter (where public.is_connected_outcome(outcome))::numeric
                 / count(*) filter (where outcome is not null) * 100, 1)
      else 0 end
  from scoped
  group by seg
  order by count(*) desc;
end;
$$;

-- ── Effort, and when to give up on a number ─────────────────────────────────
-- attempts_to_contact is the non-obvious one: how many dials it actually takes
-- to reach someone, which turns "not called in N days" from a hunch into a
-- number.
create or replace function public.workspace_pace(
  ws uuid, days integer default 30, tz text default 'UTC'
)
returns jsonb
language plpgsql security invoker stable set search_path = public
as $$
declare result jsonb;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  with scoped as (
    select * from public.dial_call_logs
    where workspace_id = ws
      and called_at >= now() - make_interval(days => greatest(days, 1))
  ),
  ranked as (
    select lead_id, called_at, outcome,
           row_number() over (partition by lead_id order by called_at) as attempt
    from scoped where lead_id is not null
  ),
  first_contact as (
    select attempt, count(*) as leads
    from (
      select distinct on (lead_id) lead_id, attempt
      from ranked
      where public.is_connected_outcome(outcome)
      order by lead_id, attempt
    ) x
    group by attempt order by attempt
  ),
  active_hours as (
    -- Hours in which anything was dialled at all — a fair denominator for
    -- "calls per hour" that does not punish a short working day.
    select count(*) as n from (
      select date_trunc('hour', timezone(tz, called_at)) from scoped group by 1
    ) y
  )
  select jsonb_build_object(
    'calls', (select count(*) from scoped),
    'connects', (select count(*) from scoped where public.is_connected_outcome(outcome)),
    'talk_seconds', (select coalesce(sum(duration_seconds), 0) from scoped),
    'median_talk_seconds', (
      select coalesce(percentile_cont(0.5) within group (order by duration_seconds), 0)
      from scoped where public.is_connected_outcome(outcome)),
    'active_hours', (select n from active_hours),
    'calls_per_active_hour', case when (select n from active_hours) > 0
      then round((select count(*) from scoped)::numeric / (select n from active_hours), 1)
      else 0 end,
    'dials_per_connect', case
      when (select count(*) from scoped where public.is_connected_outcome(outcome)) > 0
      then round((select count(*) from scoped)::numeric
                 / (select count(*) from scoped where public.is_connected_outcome(outcome)), 1)
      else null end,
    'attempts_to_contact', coalesce(
      (select jsonb_agg(jsonb_build_object('attempt', attempt, 'leads', leads) order by attempt)
       from first_contact), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke execute on function public.workspace_hourly_performance(uuid, integer, text) from public, anon;
revoke execute on function public.workspace_dow_performance(uuid, integer, text) from public, anon;
revoke execute on function public.workspace_daily_outcomes(uuid, integer, text) from public, anon;
revoke execute on function public.workspace_script_performance(uuid, integer) from public, anon;
revoke execute on function public.workspace_segment_performance(uuid, text, integer) from public, anon;
revoke execute on function public.workspace_pace(uuid, integer, text) from public, anon;

grant execute on function public.workspace_hourly_performance(uuid, integer, text) to authenticated, service_role;
grant execute on function public.workspace_dow_performance(uuid, integer, text) to authenticated, service_role;
grant execute on function public.workspace_daily_outcomes(uuid, integer, text) to authenticated, service_role;
grant execute on function public.workspace_script_performance(uuid, integer) to authenticated, service_role;
grant execute on function public.workspace_segment_performance(uuid, text, integer) to authenticated, service_role;
grant execute on function public.workspace_pace(uuid, integer, text) to authenticated, service_role;
