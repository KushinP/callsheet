/**
 * twilio-token
 *
 * Issues the short-lived access token the browser Voice SDK needs. The API key
 * secret never leaves the server; the browser only ever sees a signed JWT that
 * expires in an hour.
 */
import { HttpError, loadTwilioConfig, requireMember, serviceClient } from '../_shared/db.ts'
import { errorResponse, json, preflight } from '../_shared/http.ts'
import { createAccessToken } from '../_shared/twilio.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const { workspaceId } = await req.json() as { workspaceId?: string }
    if (!workspaceId) throw new HttpError('workspaceId is required')

    const { userId } = await requireMember(req, workspaceId)

    const db = serviceClient()
    const config = await loadTwilioConfig(db, workspaceId)

    if (!config) {
      throw new HttpError('Twilio is not configured for this workspace yet. Add your credentials in Settings.', 409)
    }
    if (!config.apiKeySid || !config.apiKeySecret || !config.twimlAppSid) {
      throw new HttpError('Twilio setup is incomplete. Re-save your credentials in Settings.', 409)
    }
    if (!config.phoneNumber) {
      throw new HttpError('No Twilio phone number is set for this workspace.', 409)
    }

    // Twilio client identities allow [A-Za-z0-9_.-] only.
    const identity = `agent_${userId.replace(/-/g, '')}`

    const { token, expiresAt } = await createAccessToken({
      accountSid: config.accountSid,
      apiKeySid: config.apiKeySid,
      apiKeySecret: config.apiKeySecret,
      identity,
      twimlAppSid: config.twimlAppSid,
      ttlSeconds: 3600,
    })

    return json({ token, identity, expiresAt, callerId: config.phoneNumber })
  } catch (error) {
    return errorResponse(error)
  }
})
