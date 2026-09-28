-- ============================================================================
-- leads.status goes. Stage says everything it said, and said it wrong.
--
-- Measured before removing: 145 of 152 rows were the obvious pairing of status
-- to stage. The other 7 were drift in both directions — three at status 'new'
-- that had already been called, two 'disqualified' still sitting at stage
-- 'new'. And 'completed' was used by nothing, ever, by anybody.
--
-- It was never a second axis, only a coarser copy of the first, maintained by
-- three triggers and two client writers. A field with five writers and no
-- reader that needs it is a field that exists to go wrong.
--
-- Archived rather than simply dropped: this is the one irreversible step in the
-- change, and lead_status_archive makes it not one.
-- ============================================================================

create table if not exists public.lead_status_archive (
  lead_id     uuid primary key,
  status      text not null,
  archived_at timestamptz not null default now()
);

insert into public.lead_status_archive (lead_id, status)
select id, status::text from public.leads
on conflict (lead_id) do nothing;

alter table public.lead_status_archive enable row level security;

-- ── The three triggers that maintained it ──────────────────────────────────
create or replace function public.touch_lead_on_call()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.lead_id is not null then
    update public.leads
       set last_called_at = greatest(coalesce(last_called_at, new.called_at), new.called_at),
           call_count = call_count + 1,
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

create or replace function public.sync_dnc_flag()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.outcome = 'do_not_call' and new.lead_id is not null then
    update public.leads
       set do_not_call = true,
           outcome = 'do_not_call'
     where id = new.lead_id;
  end if;
  return new;
end;
$$;

create or replace function public.recount_lead_after_call_delete()
returns trigger language plpgsql set search_path = public
as $$
begin
  if old.lead_id is not null then
    update public.leads l
       set call_count = coalesce(stats.n, 0),
           last_called_at = stats.last_at
      from (
        select count(*) as n, max(called_at) as last_at
        from public.dial_call_logs
        where lead_id = old.lead_id
      ) as stats
     where l.id = old.lead_id;
  end if;
  return old;
end;
$$;

-- ── The session builder's filter ───────────────────────────────────────────
-- `statuses` is accepted and ignored rather than rejected, so a saved session
-- filter carrying one still builds instead of erroring on a field that no
-- longer exists.
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
  f_search text := nullif(trim(filters ->> 'search'), '');
  f_city text := nullif(trim(filters ->> 'city'), '');
  f_state text := nullif(trim(filters ->> 'state'), '');
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
      and (f_outcomes is null or l.outcome::text = any (f_outcomes))
      and (f_stages is null or l.pipeline_stage::text = any (f_stages))
      and (f_tiers is null or l.tier::text = any (f_tiers))
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

  update public.calling_sessions set total_leads = queued where id = new_session;

  return new_session;
end;
$$;

-- ── And the column itself ──────────────────────────────────────────────────
drop index if exists leads_workspace_status_idx;
alter table public.leads drop column if exists status;
drop type if exists public.lead_status;
