-- ============================================================================
-- leads.outcome means "how the last call went", so the database should decide
-- which call that is.
--
-- Both writers stamped it with whichever call they happened to be editing.
-- Re-dispositioning a call from three weeks ago therefore overwrote the lead's
-- current outcome with a stale one — and the outcome editor now sits in the
-- lead panel beside the call history, which makes that a normal thing to do
-- rather than an obscure one.
--
-- Derived here rather than patched in two callers, because there is no version
-- of this that two independent writers get right forever.
-- ============================================================================
create or replace function public.sync_lead_latest_outcome()
returns trigger
language plpgsql
set search_path = public
as $$
declare target uuid;
begin
  target := coalesce(new.lead_id, old.lead_id);
  if target is null then return coalesce(new, old); end if;

  update public.leads l
     set outcome = (
       select c.outcome
       from public.dial_call_logs c
       where c.lead_id = target and c.outcome is not null
       order by c.called_at desc, c.id desc
       limit 1
     )
   where l.id = target
     -- A do-not-call flag is a judgement about the lead that outlives any one
     -- call, so it is never recomputed away.
     and l.do_not_call = false;

  return coalesce(new, old);
end;
$$;

drop trigger if exists dial_call_logs_sync_lead_outcome on public.dial_call_logs;
create trigger dial_call_logs_sync_lead_outcome
  after insert or delete or update of outcome, lead_id, called_at
  on public.dial_call_logs
  for each row execute function public.sync_lead_latest_outcome();

update public.leads l
   set outcome = (
     select c.outcome from public.dial_call_logs c
     where c.lead_id = l.id and c.outcome is not null
     order by c.called_at desc, c.id desc limit 1
   )
 where l.do_not_call = false;
