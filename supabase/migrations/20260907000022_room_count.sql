-- ============================================================================
-- Room count, promoted out of the metadata bag.
--
-- It was living there three times over, in shapes nothing could query:
--   rooms            124 leads — 54 numeric, 70 prose ("13 main (closed) +
--                    21 lodge", "9 or 11 - own site conflicts", "unverified")
--   approx_rooms      24 leads — numeric, and a DISJOINT set: no lead had both
--   rooms_verification 25 leads — "verified"
--
-- So the single most useful qualifier for a hotel — how big is it — could not
-- be filtered, sorted or segmented on. Analytics' Size breakdown reads a
-- Claude-written brief instead, which 27 of 152 leads have, and answers
-- "unknown" for 128 of them.
--
-- The prose is not garbage and is not discarded: "13 main (closed) + 21 lodge"
-- changes the pitch. It stays in metadata_json, which the lead panel now
-- renders, so nothing becomes less visible than it was.
-- ============================================================================

alter table public.leads
  add column if not exists room_count integer
    check (room_count is null or (room_count > 0 and room_count <= 2000));

comment on column public.leads.room_count is
  'How many rooms the property has. Null means unknown — the nuance for a '
  'property that cannot be reduced to one number lives in metadata_json.';

create index if not exists leads_workspace_rooms_idx
  on public.leads (workspace_id, room_count) where room_count is not null;

-- ── Backfill, and do not leave the value in two places ──────────────────────
-- Only the rows that yield a clean integer are touched; a prose value stays
-- exactly where it is.
update public.leads
   set room_count = nullif(regexp_replace(
         coalesce(metadata_json ->> 'rooms', metadata_json ->> 'approx_rooms'), '\D', '', 'g'
       ), '')::int
 where room_count is null
   and coalesce(metadata_json ->> 'rooms', metadata_json ->> 'approx_rooms') ~ '^[0-9]+$'
   and nullif(regexp_replace(
         coalesce(metadata_json ->> 'rooms', metadata_json ->> 'approx_rooms'), '\D', '', 'g'
       ), '')::int between 1 and 2000;

update public.leads
   set metadata_json = metadata_json - 'rooms' - 'approx_rooms'
 where room_count is not null
   and (metadata_json ->> 'rooms' ~ '^[0-9]+$' or metadata_json ->> 'approx_rooms' ~ '^[0-9]+$');

-- ── The contact column added on the 6th, filled from where the names already were
-- 149 leads carried a person under `owner` or `ask_for` while contact_name was
-- null on every single one — the column existed and the data was three feet
-- away in a field nothing rendered.
update public.leads
   set contact_name = btrim(coalesce(metadata_json ->> 'ask_for', metadata_json ->> 'owner'))
 where contact_name is null
   and coalesce(metadata_json ->> 'ask_for', metadata_json ->> 'owner') is not null
   and lower(btrim(coalesce(metadata_json ->> 'ask_for', metadata_json ->> 'owner')))
       not in ('unverified', 'unknown', 'n/a', 'na', 'none', 'tbd', '');

update public.leads
   set metadata_json = metadata_json - 'ask_for' - 'owner'
 where contact_name is not null
   and btrim(coalesce(metadata_json ->> 'ask_for', metadata_json ->> 'owner')) = contact_name;

-- ── import_leads learns the column ──────────────────────────────────────────
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
      nullif(trim(r ->> 'contact_name'), '') as contact_name,
      nullif(trim(r ->> 'phone'), '') as phone,
      public.normalize_phone(r ->> 'phone') as phone_normalized,
      -- A spreadsheet's "12 rooms" is a number with a word after it; anything
      -- that is not plainly countable is left for a human rather than guessed.
      case when (r ->> 'room_count') ~ '^\s*[0-9]{1,4}\s*$'
           then (btrim(r ->> 'room_count'))::int else null end as room_count,
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
  deduped as (
    select distinct on (phone_normalized) *
    from parsed
    where phone_normalized is not null
      and length(phone_normalized) >= 10
    order by phone_normalized, length(business_name) desc
  ),
  upserted as (
    insert into public.leads (
      workspace_id, business_name, contact_name, room_count, phone, phone_normalized,
      address, city, state, zip, website, email, notes, metadata_json
    )
    select
      ws, business_name, contact_name, room_count, phone, phone_normalized,
      address, city, state, zip, website, email, notes, metadata_json
    from deduped
    on conflict (workspace_id, phone_normalized) do update set
      business_name = excluded.business_name,
      phone         = excluded.phone,
      contact_name  = coalesce(excluded.contact_name, public.leads.contact_name),
      room_count    = coalesce(excluded.room_count, public.leads.room_count),
      address       = coalesce(excluded.address, public.leads.address),
      city          = coalesce(excluded.city, public.leads.city),
      state         = coalesce(excluded.state, public.leads.state),
      zip           = coalesce(excluded.zip, public.leads.zip),
      website       = coalesce(excluded.website, public.leads.website),
      email         = coalesce(excluded.email, public.leads.email),
      metadata_json = public.leads.metadata_json || excluded.metadata_json,
      updated_at    = now()
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
