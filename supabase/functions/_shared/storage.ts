/**
 * Recording storage on Cloudflare R2 (S3-compatible), signed with AWS SigV4.
 *
 * Why bother: Twilio bills recording storage per minute PER MONTH for the whole
 * retained library, after a 10,000-minute allowance. At ~4,400 recorded minutes
 * a month that is ~$21/mo by month 12 and ~$47/mo by month 24, and it never
 * stops growing. The same audio on R2 is ~$0.21/mo at month 12 — R2 gives 10 GB
 * free, charges $0.015/GB after, and does not charge egress at all.
 *
 * SigV4 is hand-rolled here rather than pulling in an S3 SDK: it is one signed
 * PUT, and the AWS SDK is a heavy dependency for a Deno edge function.
 */

declare const Deno: { env: { get(key: string): string | undefined } }

const encoder = new TextEncoder()

function env(key: string): string | undefined {
  const v = Deno.env.get(key)
  return v && v.trim() ? v.trim() : undefined
}

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export function r2Config(): R2Config | null {
  const accountId = env('R2_ACCOUNT_ID')
  const accessKeyId = env('R2_ACCESS_KEY_ID')
  const secretAccessKey = env('R2_SECRET_ACCESS_KEY')
  const bucket = env('R2_BUCKET')
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null
  return { accountId, accessKeyId, secretAccessKey, bucket }
}

/** Configured means "offload recordings"; unconfigured means "leave them on Twilio". */
export function storageAvailable(): boolean {
  return r2Config() !== null
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return hex(new Uint8Array(hash))
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)))
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}


/**
 * Compute a SigV4 Authorization header.
 *
 * Exported so scripts/check-sigv4.mjs can verify it against AWS's published
 * test vector — a wrong signature fails as an opaque 403 with no clue which of
 * the dozen steps went wrong.
 */
export async function signV4(opts: {
  method: string
  host: string
  path: string
  headers: Record<string, string>
  payloadHash: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  service: string
  amzDate: string
}): Promise<string> {
  const dateStamp = opts.amzDate.slice(0, 8)

  const all: Record<string, string> = {
    ...opts.headers,
    host: opts.host,
    'x-amz-content-sha256': opts.payloadHash,
    'x-amz-date': opts.amzDate,
  }
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort()
  const canonicalHeaders = names
    .map((n) => `${n}:${String(all[Object.keys(all).find((k) => k.toLowerCase() === n)!]).trim()}\n`)
    .join('')
  const signedHeaders = names.join(';')

  const canonicalRequest =
    `${opts.method}\n${opts.path}\n\n${canonicalHeaders}\n${signedHeaders}\n${opts.payloadHash}`

  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`
  const stringToSign =
    `AWS4-HMAC-SHA256\n${opts.amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`

  let k = await hmac(encoder.encode(`AWS4${opts.secretAccessKey}`), dateStamp)
  k = await hmac(k, opts.region)
  k = await hmac(k, opts.service)
  k = await hmac(k, 'aws4_request')
  const signature = hex(await hmac(k, stringToSign))

  return `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, ` +
         `SignedHeaders=${signedHeaders}, Signature=${signature}`
}

/**
 * Upload one object. Returns the key on success.
 *
 * R2's S3 endpoint requires SigV4 with region "auto" and service "s3".
 */
export async function putObject(opts: {
  key: string
  body: Uint8Array
  contentType: string
}): Promise<{ key: string; bytes: number }> {
  const cfg = r2Config()
  if (!cfg) throw new Error('R2 is not configured')

  const host = `${cfg.accountId}.r2.cloudflarestorage.com`
  const path = `/${cfg.bucket}/${opts.key.split('/').map(encodeURIComponent).join('/')}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')  // 20260904T012233Z
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = await sha256Hex(opts.body)

  const authorization = await signV4({
    method: 'PUT',
    host,
    path,
    headers: { 'content-type': opts.contentType },
    payloadHash,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: 'auto',
    service: 's3',
    amzDate,
  })

  const res = await fetch(`https://${host}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': opts.contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
    body: opts.body as BodyInit,
  })

  if (!res.ok) {
    throw new Error(`R2 upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }

  return { key: opts.key, bytes: opts.body.length }
}

/**
 * Fetch an object back. Used by recording-proxy so playback keeps working after
 * the Twilio copy is gone.
 */
export async function getObject(key: string, range?: string | null): Promise<Response> {
  const cfg = r2Config()
  if (!cfg) throw new Error('R2 is not configured')

  const host = `${cfg.accountId}.r2.cloudflarestorage.com`
  const path = `/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = await sha256Hex('')

  const authorization = await signV4({
    method: 'GET',
    host,
    path,
    headers: {},
    payloadHash,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: 'auto',
    service: 's3',
    amzDate,
  })

  return fetch(`https://${host}${path}`, {
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
      ...(range ? { Range: range } : {}),
    },
  })
}

/**
 * Remove an object. Used by delete-calls so deleting a call deletes its audio.
 *
 * S3 answers 204 whether or not the key existed, so a second delete is harmless.
 */
export async function deleteObject(key: string): Promise<void> {
  const cfg = r2Config()
  if (!cfg) throw new Error('R2 is not configured')

  const host = `${cfg.accountId}.r2.cloudflarestorage.com`
  const path = `/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const payloadHash = await sha256Hex('')

  const authorization = await signV4({
    method: 'DELETE',
    host,
    path,
    headers: {},
    payloadHash,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: 'auto',
    service: 's3',
    amzDate,
  })

  const res = await fetch(`https://${host}${path}`, {
    method: 'DELETE',
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authorization,
    },
  })

  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 delete failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
}

/** Stable, sortable, and scoped so one workspace's audio never collides with another's. */
export function recordingKey(workspaceId: string, callId: string, calledAt: string): string {
  const day = calledAt.slice(0, 10)          // 2026-09-04
  return `recordings/${workspaceId}/${day}/${callId}.mp3`
}
