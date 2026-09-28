/**
 * twilio-status — call progress webhook.
 *
 * Fires as the lead's leg moves through initiated → ringing → answered →
 * completed. The "completed" event carries the real talk time, which is what
 * the call log shows as duration.
 */
import { loadTwilioConfig, serviceClient } from '../_shared/db.ts'
import { candidateUrls, readFormParams, verifyTwilioSignature } from '../_shared/twilio.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

const STATUS_MAP: Record<string, string> = {
  queued: 'initiated',
  initiated: 'initiated',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  answered: 'in_progress',
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  'no-answer': 'no_answer',
  canceled: 'canceled',
}

// A call that never reached a human gets a disposition automatically, so the
// agent only ever hand-dispositions calls that actually connected.
const AUTO_OUTCOME: Record<string, string> = {
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'bad_number',
  canceled: 'no_answer',
}

const TERMINAL = new Set(['completed', 'busy', 'failed', 'no_answer', 'canceled'])

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
    console.warn('Rejected twilio-status request with a bad signature', {
      workspaceId, reqUrl: req.url, tried: candidateUrls(req),
    })
    return new Response('Forbidden', { status: 403 })
  }

  // Conference lifecycle events are informational; nothing to record on the log.
  if (url.searchParams.get('event') === 'conference') {
    return new Response(null, { status: 204 })
  }

  const rawStatus = params.CallStatus ?? ''
  const mapped = STATUS_MAP[rawStatus]
  if (!mapped) return new Response(null, { status: 204 })

  // Either the leg this callback was wired to (log id in the url), or the
  // inbound number's own callback, which has none — the row did not exist when
  // the number was configured — and is matched on the parent CallSid instead.
  const lookup = db
    .from('dial_call_logs')
    .select('id, outcome, duration_seconds, call_status, direction')
    .eq('workspace_id', workspaceId)
  const { data: existing } = await (logId
    ? lookup.eq('id', logId)
    : lookup.eq('parent_call_sid', params.CallSid ?? '').eq('direction', 'inbound')
  ).maybeSingle()

  if (!existing) return new Response(null, { status: 204 })

  /*
   * The inbound number's own callback, matched on the parent CallSid because
   * the row did not exist when the number was configured.
   *
   * Its CallStatus is useless as an answered/missed signal: Twilio answers
   * every inbound call itself in order to run the TwiML, so it reports
   * 'completed' whether you spoke for ten minutes or the caller gave up after
   * two rings. Taking it at face value would mark every inbound call answered.
   *
   * What it does mark reliably is the end of the call. So the question it
   * settles is a different one: did anything ever resolve this row? The <Dial>
   * action writes 'completed' or 'no_answer' the moment the dial ends. If the
   * row is still sitting at 'ringing' when the call is over, that action never
   * ran — which happens precisely when the CALLER hangs up mid-ring, the one
   * missed call no other webhook reports.
   */
  if (!logId) {
    if (!TERMINAL.has(mapped)) return new Response(null, { status: 204 })
    if (existing.call_status !== 'ringing' && existing.call_status !== 'initiated') {
      return new Response(null, { status: 204 })
    }

    const { error: hangupError } = await db
      .from('dial_call_logs')
      .update({ call_status: 'no_answer', ended_at: new Date().toISOString() })
      .eq('id', existing.id)
      .eq('workspace_id', workspaceId)

    if (hangupError) {
      console.error('Failed to close abandoned inbound call', existing.id, hangupError.message)
    }
    return new Response(null, { status: 204 })
  }

  const update: Record<string, unknown> = { call_status: mapped }

  // This is the child (lead) leg, so CallSid is the leg that actually rang a
  // phone — the one worth showing next to the call in the log.
  if (params.CallSid) update.twilio_call_sid = params.CallSid

  const duration = Number.parseInt(params.CallDuration ?? '', 10)
  if (Number.isFinite(duration) && duration > 0) update.duration_seconds = duration

  if (TERMINAL.has(mapped)) {
    update.ended_at = new Date().toISOString()
    /*
     * Outbound only. On an outbound call the outcome says what happened when
     * we rang them, and 'no answer' is a real disposition. On an inbound one
     * it would be recording that WE failed to pick up — and since an outcome
     * is what marks a missed call as dealt with, auto-setting it would tick
     * off every missed call the instant it was missed.
     *
     * Never overwrite a disposition an agent already chose.
     */
    if (
      existing.direction !== 'inbound' &&
      !existing.outcome &&
      AUTO_OUTCOME[rawStatus]
    ) {
      update.outcome = AUTO_OUTCOME[rawStatus]
    }
  }

  const { error } = await db
    .from('dial_call_logs')
    .update(update)
    .eq('id', existing.id)
    .eq('workspace_id', workspaceId)

  if (error) console.error('Failed to update call log', existing.id, error.message)

  return new Response(null, { status: 204 })
})
