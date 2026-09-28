/**
 * recording-proxy
 *
 * Twilio media URLs need the account credentials to fetch, and those must
 * never reach the browser. This streams the audio through instead, but only
 * after confirming the caller is a member of the workspace that owns the call.
 */
import { HttpError, loadTwilioConfig, requireMember, serviceClient } from '../_shared/db.ts'
import { corsHeaders, errorResponse, preflight } from '../_shared/http.ts'
import { getObject } from '../_shared/storage.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const url = new URL(req.url)
    const workspaceId = url.searchParams.get('ws')
    const logId = url.searchParams.get('log')

    if (!workspaceId || !logId) throw new HttpError('ws and log are required')

    await requireMember(req, workspaceId)

    const db = serviceClient()
    const { data: log } = await db
      .from('dial_call_logs')
      .select('recording_sid, storage_key, storage_provider')
      .eq('id', logId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    if (!log) throw new HttpError('No recording for this call', 404)

    // Recordings are copied to our own bucket and deleted from Twilio, so once
    // storage_key is set that is the only copy that still exists.
    if (log.storage_key) {
      const upstream = await getObject(log.storage_key, req.headers.get('Range'))
      if (!upstream.ok && upstream.status !== 206) {
        throw new HttpError('Recording is not available', 404)
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
          ...(upstream.headers.get('Content-Length')
            ? { 'Content-Length': upstream.headers.get('Content-Length')! } : {}),
          ...(upstream.headers.get('Content-Range')
            ? { 'Content-Range': upstream.headers.get('Content-Range')! } : {}),
        },
      })
    }

    if (!log.recording_sid) throw new HttpError('No recording for this call', 404)

    const config = await loadTwilioConfig(db, workspaceId)
    if (!config) throw new HttpError('Twilio is not configured', 409)

    const mediaUrl =
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}` +
      `/Recordings/${log.recording_sid}.mp3`

    const auth = btoa(`${config.accountSid}:${config.authToken}`)
    const upstream = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${auth}`,
        // Pass the browser's range request through so <audio> can seek.
        ...(req.headers.get('Range') ? { Range: req.headers.get('Range')! } : {}),
      },
    })

    if (!upstream.ok && upstream.status !== 206) {
      throw new HttpError('Recording is not available yet', 404)
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        ...(upstream.headers.get('Content-Length')
          ? { 'Content-Length': upstream.headers.get('Content-Length')! }
          : {}),
        ...(upstream.headers.get('Content-Range')
          ? { 'Content-Range': upstream.headers.get('Content-Range')! }
          : {}),
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
})
