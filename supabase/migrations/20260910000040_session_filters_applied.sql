-- ============================================================================
-- A session filter is applied or refused. It is never accepted and ignored.
--
-- The dial list was being built from filters nothing honoured. The Leads page
-- applied room bounds; the session preview and build_session did not, so a list
-- filtered to 6–12 rooms queued a 23-room inn. Room count is the cheapest
-- qualifier in the operation: three of the first eight real conversations died
-- on it.
--
-- build_session now honours every filter a lead list can express — rooms and
-- has_next_step included — plus lead_ids for a curated batch, intersected with
-- the rest and queued in the order given. An unrecognised key raises instead of
-- vanishing. filters_json stores what was APPLIED, not what was asked for, so
-- anything reading a session back sees the truth.
--
-- Also: LIMIT sat on an unordered select, so with more matches than max_leads
-- WHICH leads were queued was not guaranteed — and for a curated batch that is
-- the whole point. It is ordered now.
-- ============================================================================
create or replace function public.build_session(
  ws uuid, session_name text, filters jsonb default '{}'::jsonb, max_leads integer default 500
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  new_session uuid;
  queued integer := 0;
  known constant text[] := array[
    'search', 'city', 'state', 'outcomes', 'stages', 'tiers', 'tags',
    'never_called', 'not_called_since', 'rooms_min', 'rooms_max',
    'has_next_step', 'lead_ids'
  ];
  -- Retired with leads.status. Accepted and ignored so a saved preset carrying
  -- it still builds; every OTHER unknown key is refused below.
  retired constant text[] := array['statuses'];
  unknown text[];
  f jsonb := coalesce(filters, '{}'::jsonb);
  f_search text := nullif(trim(f ->> 'search'), '');
  f_city text := nullif(trim(f ->> 'city'), '');
  f_state text := nullif(trim(f ->> 'state'), '');
  f_outcomes text[] := case
    when f ? 'outcomes' then array(select jsonb_array_elements_text(f -> 'outcomes')) end;
  f_stages text[] := case
    when f ? 'stages' then array(select jsonb_array_elements_text(f -> 'stages')) end;
  f_tiers text[] := case
    when f ? 'tiers' then array(select jsonb_array_elements_text(f -> 'tiers')) end;
  f_tags text[] := case
    when f ? 'tags' then array(select jsonb_array_elements_text(f -> 'tags')) end;
  f_not_called_since timestamptz := (f ->> 'not_called_since')::timestamptz;
  f_never_called boolean := coalesce((f ->> 'never_called')::boolean, false);
  f_rooms_min integer := (f ->> 'rooms_min')::integer;
  f_rooms_max integer := (f ->> 'rooms_max')::integer;
  f_has_next boolean := (f ->> 'has_next_step')::boolean;
  f_lead_ids uuid[] := case
    when f ? 'lead_ids' then array(select (jsonb_array_elements_text(f -> 'lead_ids'))::uuid) end;
  applied jsonb;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  select array_agg(k order by k) into unknown
    from jsonb_object_keys(f) as k
   where not (k = any (known)) and not (k = any (retired));

  if unknown is not null then
    raise exception 'build_session does not recognise the filter(s): %',
      array_to_string(unknown, ', ')
      using errcode = '22023',
            hint = 'Refused rather than ignored: a filter dropped in silence builds the wrong list.';
  end if;

  applied := jsonb_strip_nulls(jsonb_build_object(
    'search', f_search, 'city', f_city, 'state', f_state,
    'outcomes', to_jsonb(f_outcomes), 'stages', to_jsonb(f_stages),
    'tiers', to_jsonb(f_tiers), 'tags', to_jsonb(f_tags),
    'never_called', case when f_never_called then true end,
    'not_called_since', f_not_called_since,
    'rooms_min', f_rooms_min, 'rooms_max', f_rooms_max,
    'has_next_step', f_has_next,
    'lead_ids', to_jsonb(f_lead_ids)
  ));

  insert into public.calling_sessions (workspace_id, name, filters_json, created_by)
  values (ws, session_name, applied, auth.uid())
  returning id into new_session;

  with eligible as (
    select distinct on (l.phone_normalized) l.*
    from public.leads l
    where l.workspace_id = ws
      and not l.do_not_call
      and (f_search is null or l.search_blob like '%' || lower(f_search) || '%')
      and (f_city is null or l.city ilike f_city)
      and (f_state is null or l.state ilike f_state)
      and (f_outcomes is null or l.outcome::text = any (f_outcomes))
      and (f_stages is null or l.pipeline_stage::text = any (f_stages))
      and (f_tiers is null or l.tier::text = any (f_tiers))
      and (f_tags is null or l.tags && f_tags)
      and (not f_never_called or l.last_called_at is null)
      and (f_not_called_since is null
           or l.last_called_at is null
           or l.last_called_at < f_not_called_since)
      and (f_rooms_min is null or l.room_count >= f_rooms_min)
      and (f_rooms_max is null or l.room_count <= f_rooms_max)
      and (f_has_next is null or (l.open_task_count > 0) = f_has_next)
      and (f_lead_ids is null or l.id = any (f_lead_ids))
    order by l.phone_normalized, l.last_called_at asc nulls first, l.created_at asc
  ),
  ordered as (
    select
      id, phone_normalized,
      row_number() over (
        order by array_position(f_lead_ids, id) asc nulls last,
                 last_called_at asc nulls first,
                 created_at asc
      ) as queue_order
    from eligible
    order by queue_order
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

  update public.calling_sessions set total_leads = queued where id = new_session;

  return new_session;
end;
$$;
