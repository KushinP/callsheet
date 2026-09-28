-- ============================================================================
-- Two switches that never controlled anything.
--
-- dial_call_logs.transcribe and calling_sessions.transcription_enabled were
-- added together and read by nothing, ever. What actually decides whether a
-- call is transcribed lives in process-recording: it needs a recording, at
-- least 20 seconds of audio (below that it is a voicemail greeting), an
-- outcome that means a human picked up, and under 45 minutes of it.
--
-- The evidence they were dead is on the record: this morning's six-minute call
-- has transcribe = false and a 4,945-character transcript.
--
-- Worse than useless, because a boolean named `transcribe` sitting on a call
-- log is a promise that setting it does something. Dropping them means the
-- schema stops describing a control that does not exist.
-- ============================================================================

alter table public.dial_call_logs   drop column if exists transcribe;
alter table public.calling_sessions drop column if exists transcription_enabled;
