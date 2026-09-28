/**
 * twilio-provision
 *
 * The guide asks the user for three things — Account SID, Auth Token, and a
 * phone number — but browser calling actually needs an API Key pair (to sign
 * access tokens) and a TwiML Application (to point Twilio at our voice
 * webhook). Rather than making the user hunt those down in the Twilio console,
 * this function creates them with the credentials they already gave us.
 */
import { HttpError, functionsBaseUrl, loadTwilioConfig, requireMember, serviceClient } from '../_shared/db.ts'
import { errorResponse, json, preflight } from '../_shared/http.ts'
import { toE164, twilioRequest } from '../_shared/twilio.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

const APP_FRIENDLY_NAME = 'Callsheet'

interface TwilioKey { sid: string; secret: string }
interface TwilioApp { sid: string; friendly_name: string }
interface TwilioNumber {
  sid: string
  phone_number: string
  voice_url?: string | null
  voice_application_sid?: string | null
  capabilities: { voice: boolean }
}
interface TwilioAccount { status: string; auth_token?: string }

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  let numberSid: string | null = null
  let priorVoiceUrl: string | null = null
  let priorVoiceAppSid: string | null = null

  try {
    const body = await req.json() as {
      workspaceId?: string
      accountSid?: string
      authToken?: string
      phoneNumber?: string
    }

    const workspaceId = body.workspaceId?.trim()
    const accountSid = body.accountSid?.trim()
    const authToken = body.authToken?.trim()

    if (!workspaceId) throw new HttpError('workspaceId is required')
    if (!accountSid || !accountSid.startsWith('AC')) {
      throw new HttpError('Account SID must start with "AC"')
    }
    if (!authToken) throw new HttpError('Auth Token is required')

    const phoneNumber = body.phoneNumber ? toE164(body.phoneNumber) : null
    if (body.phoneNumber && !phoneNumber) {
      throw new HttpError(`"${body.phoneNumber}" is not a valid phone number`)
    }

    // Only a workspace owner/admin can rewire the phone line.
    await requireMember(req, workspaceId, { adminOnly: true })

    // 1. Do the credentials actually work?
    const account = await twilioRequest<TwilioAccount>({
      accountSid,
      authToken,
      path: `/Accounts/${accountSid}.json`,
    }).catch(() => {
      throw new HttpError('Twilio rejected those credentials. Check the Account SID and Auth Token.', 400)
    })

    // 1b. Is it the PRIMARY token?
    //
    // Twilio accepts a secondary auth token for API calls but signs webhooks with
    // the primary one. Saving a secondary therefore looks completely fine here and
    // then fails every inbound webhook signature check, which surfaces to the caller
    // as "an application error has occurred" with nothing pointing at the cause.
    // The account resource reports the primary, so catch the mismatch up front.
    if (account.auth_token && account.auth_token !== authToken) {
      throw new HttpError(
        'That is not this account\'s primary Auth Token. Twilio signs webhooks with the ' +
        'primary token, so calls would fail with "an application error has occurred". ' +
        'Copy the Auth Token shown on the Twilio Console dashboard and try again.',
        400,
      )
    }

    // 2. Is the number ours, and can it make voice calls?
    if (phoneNumber) {
      const owned = await twilioRequest<{ incoming_phone_numbers: TwilioNumber[] }>({
        accountSid,
        authToken,
        path: `/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
      })
      const match = owned.incoming_phone_numbers?.[0]
      if (!match) {
        throw new HttpError(`${phoneNumber} is not a number on this Twilio account.`)
      }
      if (!match.capabilities?.voice) {
        throw new HttpError(`${phoneNumber} does not have Voice capability enabled.`)
      }
      numberSid = match.sid ?? null

      // Whatever this number was pointed at before we claim it. If it was
      // running something else — a voice agent, an IVR — that is about to stop
      // working, and the operator deserves to be told rather than discovering
      // it when someone calls.
      priorVoiceUrl = match.voice_url?.trim() || null
      priorVoiceAppSid = match.voice_application_sid?.trim() || null
    }

    const db = serviceClient()
    const previous = await loadTwilioConfig(db, workspaceId)

    // 3. A fresh API key every save. Twilio only reveals a key's secret at
    //    creation, so there is nothing to reuse, and the old one gets revoked
    //    below once the new one is safely stored.
    const key = await twilioRequest<TwilioKey>({
      accountSid,
      authToken,
      path: `/Accounts/${accountSid}/Keys.json`,
      method: 'POST',
      form: { FriendlyName: `${APP_FRIENDLY_NAME} (${workspaceId.slice(0, 8)})` },
    })

    // 4. The TwiML app tells Twilio which URL to ask for call instructions.
    //    The workspace id rides in the query string so the webhook knows whose
    //    credentials to verify the signature with.
    const voiceUrl = `${functionsBaseUrl()}/twilio-voice?ws=${workspaceId}`
    const appForm = {
      FriendlyName: `${APP_FRIENDLY_NAME} (${workspaceId.slice(0, 8)})`,
      VoiceUrl: voiceUrl,
      VoiceMethod: 'POST',
    }

    // The TwiML Application governs calls the BROWSER places. It has nothing to
    // do with someone dialling the number, which is why callbacks previously
    // reached Twilio's default demo message instead of this app.
    // Claiming the number is opt-in. Saving credentials happens often; taking
    // over a phone number that may already be answering happens once, and only
    // when asked for.
    const { data: ws } = await db
      .from('workspaces')
      .select('answer_inbound')
      .eq('id', workspaceId)
      .maybeSingle()

    if (numberSid && ws?.answer_inbound) {
      await twilioRequest({
        accountSid,
        authToken,
        path: `/Accounts/${accountSid}/IncomingPhoneNumbers/${numberSid}.json`,
        method: 'POST',
        // Clearing VoiceApplicationSid matters: while it is set, Twilio uses the
        // application's URL and ignores VoiceUrl entirely, so setting VoiceUrl
        // alone would appear to work and change nothing.
        //
        // StatusCallback reports the caller's own leg. It is the only event
        // that arrives when someone rings, waits and hangs up before anything
        // answers — Twilio does not request the <Dial> action url then — so
        // without it that call is logged as ringing forever and never counts
        // as missed. It carries no log id; twilio-status matches it on the
        // parent CallSid.
        form: {
          VoiceUrl: voiceUrl,
          VoiceMethod: 'POST',
          VoiceApplicationSid: '',
          StatusCallback: `${functionsBaseUrl()}/twilio-status?ws=${workspaceId}`,
          StatusCallbackMethod: 'POST',
        },
      })
    }

    let twimlAppSid = previous?.twimlAppSid ?? null
    if (twimlAppSid) {
      // Re-point the existing app rather than littering the account with apps.
      await twilioRequest({
        accountSid,
        authToken,
        path: `/Accounts/${accountSid}/Applications/${twimlAppSid}.json`,
        method: 'POST',
        form: appForm,
      }).catch(async () => {
        twimlAppSid = null
      })
    }

    if (!twimlAppSid) {
      const app = await twilioRequest<TwilioApp>({
        accountSid,
        authToken,
        path: `/Accounts/${accountSid}/Applications.json`,
        method: 'POST',
        form: appForm,
      })
      twimlAppSid = app.sid
    }

    // 5. Store. Secrets go to the table only the service role can read.
    const now = new Date().toISOString()

    const { error: secretError } = await db.from('workspace_twilio_secrets').upsert({
      workspace_id: workspaceId,
      auth_token: authToken,
      api_key_secret: key.secret,
      updated_at: now,
    })
    if (secretError) throw new Error(secretError.message)

    const { error: settingsError } = await db.from('workspace_twilio_settings').upsert({
      workspace_id: workspaceId,
      account_sid: accountSid,
      phone_number: phoneNumber,
      api_key_sid: key.sid,
      twiml_app_sid: twimlAppSid,
      // Only record a genuinely foreign previous target — re-saving should not
      // overwrite the original with our own URL from the previous save.
      ...(priorVoiceUrl && !priorVoiceUrl.includes('/twilio-voice')
        ? { previous_voice_url: priorVoiceUrl }
        : {}),
      is_configured: Boolean(phoneNumber),
      last_verified_at: now,
      updated_at: now,
    })
    if (settingsError) throw new Error(settingsError.message)

    // 6. Revoke the superseded key. Best-effort: the new config is already
    //    live, and a stale key is a cleanup issue, not a failure.
    if (previous?.apiKeySid && previous.apiKeySid !== key.sid) {
      await twilioRequest({
        accountSid,
        authToken,
        path: `/Accounts/${accountSid}/Keys/${previous.apiKeySid}.json`,
        method: 'DELETE',
      }).catch((err) => console.warn('Could not revoke previous API key:', err))
    }

    // Claiming the number for inbound replaces whatever it pointed at. Say so
    // when that was something else — silently breaking a voice agent on the
    // same number is the exact failure this surfaces.
    const claimedFrom =
      ws?.answer_inbound && priorVoiceUrl && !priorVoiceUrl.includes('/twilio-voice')
        ? priorVoiceUrl
        : priorVoiceAppSid && priorVoiceAppSid !== twimlAppSid
          ? `TwiML app ${priorVoiceAppSid}`
          : null

    return json({
      ok: true,
      accountSid,
      phoneNumber,
      apiKeySid: key.sid,
      twimlAppSid,
      voiceUrl,
      claimedFrom,
      answersInbound: ws?.answer_inbound === true,
      // What this number pointed at, so the UI can show what would be replaced
      // before anyone flips the switch.
      currentVoiceUrl: priorVoiceUrl,
    })
  } catch (error) {
    return errorResponse(error)
  }
})
