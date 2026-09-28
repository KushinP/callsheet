/**
 * twilio-recording — recording-ready webhook.
 *
 * Twilio finishes processing a recording seconds after the call ends, so the
 * URL arrives separately from the call status. We store the SID rather than a
 * playable link; the recording-proxy function is what actually streams audio,
 * because the raw Twilio media URL requires account credentials.
 */
import { env, functionsBaseUrl, loadTwilioConfig, serviceClient } from '../_shared/db.ts'
import { candidateUrls, readFormParams, verifyTwilioSignature } from '../_shared/twilio.ts'

declare const Deno: {
  serve(handler: (req: Request) => Promise<Response>): void
  env: { get(key: string): string | undefined }
}
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const workspaceId = url.searchParams.get('ws')
  const logId = url.searchParams.get('log')

  if (!workspaceId) return new Response('Missing workspace', { status: 400 })

  const params = await readFormParams(req)
  const db = serviceClient()
  const config = await loadTwilioConfig(db, workspaceId)
  if (!config) return new Response('Not configured', { status: 404 })

  const valid = await verifyTwilioSignature({
    authToken: config.authToken,
    url: candidateUrls(req),
    params,
    signature: req.headers.get('X-Twilio-Signature'),
  })
  if (!valid) {
    // Log what we tried: a signature mismatch is almost always the request url
    // differing from the public one Twilio signed, and this makes that visible.
    console.warn('Rejected twilio-recording request with a bad signature', {
      workspaceId, reqUrl: req.url, tried: candidateUrls(req),
    })
    return new Response('Forbidden', { status: 403 })
  }

  if (params.RecordingStatus && params.RecordingStatus !== 'completed') {
    return new Response(null, { status: 204 })
  }

  const recordingSid = params.RecordingSid
  if (!recordingSid) return new Response(null, { status: 204 })

  const recordingDuration = Number.parseInt(params.RecordingDuration ?? '', 10)

  const update = {
    recording_sid: recordingSid,
    recording_url: params.RecordingUrl ?? null,
    recording_duration: Number.isFinite(recordingDuration) ? recordingDuration : null,
  }

  // Normally the log id rides in the query string. Conference recordings can
  // arrive without it, so fall back to matching on the parent call SID.
  const query = db.from('dial_call_logs').update(update).eq('workspace_id', workspaceId)
  const { error } = logId
    ? await query.eq('id', logId)
    : await query.eq('parent_call_sid', params.CallSid ?? '')

  if (error) console.error('Failed to attach recording', recordingSid, error.message)

  // Hand off the slow part — download, offload to our bucket, transcribe — to a
  // separate invocation. Twilio wants a fast 2xx here, and waitUntil is required
  // because a bare floating promise is not guaranteed to run once this isolate
  // returns.
  if (logId) {
    const secret = Deno.env.get('INTERNAL_FN_SECRET')
    if (secret) {
      EdgeRuntime.waitUntil(
        fetch(`${functionsBaseUrl()}/process-recording`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
          body: JSON.stringify({ workspaceId, logId, recordingSid }),
        }).catch((e) => console.error('process-recording dispatch failed', e)),
      )
    } else {
      console.warn('INTERNAL_FN_SECRET not set — recording will not be offloaded or transcribed')
    }
  }

  return new Response(null, { status: 204 })
})
