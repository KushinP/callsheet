-- ============================================================================
-- What a call sounded like, from the browser's side.
--
-- "Muffled and hard to hear" had nothing behind it but a transcript: on the
-- 7 Sep test call the other end said the rep sounded "very buzzy and muffled",
-- and nothing recorded which microphone was in use, which codec carried the
-- call, or whether the connection was dropping packets. The browser knows all
-- of it. The log now keeps it, so the next report is diagnosed, not guessed.
--
-- jsonb rather than columns: these are diagnostics read one call at a time, and
-- the set of warnings Twilio's SDK can raise is theirs to extend.
-- ============================================================================
alter table public.dial_call_logs add column if not exists quality jsonb;

comment on column public.dial_call_logs.quality is
  'Browser-side audio diagnostics: input and output device, codec, bluetooth_input, SDK warnings, MOS and packet loss.';
