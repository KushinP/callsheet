/**
 * process-recording — everything that happens to a call's audio after hangup.
 *
 * Three jobs, in order, each independently skippable:
 *   1. Fetch the recording bytes from Twilio.
 *   2. Copy them to our own bucket and delete Twilio's copy. Twilio bills
 *      storage per minute PER MONTH for the whole retained library, so leaving
 *      recordings there is a bill that compounds forever.
 *   3. Transcribe, and store the transcript.
 *
 * Runs as its own invocation rather than inline in twilio-recording: Twilio
 * wants a fast 2xx on its webhook, and a multi-second download plus a model
 * call is not that.
 *
 * Not reachable by users — authenticated on a shared internal secret, since
 * there is no caller JWT on a server-to-server dispatch.
 */
import { env, serviceClient, loadTwilioConfig } from '../_shared/db.ts'
import { json, preflight } from '../_shared/http.ts'
import { basicAuthHeader, recordingMediaUrl } from '../_shared/twilio.ts'
import { SttUnavailableError, sttAvailable, transcribeAudio } from '../_shared/llm.ts'
import { traceScriptPath, type ScriptBlock } from '../_shared/scriptPath.ts'
import { putObject, recordingKey, storageAvailable } from '../_shared/storage.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

/**
 * A voicemail greeting is ~25 seconds of a recorded message nobody will read.
 * Transcribing every one of them would add roughly a third to the volume for
 * material with no value, so only calls that reached a human get transcribed.
 */
const MIN_TRANSCRIBE_SECONDS = 20

/**
 * Supabase edge functions get 150s wall-clock on the free plan (400s on Pro),
 * and this function has to download the audio, push it to R2, AND transcribe it
 * inside that. Bound the transcription explicitly so a slow one fails with a
 * readable error instead of the platform killing the isolate mid-write, which
 * would leave the row marked neither done nor failed.
 *
 * Encoding is not the constraint — base64 of a 30-minute recording takes ~200ms,
 * well inside the 2s CPU budget, and Gemini accepts inline payloads up to 100MB.
 * Time and memory are what actually run out.
 */
const TRANSCRIBE_TIMEOUT_MS = 100_000

/**
 * 256MB of memory has to hold the raw bytes plus a base64 string (UTF-16, so
 * roughly 2.7x the audio size on its own). ~45 minutes is the point where that
 * stops being comfortable. Longer calls are recorded and stored, just not
 * transcribed automatically.
 */
const MAX_TRANSCRIBE_SECONDS = 45 * 60
const CONNECTED_OUTCOMES = [
  'connected_dm', 'connected_gk', 'connected_other',
  'appointment_set', 'callback_requested', 'not_interested', 'do_not_call',
]

function worthTranscribing(outcome: string | null, duration: number): boolean {
  if (outcome && CONNECTED_OUTCOMES.includes(outcome)) return true
  return duration >= MIN_TRANSCRIBE_SECONDS
}

/** Twilio reports the recording ready slightly before the media is fetchable. */
async function fetchRecording(url: string, auth: string): Promise<Uint8Array> {
  const delays = [0, 2000, 5000, 10000]
  let lastStatus = 0

  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    const res = await fetch(url, { headers: { Authorization: auth } })
    if (res.ok) return new Uint8Array(await res.arrayBuffer())
    lastStatus = res.status
    // Anything other than "not there yet" will not fix itself.
    if (res.status !== 404) break
  }

  throw new Error(`Could not fetch recording (HTTP ${lastStatus})`)
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  if (req.headers.get('X-Internal-Secret') !== env('INTERNAL_FN_SECRET')) {
    return json({ error: 'forbidden' }, 403)
  }

  const { workspaceId, logId, recordingSid } = await req.json() as {
    workspaceId?: string; logId?: string; recordingSid?: string
  }
  if (!workspaceId || !logId || !recordingSid) {
    return json({ error: 'workspaceId, logId and recordingSid are required' }, 400)
  }

  const db = serviceClient()
  const config = await loadTwilioConfig(db, workspaceId)
  if (!config) return json({ error: 'twilio_not_configured' }, 409)

  const { data: call, error: callError } = await db
    .from('dial_call_logs')
    .select('id, outcome, duration_seconds, recording_duration, called_at, transcribed_at, storage_key, script_id')
    .eq('id', logId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (callError) return json({ error: callError.message }, 500)

  if (!call) {
    // The row is written before the call is placed, so a missing one was
    // deleted while this recording was still on its way. Deleting a call
    // deletes its audio — finish that, rather than leave Twilio billing for a
    // recording nothing points at.
    const del = await fetch(recordingMediaUrl(config.accountSid, recordingSid, 'json'), {
      method: 'DELETE',
      headers: { Authorization: basicAuthHeader(config.accountSid, config.authToken) },
    })
    return json({ error: 'call_not_found', twilio_copy_deleted: del.ok }, 404)
  }

  // Idempotent: the callback can fire more than once, and paying twice to
  // transcribe the same audio is pure waste.
  if (call.transcribed_at) {
    return json({ ok: true, skipped: 'already_processed' })
  }

  const result: Record<string, unknown> = { call_id: logId }

  try {
    const bytes = await fetchRecording(
      recordingMediaUrl(config.accountSid, recordingSid),
      basicAuthHeader(config.accountSid, config.authToken),
    )
    result.bytes = bytes.length

    // ── 1. Offload, then drop Twilio's copy ────────────────────────────────
    if (storageAvailable()) {
      const key = recordingKey(workspaceId, logId, call.called_at)
      await putObject({ key, body: bytes, contentType: 'audio/mpeg' })

      // Only delete Twilio's copy once ours is durably stored.
      const del = await fetch(
        recordingMediaUrl(config.accountSid, recordingSid, 'json'),
        {
          method: 'DELETE',
          headers: { Authorization: basicAuthHeader(config.accountSid, config.authToken) },
        },
      )

      await db.from('dial_call_logs').update({
        storage_key: key,
        storage_provider: 'r2',
        recording_bytes: bytes.length,
        twilio_recording_deleted_at: del.ok ? new Date().toISOString() : null,
      }).eq('id', logId)

      result.stored = key
      result.twilio_copy_deleted = del.ok
      if (!del.ok) result.delete_warning = `Twilio delete returned ${del.status}`
    } else {
      result.stored = false
      result.note = 'R2 not configured — recording left on Twilio, where storage bills monthly'
    }

    // ── 2. Transcribe ─────────────────────────────────────────────────────
    if (!sttAvailable()) {
      await db.from('dial_call_logs').update({
        transcribed_at: new Date().toISOString(),
        transcription_error: 'no_stt_key',
      }).eq('id', logId)
      return json({ ...result, transcribed: false, reason: 'no_stt_key' })
    }

    // recording_duration is the length of the audio; duration_seconds is billed
    // talk time. They differ, and both the worth-it check and the time budget
    // care about how much audio there actually is.
    const audioSeconds = call.recording_duration ?? call.duration_seconds ?? 0

    if (!worthTranscribing(call.outcome, audioSeconds)) {
      await db.from('dial_call_logs').update({
        transcribed_at: new Date().toISOString(),
        transcription_error: 'not_worth_transcribing',
      }).eq('id', logId)
      return json({ ...result, transcribed: false, reason: 'too_short_or_never_connected' })
    }

    if (audioSeconds > MAX_TRANSCRIBE_SECONDS) {
      await db.from('dial_call_logs').update({
        transcribed_at: new Date().toISOString(),
        transcription_error: `too_long_to_transcribe (${Math.round(audioSeconds / 60)} min)`,
      }).eq('id', logId)
      return json({
        ...result,
        transcribed: false,
        reason: 'too_long',
        hint: 'Recording is stored and playable; it was too long to transcribe within the function time limit.',
      })
    }

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TRANSCRIBE_TIMEOUT_MS)
    let stt
    try {
      stt = await transcribeAudio({
        bytes,
        mimeType: 'audio/mpeg',
        durationSeconds: audioSeconds,
        signal: abort.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (stt.transcript.trim()) {
      await db.from('call_transcripts').upsert({
        call_id: logId,
        workspace_id: workspaceId,
        transcript_text: stt.transcript,
        source: stt.provider === 'gemini' ? 'llm_audio' : stt.provider,
        engine: stt.engine,
        word_count: stt.transcript.split(/\s+/).filter(Boolean).length,
        cost_usd: stt.costUsd,
        speaker_confidence: stt.speakerConfidence,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'call_id' })
    }

    /*
     * Walk the transcript against the script the call was worked from. Done
     * here rather than on read because it depends on the script AS IT WAS —
     * editing a block later must not silently rewrite the history of calls
     * that ran under the old wording.
     */
    let scriptPath: unknown = null
    if (call.script_id && stt.transcript.trim()) {
      const { data: script } = await db
        .from('call_scripts')
        .select('blocks, entry_block_id')
        .eq('id', call.script_id)
        .maybeSingle()

      if (script?.entry_block_id && Array.isArray(script.blocks)) {
        try {
          scriptPath = traceScriptPath(
            stt.transcript,
            script.blocks as ScriptBlock[],
            script.entry_block_id as string,
            stt.speakerConfidence,
          )
        } catch (e) {
          // A malformed script is not a reason to lose the transcript.
          console.warn('script path trace failed', logId, (e as Error).message)
        }
      }
    }

    await db.from('dial_call_logs').update({
      transcribed_at: new Date().toISOString(),
      transcription_error: null,
      ...(scriptPath ? { script_path: scriptPath } : {}),
    }).eq('id', logId)

    return json({
      ...result,
      transcribed: true,
      engine: stt.engine,
      turns: stt.turns.length,
      script_path: scriptPath ? 'traced' : null,
      speaker_confidence: stt.speakerConfidence,
      cost_usd: stt.costUsd,
    })
  } catch (error) {
    const err = error as Error & { name?: string }
    const message = error instanceof SttUnavailableError
      ? 'no_stt_key'
      : err?.name === 'AbortError' || err?.name === 'TimeoutError'
      ? `transcription_timed_out after ${TRANSCRIBE_TIMEOUT_MS / 1000}s`
      : err?.message ?? 'unknown error'

    console.error('process-recording failed', logId, message)

    // Record the failure so it is visible and not retried in a loop.
    await db.from('dial_call_logs').update({
      transcribed_at: new Date().toISOString(),
      transcription_error: message.slice(0, 300),
    }).eq('id', logId)

    return json({ ...result, error: message }, 200)
  }
})
