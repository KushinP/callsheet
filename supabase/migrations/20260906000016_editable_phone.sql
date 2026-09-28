-- ============================================================================
-- Editing a lead by hand, safely.
--
-- Until now the only writer of leads.phone was import_leads(), which computed
-- phone_normalized alongside it in the same statement. The moment a human can
-- correct a phone number in the UI that pairing breaks: a plain UPDATE touches
-- phone and leaves phone_normalized holding the old digits.
--
-- That divergence is silent and expensive. phone_normalized is what inbound
-- caller-ID matching looks the caller up by, what call search filters on, and
-- what the (workspace_id, phone_normalized) unique constraint dedupes on — so
-- a corrected number would keep answering to the wrong one, and re-importing
-- the corrected number would create a second row for the same business.
--
-- A trigger, rather than making every caller remember: the invariant is now
-- "phone_normalized is always normalize_phone(phone)", with no exceptions to
-- forget. It fires on every insert and update rather than only when `phone`
-- appears in the SET list, so no write path can route around it.
-- ============================================================================

create or replace function public.normalize_lead_phone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.phone := nullif(btrim(new.phone), '');
  new.phone_normalized := public.normalize_phone(new.phone);

  -- import_leads() drops short numbers before it ever reaches the table; a
  -- hand edit has no such filter, and a lead you cannot dial is not a lead.
  -- Raising here beats the NOT NULL violation the row would hit anyway,
  -- because this one says what to do about it.
  if new.phone_normalized is null or length(new.phone_normalized) < 10 then
    raise exception
      'A lead needs a phone number with at least 10 digits — got %',
      coalesce(new.phone, '(empty)')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists leads_normalize_phone on public.leads;
create trigger leads_normalize_phone
  before insert or update on public.leads
  for each row execute function public.normalize_lead_phone();

revoke execute on function public.normalize_lead_phone() from public, anon, authenticated;
