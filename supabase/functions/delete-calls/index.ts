/**
 * delete-calls — remove calls, and the audio they recorded.
 *
 * A plain row delete from the browser leaves the recording behind: the audio
 * lives in R2 (or still on Twilio, if offload never ran for it), and neither can
 * be reached without credentials the browser must never hold.
 *
 * Rows go first, as the caller — transcripts and documents cascade, and the
 * triggers recount each lead exactly as a direct delete would. Only then the
 * audio those rows pointed at. That order is deliberate: if an audio delete
 * fails the cost is an orphaned file, where the reverse could leave a call on
 * the log whose recording no longer plays.
 */
import {
  HttpError, loadTwilioConfig, requireMember, serviceClient, userClient,
} from '../_shared/db.ts'
import { errorResponse, json, preflight } from '../_shared/http.ts'
import { basicAuthHeader, recordingMediaUrl } from '../_shared/twilio.ts'
import { deleteObject } from '../_shared/storage.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

/** Ids ride in the query string of the delete; keep each request comfortably short. */
const CHUNK = 100

interface DeletedCall {
  id: string
  recording_sid: string | null
  storage_key: string | null
  twilio_recording_deleted_at: string | null
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const { workspace_id: workspaceId, call_ids: callIds } = await req.json() as {
      workspace_id?: string; call_ids?: string[]
    }
    if (!workspaceId || !Array.isArray(callIds) || callIds.length === 0) {
      throw new HttpError('workspace_id and call_ids are required')
    }

    await requireMember(req, workspaceId)

    const asCaller = userClient(req)
    const deleted: DeletedCall[] = []
    for (let i = 0; i < callIds.length; i += CHUNK) {
      const { data, error } = await asCaller
        .from('dial_call_logs')
        .delete()
        .eq('workspace_id', workspaceId)
        .in('id', callIds.slice(i, i + CHUNK))
        .select('id, recording_sid, storage_key, twilio_recording_deleted_at')
      if (error) throw new HttpError(error.message)
      deleted.push(...(data as DeletedCall[]))
    }

    const failures: string[] = []
    let audioDeleted = 0

    for (const call of deleted.filter((c) => c.storage_key)) {
      try {
        await deleteObject(call.storage_key!)
        audioDeleted++
      } catch (e) {
        failures.push(call.id)
        console.error('R2 delete failed', call.storage_key, e)
      }
    }

    // Still on Twilio: offload was not configured then, or Twilio refused the
    // delete at the time. Either way it is still billing there.
    const onTwilio = deleted.filter((c) => c.recording_sid && !c.twilio_recording_deleted_at)
    if (onTwilio.length) {
      const config = await loadTwilioConfig(serviceClient(), workspaceId)
      for (const call of onTwilio) {
        const res = config
          ? await fetch(recordingMediaUrl(config.accountSid, call.recording_sid!, 'json'), {
              method: 'DELETE',
              headers: { Authorization: basicAuthHeader(config.accountSid, config.authToken) },
            })
          : null
        if (res && (res.ok || res.status === 404)) {
          if (!call.storage_key) audioDeleted++
        } else {
          failures.push(call.id)
          console.error('Twilio recording delete failed', call.recording_sid, res?.status)
        }
      }
    }

    return json({
      deleted: deleted.length,
      audio_deleted: audioDeleted,
      audio_failed: new Set(failures).size,
    })
  } catch (error) {
    return errorResponse(error)
  }
})
