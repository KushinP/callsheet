/**
 * Minimal Twilio helpers built on Web Crypto.
 *
 * The Twilio Node SDK does not run cleanly in Deno edge functions, and the two
 * things we actually need from it — an HS256 access token and an HMAC-SHA1
 * request signature — are a few lines each.
 */

const TWILIO_API = 'https://api.twilio.com/2010-04-01'

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

async function hmac(
  algo: 'SHA-1' | 'SHA-256',
  secret: string,
  message: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algo },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return new Uint8Array(sig)
}

/**
 * Twilio access token for the browser Voice SDK.
 *
 * This is a plain JWT signed with the API Key *secret*, issued by the API Key
 * SID on behalf of the account. The `cty` header is what marks it as a Twilio
 * first-party access token rather than a generic JWT.
 */
export async function createAccessToken(opts: {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  identity: string
  twimlAppSid: string
  ttlSeconds?: number
}): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000)
  const ttl = opts.ttlSeconds ?? 3600
  const exp = now + ttl

  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' }
  const payload = {
    jti: `${opts.apiKeySid}-${now}`,
    iss: opts.apiKeySid,
    sub: opts.accountSid,
    iat: now,
    nbf: now,
    exp,
    grants: {
      identity: opts.identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: opts.twimlAppSid },
      },
    },
  }

  const signingInput = `${base64url(encoder.encode(JSON.stringify(header)))}.${
    base64url(encoder.encode(JSON.stringify(payload)))
  }`
  const signature = await hmac('SHA-256', opts.apiKeySecret, signingInput)

  return { token: `${signingInput}.${base64url(signature)}`, expiresAt: exp }
}

/**
 * Every URL this request might have been signed as.
 *
 * Twilio computes its signature over the PUBLIC url it called, but by the time a
 * request reaches the function the gateway has rewritten it twice:
 *   public:  https://<ref>.supabase.co/functions/v1/twilio-voice?ws=...
 *   req.url: http://<ref>.supabase.co/twilio-voice?ws=...
 * The scheme drops to http AND the `/functions/v1` prefix is stripped. Verifying
 * against req.url therefore rejects every genuine webhook.
 *
 * Rebuild the public form from SUPABASE_URL (authoritative — it is the same value
 * twilio-provision registered as the TwiML app's VoiceUrl) and offer the observed
 * variants as fallbacks.
 *
 * This does not weaken the check: a match still requires a valid HMAC over the
 * exact parameter set using the workspace's own auth token. It only accounts for
 * the gateway rewriting the url on the way in.
 */
export function candidateUrls(req: Request): string[] {
  const raw = new URL(req.url)
  const tail = `${raw.pathname}${raw.search}`
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? raw.host

  // Deno is present in the edge runtime; guard so this module stays importable elsewhere.
  const projectUrl = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
    .Deno?.env.get('SUPABASE_URL')?.replace(/\/+$/, '')

  const candidates = [
    // The real one: how twilio-provision registered the webhook.
    projectUrl && `${projectUrl}/functions/v1${tail}`,
    `https://${host}/functions/v1${tail}`,
    // Fallbacks for a gateway that does not strip the prefix.
    projectUrl && `${projectUrl}${tail}`,
    `https://${host}${tail}`,
    req.url,
  ].filter((u): u is string => Boolean(u))

  return [...new Set(candidates)]
}

/**
 * Verify the X-Twilio-Signature header on an inbound webhook.
 *
 * Twilio signs the full request URL (query string included) with every POST
 * parameter appended in key-sorted order.
 */
export async function verifyTwilioSignature(opts: {
  authToken: string
  url: string | string[]
  params: Record<string, string>
  signature: string | null
}): Promise<boolean> {
  if (!opts.signature) return false

  const sorted = Object.keys(opts.params).sort()
  let suffix = ''
  for (const key of sorted) suffix += key + opts.params[key]

  for (const candidate of Array.isArray(opts.url) ? opts.url : [opts.url]) {
    const expected = base64(await hmac('SHA-1', opts.authToken, candidate + suffix))

    // Constant-time compare so a signature cannot be guessed byte by byte.
    if (expected.length !== opts.signature.length) continue
    let diff = 0
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ opts.signature.charCodeAt(i)
    }
    if (diff === 0) return true
  }

  return false
}

/** Authenticated call against the Twilio REST API. */
export async function twilioRequest<T = unknown>(opts: {
  accountSid: string
  authToken: string
  path: string
  method?: 'GET' | 'POST' | 'DELETE'
  form?: Record<string, string | undefined>
}): Promise<T> {
  const auth = btoa(`${opts.accountSid}:${opts.authToken}`)
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  }

  if (opts.form) {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.form)) {
      if (v !== undefined && v !== null) body.set(k, v)
    }
    init.body = body.toString()
  }

  const res = await fetch(`${TWILIO_API}${opts.path}`, init)
  const text = await res.text()

  if (!res.ok) {
    let message = text
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text
    } catch { /* keep raw body */ }
    throw new TwilioError(message, res.status)
  }

  return text ? (JSON.parse(text) as T) : ({} as T)
}

export class TwilioError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'TwilioError'
    this.status = status
  }
}

/**
 * US-centric E.164. Ten digits get a +1; eleven starting with 1 get a plus.
 * Anything already in +E.164 form is passed straight through.
 */

/** Twilio's media URL for a recording. Requires HTTP Basic with the account credentials. */
export function recordingMediaUrl(accountSid: string, recordingSid: string, ext = 'mp3'): string {
  return `${TWILIO_API}/Accounts/${accountSid}/Recordings/${recordingSid}.${ext}`
}

export function basicAuthHeader(accountSid: string, authToken: string): string {
  return `Basic ${btoa(`${accountSid}:${authToken}`)}`
}

export function toE164(raw: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed

  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length > 11) return `+${digits}`
  return null
}

/** Escape a value for interpolation into a TwiML attribute or text node. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function twimlResponse(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

/** Parse a Twilio webhook body into a flat record for signature checking. */
export async function readFormParams(req: Request): Promise<Record<string, string>> {
  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v
  return params
}
