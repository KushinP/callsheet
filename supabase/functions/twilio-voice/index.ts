/**
 * twilio-voice — the TwiML endpoint.
 *
 * Twilio hits this the moment the browser's Device.connect() fires, asking
 * what to do with the call. Two answers: bridge straight to the lead
 * (direct), or drop the agent into a conference the lead is invited into
 * afterwards (the "join me" flow).
 *
 * Public by design — Twilio cannot present a Supabase JWT — so every request
 * is authenticated by its X-Twilio-Signature instead.
 */
import { functionsBaseUrl, loadTwilioConfig, serviceClient } from '../_shared/db.ts'
import {
  candidateUrls,
  readFormParams,
  toE164,
  twimlResponse,
  verifyTwilioSignature,
  xmlEscape,
} from '../_shared/twilio.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

function reject(message: string, context?: Record<string, unknown>): Response {
  // Spoken to a real caller, so it must also be visible to us. Every one of
  // these ends a call in about four seconds and, unlogged, is indistinguishable
  // from Twilio's own "an application error has occurred".
  console.warn('twilio-voice rejected a call', { spoken: message, ...context })
  return twimlResponse(
    `<Say voice="Polly.Matthew">${xmlEscape(message)}</Say><Hangup/>`,
  )
}

/** Digits as the leads table stores them, matching normalize_phone() in SQL. */
function normalizeDigits(raw: string): string {
  return raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
}

/**
 * Someone is calling the number back.
 *
 * Ring the browser and, if one is configured, a fallback number in parallel —
 * whoever answers first wins, and Twilio only bills the leg that connects.
 * Anything unanswered falls through to voicemail, because a browser only rings
 * while a tab is open, which for a solo operator is a minority of the day.
 */
async function handleInbound(opts: {
  db: ReturnType<typeof serviceClient>
  params: Record<string, string>
  workspaceId: string
  config: { phoneNumber: string | null }
}): Promise<Response> {
  const { db, params, workspaceId } = opts
  const from = params.From ?? ''
  const digits = normalizeDigits(from)

  const [{ data: workspace }, { data: lead }, { data: members }] = await Promise.all([
    db.from('workspaces')
      .select('forward_to_number, record_inbound')
      .eq('id', workspaceId).maybeSingle(),
    digits
      ? db.from('leads').select('id, business_name')
          .eq('workspace_id', workspaceId).eq('phone_normalized', digits).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from('workspace_members').select('user_id').eq('workspace_id', workspaceId),
  ])

  // Log the call before ringing, so a caller who hangs up during the ring is
  // still a record of someone who tried to reach you.
  const { data: log, error: logError } = await db.from('dial_call_logs').insert({
    workspace_id: workspaceId,
    lead_id: lead?.id ?? null,
    business_name: lead?.business_name ?? null,
    phone: from,
    phone_normalized: digits,
    direction: 'inbound',
    mode: 'direct',
    call_status: 'ringing',
    parent_call_sid: params.CallSid ?? null,
    recorded: workspace?.record_inbound === true,
  }).select('id').single()

  // Not fatal — the call should still ring — but it means this callback will
  // never appear in the log, and silence made that impossible to notice.
  if (logError) console.error('inbound call could not be logged', logError.message)

  const logId = log?.id ?? ''
  const base = `${functionsBaseUrl()}/`
  const query = `ws=${encodeURIComponent(workspaceId)}&log=${encodeURIComponent(logId)}`
  const action = xmlEscape(`${base}twilio-voice?${query}&stage=voicemail`)
  const recordingUrl = xmlEscape(`${base}twilio-recording?${query}`)

  /*
   * The <Parameter>s are how the browser learns who is calling. An incoming
   * leg carries only From/To/CallSid, and that CallSid is the child leg's —
   * not the parent_call_sid this row was written under — so without these the
   * app can ring but cannot say whose callback it is, and cannot attach the
   * answered call to the row already logged above.
   */
  const clientParams =
    `<Parameter name="logId" value="${xmlEscape(logId)}"/>` +
    (lead?.id ? `<Parameter name="leadId" value="${xmlEscape(lead.id)}"/>` : '') +
    (lead?.business_name
      ? `<Parameter name="businessName" value="${xmlEscape(lead.business_name)}"/>`
      : '')

  const targets: string[] = (members ?? []).map(
    (m: { user_id: string }) =>
      `<Client><Identity>agent_${m.user_id.replace(/-/g, '')}</Identity>` +
      `${clientParams}</Client>`,
  )

  /*
   * Deliberately no per-target statusCallback. The browser and the mobile ring
   * in parallel, so whichever loses the race ends 'canceled' — and a callback
   * on the mobile leg writes that straight onto the inbound row, marking a call
   * you answered in the browser as missed. The <Dial action> below reports the
   * dial as a whole, which is the only thing that answers the question.
   */
  const forward = toE164(workspace?.forward_to_number ?? '')
  if (forward) {
    targets.push(`<Number>${xmlEscape(forward)}</Number>`)
  }

  console.log('inbound ringing', {
    from, logId, leadId: lead?.id ?? null,
    clients: (members ?? []).length, forward: Boolean(forward),
  })

  if (targets.length === 0) {
    // Nothing to ring: go straight to voicemail rather than dead air.
    return twimlResponse(voicemailBody(action, recordingUrl))
  }

  const record = workspace?.record_inbound
    ? `record="record-from-answer-dual" ` +
      `recordingStatusCallback="${recordingUrl}" ` +
      `recordingStatusCallbackEvent="completed" ` +
      `recordingStatusCallbackMethod="POST" `
    : ''

  return twimlResponse(
    `<Dial timeout="20" answerOnBridge="true" action="${action}" method="POST" ${record}` +
    `callerId="${xmlEscape(from)}">${targets.join('')}</Dial>`,
  )
}

/** The greeting and the recording, shared by both routes into voicemail. */
function voicemailBody(action: string, recordingUrl: string): string {
  return (
    `<Say voice="Polly.Matthew">Thanks for calling back. ` +
    `Please leave a message after the tone and we will get straight back to you.</Say>` +
    `<Record maxLength="120" playBeep="true" trim="trim-silence" ` +
    `recordingStatusCallback="${recordingUrl}" ` +
    `recordingStatusCallbackEvent="completed" ` +
    `recordingStatusCallbackMethod="POST" />` +
    `<Say voice="Polly.Matthew">We did not get that. Goodbye.</Say><Hangup/>`
  )
}

/**
 * The <Dial> action callback. Twilio posts here when the dial ends for any
 * reason; only an unanswered one should hear a voicemail prompt, or someone who
 * just finished talking would be asked to leave a message.
 *
 * It is also the only place that reliably learns whether an inbound call was
 * answered. Nothing else does: <Client> targets carry no statusCallback, and
 * the <Number> fallback only reports when a forward number is configured at
 * all — so without writing it here the row sits at 'ringing' forever and a
 * missed call is indistinguishable from one you took.
 */
async function voicemailTwiml(
  db: ReturnType<typeof serviceClient>,
  params: Record<string, string>,
  workspaceId: string,
  url: URL,
): Promise<Response> {
  const status = params.DialCallStatus
  const answered = status === 'completed' || status === 'answered'
  const logId = url.searchParams.get('log') ?? ''

  if (logId) {
    const duration = Number.parseInt(params.DialCallDuration ?? '', 10)
    await db.from('dial_call_logs').update({
      // 'no-answer', 'busy' and 'failed' arrive hyphen-free from DialCallStatus
      // except no-answer; map it rather than widening the enum.
      call_status: answered ? 'completed'
        : status === 'busy' ? 'busy'
        : status === 'failed' ? 'failed'
        : 'no_answer',
      ended_at: new Date().toISOString(),
      ...(Number.isFinite(duration) && duration > 0 ? { duration_seconds: duration } : {}),
    }).eq('id', logId).eq('workspace_id', workspaceId)
  }

  if (answered) return twimlResponse('<Hangup/>')

  const base = `${functionsBaseUrl()}/`
  const query = `ws=${encodeURIComponent(workspaceId)}&log=${encodeURIComponent(logId)}`
  return twimlResponse(voicemailBody(
    xmlEscape(`${base}twilio-voice?${query}&stage=voicemail`),
    xmlEscape(`${base}twilio-recording?${query}`),
  ))
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const workspaceId = url.searchParams.get('ws')

  if (!workspaceId) return reject('This dialer is not configured correctly.', { reqUrl: req.url })

  const params = await readFormParams(req)
  const db = serviceClient()
  const config = await loadTwilioConfig(db, workspaceId)

  if (!config) return reject('Twilio is not configured for this workspace.', { workspaceId })

  const valid = await verifyTwilioSignature({
    authToken: config.authToken,
    url: candidateUrls(req),
    params,
    signature: req.headers.get('X-Twilio-Signature'),
  })

  if (!valid) {
    // Log what we tried: a signature mismatch is almost always the request url
    // differing from the public one Twilio signed, and this makes that visible.
    console.warn('Rejected twilio-voice request with a bad signature', {
      workspaceId, reqUrl: req.url, tried: candidateUrls(req),
    })
    return new Response('Forbidden', { status: 403 })
  }

  const stage = url.searchParams.get('stage')

  console.log('twilio-voice', {
    stage,
    direction: params.Direction ?? null,
    hasLogId: Boolean(params.logId),
    from: params.From ?? null,
    to: params.To ?? null,
    callSid: params.CallSid ?? null,
  })

  // ── Inbound ───────────────────────────────────────────────────────────────
  // A browser-originated call arrives through the TwiML Application and always
  // carries the custom params the SDK sent. A callback to the number itself
  // carries none of them, which is how the two are told apart.
  if (stage === 'voicemail') {
    return await voicemailTwiml(db, params, workspaceId, url)
  }

  /*
   * The outbound <Dial> just ended. Normally that means the call is over and
   * hanging up is right. But if the call has been escalated to a conference in
   * the meantime, the lead has been moved into a room and this leg — the rep's
   * — needs to follow rather than drop.
   *
   * Reading the decision from the log rather than racing two redirects is what
   * makes this deterministic: twilio-conference writes conference_name BEFORE
   * it moves the lead, so by the time Twilio asks us this question the answer
   * is already recorded.
   */
  if (stage === 'after_dial') {
    const logId = url.searchParams.get('log') ?? ''
    if (!logId) return twimlResponse('<Hangup/>')

    const { data: log } = await db
      .from('dial_call_logs')
      .select('conference_name, mode, recorded')
      .eq('id', logId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (log?.mode !== 'conference' || !log?.conference_name) {
      return twimlResponse('<Hangup/>')
    }

    const base = `${functionsBaseUrl()}/`
    const query = `ws=${encodeURIComponent(workspaceId)}&log=${encodeURIComponent(logId)}`
    const recordingUrl = xmlEscape(`${base}twilio-recording?${query}`)

    // endConferenceOnExit on the REP only: they can drop the agent without
    // dropping the prospect, but when they leave the call is over. The
    // recording is started here for the same reason — exactly one leg asks for
    // it, so escalating cannot produce three overlapping recordings.
    return twimlResponse(
      `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false" ` +
      (log.recorded
        ? `record="record-from-start" ` +
          `recordingStatusCallback="${recordingUrl}" ` +
          `recordingStatusCallbackEvent="completed" `
        : '') +
      `>${xmlEscape(log.conference_name)}</Conference></Dial>`,
    )
  }

  if (!params.logId && params.Direction === 'inbound') {
    return await handleInbound({ db, params, workspaceId, config })
  }

  const logId = params.logId ?? ''
  const mode = params.mode === 'conference' ? 'conference' : 'direct'
  const parentCallSid = params.CallSid ?? null

  // Resolve the recording policy before any TwiML is built: session override
  // first, workspace default behind it. Fail CLOSED — a missing log row, or a
  // call placed without one, means do not record. Failing open on a compliance
  // switch is the wrong direction to be wrong in.
  let shouldRecord = false
  if (logId) {
    const { data: allowed, error: policyError } = await db.rpc('call_should_record', { log: logId })
    if (policyError) console.error('recording policy lookup failed', logId, policyError.message)
    shouldRecord = allowed === true
  }

  // Link the Twilio call to the log row the browser created a moment ago, so
  // the status and recording callbacks have something to update — and record
  // what was actually decided, so the log answers "was this recorded" on its
  // own rather than by re-deriving it from settings that may have since changed.
  if (logId && parentCallSid) {
    await db
      .from('dial_call_logs')
      .update({ parent_call_sid: parentCallSid, call_status: 'ringing', recorded: shouldRecord })
      .eq('id', logId)
      .eq('workspace_id', workspaceId)
  }

  // Built from SUPABASE_URL, never from req.url: inside the edge runtime req.url is
  // the proxy-internal address, so deriving callbacks from it points Twilio at a host
  // that does not resolve and the status/recording webhooks silently never arrive.
  const base = `${functionsBaseUrl()}/`
  const query = `ws=${encodeURIComponent(workspaceId)}&log=${encodeURIComponent(logId)}`
  const statusUrl = xmlEscape(`${base}twilio-status?${query}`)
  const recordingUrl = xmlEscape(`${base}twilio-recording?${query}`)

  if (mode === 'conference') {
    const room = params.conferenceName || `cs-${logId || parentCallSid}`
    return twimlResponse(
      `<Dial>` +
        `<Conference ` +
        `startConferenceOnEnter="true" ` +
        `endConferenceOnExit="true" ` +
        `beep="false" ` +
        (shouldRecord
          ? `record="record-from-start" ` +
            `recordingStatusCallback="${recordingUrl}" ` +
            `recordingStatusCallbackEvent="completed" `
          // Omit both together: a recording callback wired to a call that
          // produces no recording is dead configuration.
          : '') +
        `statusCallback="${statusUrl}&amp;event=conference" ` +
        `statusCallbackEvent="start end join leave" ` +
        `statusCallbackMethod="POST"` +
        `>${xmlEscape(room)}</Conference>` +
      `</Dial>`,
    )
  }

  const to = toE164(params.To ?? '')
  if (!to) return reject('That number is not valid.', { workspaceId, To: params.To })
  if (!config.phoneNumber) {
    return reject('No outbound phone number is configured.', { workspaceId })
  }

  // answerOnBridge keeps the agent's leg unanswered until the lead picks up,
  // which is what makes the locally generated ringback tone line up with
  // reality instead of talking over Twilio's own audio.
  return twimlResponse(
    `<Dial ` +
      `callerId="${xmlEscape(config.phoneNumber)}" ` +
      `answerOnBridge="true" ` +
      `timeout="30" ` +
      /*
       * Without an action url the rep's leg falls off the end of this document
       * the moment the <Dial> ends, and the browser call simply drops. That is
       * fine while a call is only ever two parties — but escalating to a
       * conference works by pulling the LEAD out of this bridge, which ends the
       * <Dial> and used to hang the rep up with it. The action gives that
       * moment somewhere to go.
       */
      `action="${xmlEscape(`${base}twilio-voice?${query}&stage=after_dial`)}" ` +
      `method="POST" ` +
      (shouldRecord
        ? `record="record-from-answer-dual" ` +
          `recordingStatusCallback="${recordingUrl}" ` +
          `recordingStatusCallbackEvent="completed" ` +
          `recordingStatusCallbackMethod="POST"`
        : '') +
    `>` +
      `<Number ` +
        `statusCallback="${statusUrl}&amp;event=child" ` +
        `statusCallbackEvent="initiated ringing answered completed" ` +
        `statusCallbackMethod="POST"` +
      `>${xmlEscape(to)}</Number>` +
    `</Dial>`,
  )
})
