-- ============================================================================
-- Making room for calls that happened somewhere else.
--
-- Calls placed outside the dialer had nowhere to go, so real call history was
-- living in lead notes as prose. Every rolling stat — call_count, connection
-- rate, calls this week — therefore understated reality.
--
-- Two things have to be true before backfilling is safe.
-- ============================================================================

-- 1. A backfilled call is usually OLDER than the last one on the lead, and
--    this trigger assigned last_called_at unconditionally. Importing three
--    months of history would have walked every lead's "last called" backwards
--    and dragged it straight into the not-called-recently filters.
create or replace function public.touch_lead_on_call()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.lead_id is not null then
    update public.leads
       set last_called_at = greatest(coalesce(last_called_at, new.called_at), new.called_at),
           call_count = call_count + 1,
           status = case when status = 'new' then 'in_progress' else status end,
           pipeline_stage = case
             when pipeline_stage = 'new' then 'called'::public.pipeline_stage
             else pipeline_stage
           end,
           stage_changed_at = case
             when pipeline_stage = 'new' then now() else stage_changed_at
           end
     where id = new.lead_id;
  end if;
  return new;
end;
$$;

-- 2. build_session() only understood the pre-pipeline filters, so a session
--    could not be assembled from the fields the Leads page now filters on.
--    Without these, "call everyone whose demo is booked" is unbuildable.
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
  f_stages text[] := case
    when filters ? 'stages' then array(select jsonb_array_elements_text(filters -> 'stages'))
    else null end;
  f_tiers text[] := case
    when filters ? 'tiers' then array(select jsonb_array_elements_text(filters -> 'tiers'))
    else null end;
  f_tags text[] := case
    when filters ? 'tags' then array(select jsonb_array_elements_text(filters -> 'tags'))
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
    select distinct on (l.phone_normalized) l.*
    from public.leads l
    where l.workspace_id = ws
      and not l.do_not_call
      and (f_search is null or l.search_blob like '%' || lower(f_search) || '%')
      and (f_city is null or l.city ilike f_city)
      and (f_state is null or l.state ilike f_state)
      and (f_statuses is null or l.status::text = any (f_statuses))
      and (f_outcomes is null or l.outcome::text = any (f_outcomes))
      and (f_stages is null or l.pipeline_stage::text = any (f_stages))
      and (f_tiers is null or l.tier::text = any (f_tiers))
      -- Match any, matching the Leads page: a lead carrying either tag queues.
      and (f_tags is null or l.tags && f_tags)
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
