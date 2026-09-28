-- ============================================================================
-- Let members delete call logs.
--
-- dial_call_logs deliberately shipped without a delete policy — call history is
-- a record you normally want to keep. But test calls, misdials and duplicates
-- accumulate, and there was no way to clear them.
-- ============================================================================

create policy "call logs deletable by members" on public.dial_call_logs
  for delete to authenticated using (public.is_workspace_member(workspace_id));

-- call_transcripts cascades from dial_call_logs, so a deleted call takes its
-- transcript with it regardless. This is for deleting a transcript on its own.
create policy "transcripts deletable by members" on public.call_transcripts
  for delete to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Keep the lead's counters honest.
--
-- touch_lead_on_call() increments call_count and stamps last_called_at on
-- insert. Without the mirror image on delete, removing a call leaves the lead
-- claiming calls that no longer exist, and a last_called_at pointing at a
-- deleted row — which would then wrongly exclude that lead from a
-- "not called since" session filter.
--
-- Recompute from what actually remains rather than decrementing, so the value
-- is correct even after a bulk delete.
-- ---------------------------------------------------------------------------
create or replace function public.recount_lead_after_call_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.lead_id is not null then
    update public.leads l
       set call_count = coalesce(stats.n, 0),
           last_called_at = stats.last_at,
           -- A lead with no calls left goes back to being untouched, unless it
           -- was disqualified — that is a judgement about the lead, not an
           -- artefact of the call history.
           status = case
             when coalesce(stats.n, 0) = 0 and l.status = 'in_progress' then 'new'
             else l.status
           end
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

create trigger dial_call_logs_recount_lead
  after delete on public.dial_call_logs
  for each row execute function public.recount_lead_after_call_delete();

revoke execute on function public.recount_lead_after_call_delete()
  from public, anon, authenticated;
