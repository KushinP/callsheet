-- ============================================================================
-- Booking, incoming calls, and the spend ceiling.
--
-- Catch-up migration — see 20260905000009 for why.
-- ============================================================================

alter table public.workspaces
  -- Scheduling link opened when a call is dispositioned as an appointment.
  add column if not exists calendly_url text,
  -- A spend ceiling in the only unit that drives cost: connected talk-minutes.
  add column if not exists monthly_minute_budget integer,
  -- Rung in parallel with the browser when a callback arrives, because a
  -- browser only rings while a tab is open.
  add column if not exists forward_to_number text,
  -- Pulled onto a live call by the "Add agent" button.
  add column if not exists voice_agent_number text,
  -- Separate from recording_enabled and OFF by default: an inbound caller was
  -- told nothing and did not choose to be on a recorded line.
  add column if not exists record_inbound boolean not null default false,
  -- Opt-in. Pointing a number's voice webhook at this app is a destructive edit
  -- to something that may already be answering, and must never be a silent side
  -- effect of saving Twilio credentials.
  add column if not exists answer_inbound boolean not null default false;

-- What the number's voice webhook pointed at before Callsheet claimed it, so a
-- displaced voice agent or IVR is both visible and recoverable.
alter table public.workspace_twilio_settings
  add column if not exists previous_voice_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspaces_calendly_url_valid'
  ) then
    -- Only a real scheduling link belongs here. A typo would render an empty
    -- iframe with no explanation, which is worse than refusing it.
    alter table public.workspaces add constraint workspaces_calendly_url_valid check (
      calendly_url is null
      or calendly_url ~ '^https://calendly\.com/[A-Za-z0-9._~%/-]+$'
    );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'workspaces_minute_budget_positive'
  ) then
    alter table public.workspaces add constraint workspaces_minute_budget_positive
      check (monthly_minute_budget is null or monthly_minute_budget > 0);
  end if;
end $$;
