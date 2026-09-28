-- ============================================================================
-- Transcripts, and getting recordings off Twilio.
--
-- call_transcripts already existed but nothing ever wrote to it. Keep it 1:1
-- with the call (the unique(call_id) constraint stays): src/hooks/useCalls.ts
-- embeds it and CallLog reads `call_transcripts[0]`, so making it many-rows
-- would silently render only the first fragment with no type error.
-- ============================================================================

alter table public.call_transcripts
  add column engine text,
  add column language text default 'en',
  add column word_count integer,
  add column cost_usd numeric(10, 6),
  -- Speaker attribution is inferred by the model when the audio is downmixed to
  -- mono. Flagging low confidence beats silently mislabelling who said what.
  add column speaker_confidence text
    check (speaker_confidence in ('high', 'low')),
  add column updated_at timestamptz not null default now();

alter table public.call_transcripts
  drop constraint if exists call_transcripts_source_check;
alter table public.call_transcripts
  add constraint call_transcripts_source_check
    check (source in ('manual', 'llm_audio', 'deepgram', 'groq', 'twilio_realtime'));

create trigger call_transcripts_touch before update on public.call_transcripts
  for each row execute function public.touch_updated_at();

create index call_transcripts_workspace_idx
  on public.call_transcripts (workspace_id, created_at desc);

-- Full-text search over transcripts, so "which calls mentioned pricing" is a
-- query rather than Claude reading every row.
alter table public.call_transcripts
  add column search_tsv tsvector
  generated always as (to_tsvector('english', coalesce(transcript_text, ''))) stored;

create index call_transcripts_search_idx
  on public.call_transcripts using gin (search_tsv);

-- ---------------------------------------------------------------------------
-- Recording storage.
--
-- Twilio bills storage per minute per month for the whole retained library, so
-- the recording is copied to our own bucket and deleted there. storage_key is
-- the object we own; recording_sid stays for reference and to detect rows that
-- predate the offload.
-- ---------------------------------------------------------------------------
alter table public.dial_call_logs
  add column storage_key text,
  add column storage_provider text
    check (storage_provider in ('r2', 's3', 'supabase')),
  add column recording_bytes integer,
  add column twilio_recording_deleted_at timestamptz,
  -- Set when transcription has been attempted, so a permanent failure is not
  -- retried forever and a success is never paid for twice.
  add column transcribed_at timestamptz,
  add column transcription_error text;

create index dial_call_logs_pending_transcription_idx
  on public.dial_call_logs (workspace_id, called_at desc)
  where recording_sid is not null and transcribed_at is null;

-- ---------------------------------------------------------------------------
-- Search transcripts across the workspace.
-- ---------------------------------------------------------------------------
create or replace function public.search_transcripts(
  ws uuid,
  q text,
  max_results integer default 20
)
returns table (
  call_id uuid,
  business_name text,
  phone text,
  outcome public.call_outcome,
  called_at timestamptz,
  duration_seconds integer,
  snippet text,
  rank real
)
language plpgsql
security invoker
stable
set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  select
    c.id,
    c.business_name,
    c.phone,
    c.outcome,
    c.called_at,
    c.duration_seconds,
    ts_headline('english', t.transcript_text, websearch_to_tsquery('english', q),
                'MaxFragments=3, MinWords=8, MaxWords=25, StartSel=**, StopSel=**') as snippet,
    ts_rank(t.search_tsv, websearch_to_tsquery('english', q)) as rank
  from public.call_transcripts t
  join public.dial_call_logs c on c.id = t.call_id
  where t.workspace_id = ws
    and t.search_tsv @@ websearch_to_tsquery('english', q)
  order by rank desc, c.called_at desc
  limit greatest(least(max_results, 100), 1);
end;
$$;

revoke execute on function public.search_transcripts(uuid, text, integer) from public, anon;
grant  execute on function public.search_transcripts(uuid, text, integer) to authenticated, service_role;
