#!/usr/bin/env node
// Verifies the hand-rolled SigV4 signer against AWS's own published test vector.
//
// R2's S3 endpoint rejects a bad signature with a bare 403 and no indication of
// which of the dozen steps was wrong, so this pins the algorithm to a known-good
// answer rather than discovering it against live credentials.
//
// Vector: AWS SigV4 "GET Object" example — docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'cs-sig4-'))
const out = join(dir, 'storage.mjs')

try {
  execFileSync('npx', ['esbuild', 'supabase/functions/_shared/storage.ts',
    '--format=esm', `--outfile=${out}`], { stdio: 'pipe' })

  globalThis.Deno = { env: { get: () => undefined } }
  const { signV4 } = await import(`file://${out}`)

  // AWS's documented example request and its expected signature.
  const auth = await signV4({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    amzDate: '20130524T000000Z',
  })

  const EXPECTED = 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
  const got = auth.match(/Signature=([0-9a-f]+)/)?.[1]

  const checks = [
    ['signature matches the AWS test vector', got === EXPECTED],
    ['signed headers are sorted and lowercased',
      auth.includes('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date')],
    ['credential scope is well formed',
      auth.includes('Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request')],
  ]

  let failed = false
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`)
    if (!pass) failed = true
  }
  if (failed) {
    console.error(`\n  expected signature: ${EXPECTED}`)
    console.error(`  got:                ${got}`)
    console.error(`  full header:        ${auth}`)
  }
  process.exit(failed ? 1 : 0)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
