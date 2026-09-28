#!/usr/bin/env node
// Regression test for Twilio webhook signature verification.
//
// This bug cost two rounds of live debugging, so it gets a test. Twilio signs the
// PUBLIC url it called, but the Supabase edge gateway rewrites the request twice
// before the function sees it:
//
//   public:  https://<ref>.supabase.co/functions/v1/twilio-voice?ws=...
//   req.url: http://<ref>.supabase.co/twilio-voice?ws=...
//
// The scheme drops to http AND `/functions/v1` is stripped. Verifying against
// req.url rejects every genuine webhook with a 403, Twilio gets no TwiML, and the
// caller hears "an application error has occurred".
//
// Run: node scripts/check-twilio-signature.mjs
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'cs-sig-'))
const out = join(dir, 'twilio.mjs')

try {
  execFileSync('npx', ['esbuild', 'supabase/functions/_shared/twilio.ts',
    '--format=esm', `--outfile=${out}`], { stdio: 'pipe' })

  const REF = 'testproject'
  const TOKEN = 'test_auth_token_not_real'
  const PUBLIC_URL = `https://${REF}.supabase.co/functions/v1/twilio-voice?ws=ws-123`
  const GATEWAY_URL = `http://${REF}.supabase.co/twilio-voice?ws=ws-123`
  const params = { CallSid: 'CA123', To: '+15550109999', logId: 'abc-123', mode: 'direct' }

  // Sign the public url exactly as Twilio does: url + each sorted key+value.
  let payload = PUBLIC_URL
  for (const k of Object.keys(params).sort()) payload += k + params[k]
  const signature = createHmac('sha1', TOKEN).update(payload).digest('base64')

  globalThis.Deno = {
    env: { get: (k) => (k === 'SUPABASE_URL' ? `https://${REF}.supabase.co` : undefined) },
  }

  const { candidateUrls, verifyTwilioSignature } = await import(`file://${out}`)
  const req = new Request(GATEWAY_URL, {
    method: 'POST',
    headers: { host: `${REF}.supabase.co`, 'x-forwarded-proto': 'https' },
  })
  const tried = candidateUrls(req)

  const checks = [
    ['the public url Twilio signed is a candidate', tried.includes(PUBLIC_URL)],
    ['a genuine signature verifies',
      await verifyTwilioSignature({ authToken: TOKEN, url: tried, params, signature })],
    ['a forged signature is rejected',
      (await verifyTwilioSignature({
        authToken: TOKEN, url: tried, params,
        signature: createHmac('sha1', 'wrong').update(payload).digest('base64'),
      })) === false],
    ['a missing signature is rejected',
      (await verifyTwilioSignature({ authToken: TOKEN, url: tried, params, signature: null })) === false],
  ]

  let failed = false
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`)
    if (!pass) failed = true
  }
  if (failed) {
    console.error('\n  candidates were:'); for (const u of tried) console.error('   ', u)
  }
  process.exit(failed ? 1 : 0)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
