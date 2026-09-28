import { HttpError } from './db.ts'
import { TwilioError } from './twilio.ts'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null
}

/** Turn a thrown error into a response without leaking internals. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status)
  if (error instanceof TwilioError) {
    return json({ error: `Twilio: ${error.message}` }, error.status >= 500 ? 502 : 400)
  }
  console.error('Unhandled error:', error)
  return json({ error: 'Internal error' }, 500)
}
