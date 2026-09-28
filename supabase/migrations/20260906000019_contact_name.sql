-- ============================================================================
-- The human you are actually calling.
--
-- A lead held a business and a number but nobody's name, so "who do I ask
-- for" lived in free-text notes or in a brief — neither of which the script
-- prompter, the table, or a filter can read.
-- ============================================================================

alter table public.leads add column if not exists contact_name text;

-- search_blob is a stored generated column, and a generated expression cannot
-- be altered in place — it has to be dropped and rebuilt, taking its index
-- with it. Worth it: searching a list of inns by the innkeeper's name is one
-- of the two ways anyone looks a lead up.
drop index if exists public.leads_search_idx;
alter table public.leads drop column if exists search_blob;

alter table public.leads
  add column search_blob text
  generated always as (
    lower(
      coalesce(business_name, '') || ' ' ||
      coalesce(contact_name, '') || ' ' ||
      coalesce(phone, '') || ' ' ||
      coalesce(phone_normalized, '') || ' ' ||
      coalesce(city, '') || ' ' ||
      coalesce(state, '') || ' ' ||
      coalesce(address, '')
    )
  ) stored;

create index leads_search_idx on public.leads using gin (search_blob gin_trgm_ops);

-- import_leads() learns the column, so a CSV carrying a contact and the MCP
-- create_leads path both land it in a real column instead of metadata_json.
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
      workspace_id, business_name, contact_name, phone, phone_normalized,
      address, city, state, zip, website, email, notes, metadata_json
    )
    select
      ws, business_name, contact_name, phone, phone_normalized,
      address, city, state, zip, website, email, notes, metadata_json
    from deduped
    on conflict (workspace_id, phone_normalized) do update set
      business_name = excluded.business_name,
      phone         = excluded.phone,
      -- coalesce, like every other optional field: a re-import with a blank
      -- contact column must not wipe a name someone learned on a call.
      contact_name  = coalesce(excluded.contact_name, public.leads.contact_name),
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
