-- ============================================================================
-- Calls logged after the fact do not vote on the best hour to call.
--
-- create_call backfills calls made outside the dialer. Their date is usually
-- real and their hour usually is not: six calls from a mobile on 3 Sep went in
-- with a placeholder noon because the notes never said when. Counted by hour,
-- they would have put six dials at 12pm on a chart built from thirty-odd, and
-- "when do people pick up" would have answered with a guess. Day of week keeps
-- them — the day is known.
-- ============================================================================
create or replace function public.workspace_hourly_performance(
  ws uuid, days integer default 30, tz text default 'UTC'
)
returns table(hour integer, dials bigint, connects bigint, appointments bigint, connect_rate numeric)
language plpgsql
stable
set search_path = public
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
   and c.mode <> 'manual'
  group by h
  order by h;
end;
$$;
