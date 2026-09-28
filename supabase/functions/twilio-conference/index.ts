/**
 * twilio-conference — the "join me" leg.
 *
 * In conference mode the agent's browser lands in an empty room first. This
 * dials the lead and drops them into that same room, which is what makes
 * warm transfers and bringing a colleague onto the line possible.
 */
import { functionsBaseUrl, HttpError, loadTwilioConfig, requireMember, serviceClient } from '../_shared/db.ts'
import { errorResponse, json, preflight } from '../_shared/http.ts'
import { toE164, twilioRequest, xmlEscape } from '../_shared/twilio.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

/**
 * Turns a live two-party call into a conference and pulls a third party in.
 *
 * A <Dial> to a number cannot gain a participant — the shape is fixed once the
 * call is up. So both existing legs get redirected into a freshly named
 * conference room, and the third party is dialled into the same room.
 *
 * Both redirects are issued together: moving one leg before the other leaves
 * whoever moved first listening to silence in an empty room, and on a live
 * sales call that gap is the whole cost of the manoeuvre.
 */
async function escalate(
  req: Request,
  body: { workspaceId?: string; logId?: string; to?: string },
): Promise<Response> {
  if (!body.workspaceId) throw new HttpError('workspaceId is required')
  if (!body.logId) throw new HttpError('logId is required')

  await requireMember(req, body.workspaceId)

  const db = serviceClient()
  const config = await loadTwilioConfig(db, body.workspaceId)
  if (!config?.phoneNumber) {
    throw new HttpError('Twilio is not configured for this workspace.', 409)
  }

  const { data: log } = await db
    .from('dial_call_logs')
    .select('id, parent_call_sid, twilio_call_sid, conference_name, recorded')
    .eq('id', body.logId)
    .eq('workspace_id', body.workspaceId)
    .maybeSingle()

  if (!log) throw new HttpError('That call is not in this workspace.', 404)
  if (!log.parent_call_sid) {
    throw new HttpError('That call has not connected yet.', 409)
  }

  const { data: ws } = await db
    .from('workspaces')
    .select('voice_agent_number')
    .eq('id', body.workspaceId)
    .maybeSingle()

  // An explicit number wins; otherwise the workspace's saved agent number.
  const target = toE164(body.to || ws?.voice_agent_number || '')
  if (!target) {
    throw new HttpError(
      'No number to add. Set a voice agent number in Settings, or pass one.',
      409,
    )
  }

  const room = log.conference_name ?? `cs-${crypto.randomUUID().slice(0, 12)}`
  const query = `ws=${encodeURIComponent(body.workspaceId)}&log=${encodeURIComponent(log.id)}`
  const recordingUrl = `${functionsBaseUrl()}/twilio-recording?${query}`

  // Only the first leg to arrive should start the recording, and the room must
  // outlive any single participant leaving — otherwise the agent hanging up
  // ends the call with the lead.
  const roomTwiml = (opts: {
    startsConference: boolean
    endsOnExit: boolean
    record?: boolean
  }) =>
    `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference ` +
    `startConferenceOnEnter="${opts.startsConference}" ` +
    `endConferenceOnExit="${opts.endsOnExit}" beep="false" ` +
    (log.recorded && opts.record !== false && opts.startsConference
      ? `record="record-from-start" ` +
        `recordingStatusCallback="${xmlEscape(recordingUrl)}" ` +
        `recordingStatusCallbackEvent="completed" `
      : '') +
    `>${xmlEscape(room)}</Conference></Dial></Response>`

  const redirect = (callSid: string, twiml: string) =>
    twilioRequest({
      accountSid: config.accountSid,
      authToken: config.authToken,
      path: `/Accounts/${config.accountSid}/Calls/${callSid}.json`,
      method: 'POST',
      form: { Twiml: twiml },
    })

  /*
   * Record the decision BEFORE moving anybody.
   *
   * The rep's leg is the parent of a <Dial> and its action url asks this table
   * what to do the instant that <Dial> ends. Writing first means the answer is
   * already there when it asks; writing after was a race, and the version of
   * this that redirected both legs with Promise.all lost one of them every
   * time — redirect the lead first and the rep's <Dial> ended with nowhere to
   * go, so the browser hung up; redirect the rep first and tearing down the
   * <Dial> hung up the lead.
   */
  await db.from('dial_call_logs')
    .update({ mode: 'conference', conference_name: room })
    .eq('id', log.id)

  /*
   * Move ONLY the lead. That ends the rep's <Dial>, which sends them to
   * after_dial, which reads the row above and puts them in the same room.
   * endConferenceOnExit stays false here so the prospect dropping does not end
   * a call the rep and the agent may still be having.
   */
  let movedLegs = 0
  if (log.twilio_call_sid) {
    // record:false — the rep's leg starts the recording when after_dial puts
    // it in the room. Two legs asking would produce two files of one call.
    await redirect(
      log.twilio_call_sid,
      roomTwiml({ startsConference: true, endsOnExit: false, record: false }),
    )
    movedLegs = 1
  } else {
    // No child leg on the log yet — the lead's sid arrives with the status
    // callback. Moving the rep is then the only option, and it takes the
    // prospect with it, so say so rather than pretending it worked.
    await redirect(log.parent_call_sid, roomTwiml({ startsConference: true, endsOnExit: true }))
    movedLegs = 1
  }

  const added = await twilioRequest<{ sid: string }>({
    accountSid: config.accountSid,
    authToken: config.authToken,
    path: `/Accounts/${config.accountSid}/Calls.json`,
    method: 'POST',
    form: {
      To: target,
      From: config.phoneNumber,
      // The rep's leg owns the recording; a third leg asking for one too
      // would start a second file of the same conversation.
      Twiml: roomTwiml({ startsConference: true, endsOnExit: false, record: false }),
      StatusCallback: `${functionsBaseUrl()}/twilio-status?${query}&event=child`,
      StatusCallbackMethod: 'POST',
      StatusCallbackEvent: 'initiated ringing answered completed',
    },
  })

  return json({
    ok: true,
    conferenceName: room,
    added: target,
    callSid: added.sid,
    movedLegs,
  })
}

/**
 * The live room, as Twilio sees it.
 *
 * Conferences are addressed by SID, not by the friendly name we chose, so this
 * resolves one to the other. An in-progress conference is the only kind worth
 * looking at: a finished one has no participants and answering with its ghost
 * roster would be worse than answering with nothing.
 */
async function findConference(
  config: { accountSid: string; authToken: string },
  room: string,
): Promise<string | null> {
  const list = await twilioRequest<{ conferences: { sid: string }[] }>({
    accountSid: config.accountSid,
    authToken: config.authToken,
    path: `/Accounts/${config.accountSid}/Conferences.json` +
      `?FriendlyName=${encodeURIComponent(room)}&Status=in-progress`,
    method: 'GET',
  })
  return list.conferences?.[0]?.sid ?? null
}

/**
 * Who is actually on the call right now, and which of them is which.
 *
 * Twilio only knows call SIDs, so the roles come from the log: the leg that
 * started the call is the rep, the leg it dialled is the lead, and anything
 * else arrived later. Without that mapping the UI can only offer "drop a
 * participant", which is not a decision anyone can make mid-sentence.
 */
async function participants(
  req: Request,
  body: { workspaceId?: string; logId?: string },
): Promise<Response> {
  if (!body.workspaceId) throw new HttpError('workspaceId is required')
  if (!body.logId) throw new HttpError('logId is required')

  await requireMember(req, body.workspaceId)

  const db = serviceClient()
  const config = await loadTwilioConfig(db, body.workspaceId)
  if (!config) throw new HttpError('Twilio is not configured for this workspace.', 409)

  const { data: log } = await db
    .from('dial_call_logs')
    .select('id, parent_call_sid, twilio_call_sid, conference_name, business_name, phone')
    .eq('id', body.logId)
    .eq('workspace_id', body.workspaceId)
    .maybeSingle()

  if (!log) throw new HttpError('That call is not in this workspace.', 404)
  if (!log.conference_name) return json({ ok: true, participants: [], room: null })

  const conferenceSid = await findConference(config, log.conference_name)
  // The room has ended, or has not started yet. Both mean nobody is in it.
  if (!conferenceSid) return json({ ok: true, participants: [], room: log.conference_name })

  const list = await twilioRequest<{
    participants: { call_sid: string; muted: boolean; hold: boolean }[]
  }>({
    accountSid: config.accountSid,
    authToken: config.authToken,
    path: `/Accounts/${config.accountSid}/Conferences/${conferenceSid}/Participants.json`,
    method: 'GET',
  })

  const rows = await Promise.all((list.participants ?? []).map(async (p) => {
    const role = p.call_sid === log.parent_call_sid ? 'you'
      : p.call_sid === log.twilio_call_sid ? 'lead'
      : 'added'

    // Only a leg we did not put there needs looking up; we already know the
    // other two numbers.
    let number: string | null = role === 'lead' ? log.phone : null
    if (role === 'added') {
      try {
        const call = await twilioRequest<{ to: string }>({
          accountSid: config.accountSid,
          authToken: config.authToken,
          path: `/Accounts/${config.accountSid}/Calls/${p.call_sid}.json`,
          method: 'GET',
        })
        number = call.to ?? null
      } catch {
        // A number we cannot name is still a participant worth showing.
        number = null
      }
    }

    return {
      callSid: p.call_sid,
      role,
      label: role === 'you' ? 'You'
        : role === 'lead' ? (log.business_name ?? 'The lead')
        : 'Added',
      number,
      muted: p.muted,
      onHold: p.hold,
    }
  }))

  return json({ ok: true, room: log.conference_name, conferenceSid, participants: rows })
}

/**
 * Drops one participant without ending the call.
 *
 * This is the whole point of running a conference rather than a two-party
 * bridge: the rep can put the agent back down and keep talking to the
 * prospect. Only the rep's own leg carries endConferenceOnExit, so removing
 * anyone else leaves the room standing.
 */
async function removeParticipant(
  req: Request,
  body: { workspaceId?: string; logId?: string; callSid?: string },
): Promise<Response> {
  if (!body.workspaceId) throw new HttpError('workspaceId is required')
  if (!body.logId) throw new HttpError('logId is required')
  if (!body.callSid) throw new HttpError('callSid is required')

  await requireMember(req, body.workspaceId)

  const db = serviceClient()
  const config = await loadTwilioConfig(db, body.workspaceId)
  if (!config) throw new HttpError('Twilio is not configured for this workspace.', 409)

  const { data: log } = await db
    .from('dial_call_logs')
    .select('id, conference_name, parent_call_sid')
    .eq('id', body.logId)
    .eq('workspace_id', body.workspaceId)
    .maybeSingle()

  if (!log?.conference_name) throw new HttpError('That call is not a conference.', 409)

  // Hanging up on yourself is what the End button is for, and doing it through
  // here would end the room for everyone without saying so.
  if (body.callSid === log.parent_call_sid) {
    throw new HttpError('Use End to leave the call yourself.', 409)
  }

  const conferenceSid = await findConference(config, log.conference_name)
  if (!conferenceSid) throw new HttpError('That conference has already ended.', 409)

  await twilioRequest({
    accountSid: config.accountSid,
    authToken: config.authToken,
    path: `/Accounts/${config.accountSid}/Conferences/${conferenceSid}` +
      `/Participants/${body.callSid}.json`,
    method: 'DELETE',
  })

  return json({ ok: true, removed: body.callSid })
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const body = await req.json() as {
      workspaceId?: string
      logId?: string
      to?: string
      conferenceName?: string
      callSid?: string
      /** 'escalate' turns a live two-party call into a conference first. */
      action?: 'add' | 'escalate' | 'participants' | 'remove'
    }

    if (body.action === 'escalate') return await escalate(req, body)
    if (body.action === 'participants') return await participants(req, body)
    if (body.action === 'remove') return await removeParticipant(req, body)

    if (!body.workspaceId) throw new HttpError('workspaceId is required')
    if (!body.conferenceName) throw new HttpError('conferenceName is required')

    const to = toE164(body.to ?? '')
    if (!to) throw new HttpError(`"${body.to}" is not a valid phone number`)

    await requireMember(req, body.workspaceId)

    const db = serviceClient()
    const config = await loadTwilioConfig(db, body.workspaceId)
    if (!config?.phoneNumber) {
      throw new HttpError('Twilio is not configured for this workspace.', 409)
    }

    // The lead's leg gets its own inline TwiML rather than another webhook
    // round trip — there is no decision to make, just "join this room".
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference ` +
      `startConferenceOnEnter="true" endConferenceOnExit="false" beep="false"` +
      `>${xmlEscape(body.conferenceName)}</Conference></Dial></Response>`

    const query = `ws=${encodeURIComponent(body.workspaceId)}&log=${encodeURIComponent(body.logId ?? '')}`
    // NOT new URL(req.url).origin: Supabase's gateway rewrites req.url to http
    // and strips the /functions/v1 prefix before the function sees it, so a URL
    // built from it is unreachable and this leg never reports its status.
    const statusCallback = `${functionsBaseUrl()}/twilio-status?${query}&event=child`

    const call = await twilioRequest<{ sid: string }>({
      accountSid: config.accountSid,
      authToken: config.authToken,
      path: `/Accounts/${config.accountSid}/Calls.json`,
      method: 'POST',
      form: {
        To: to,
        From: config.phoneNumber,
        Twiml: twiml,
        StatusCallback: statusCallback,
        StatusCallbackMethod: 'POST',
        StatusCallbackEvent: 'initiated ringing answered completed',
      },
    })

    return json({ ok: true, callSid: call.sid })
  } catch (error) {
    return errorResponse(error)
  }
})
