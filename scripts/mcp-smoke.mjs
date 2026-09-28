#!/usr/bin/env node
// End-to-end smoke test for the Callsheet MCP connector.
//
// Signs in with a password grant to get a real Supabase access token, then drives
// initialize -> tools/list -> tools/call against the deployed function. The password
// grant stands in for the OAuth grant: both mint an ordinary Supabase access token,
// which is exactly the assumption the connector's security model rests on — that the
// token PostgREST receives carries `sub` + `role: authenticated` so RLS applies.
//
// Usage: SMOKE_EMAIL=… SMOKE_PASSWORD=… node scripts/mcp-smoke.mjs
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)

const URL_BASE = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY
const MCP = `${URL_BASE}/functions/v1/mcp`
const EMAIL = process.env.SMOKE_EMAIL
const PASSWORD = process.env.SMOKE_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('Set SMOKE_EMAIL and SMOKE_PASSWORD.')
  process.exit(2)
}

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const bad = (m) => { console.error(`  \x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1 }

/** The Streamable HTTP transport may answer as JSON or as a single SSE frame. */
async function parseBody(res) {
  const text = await res.text()
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'))
    return line ? JSON.parse(line.slice(5).trim()) : null
  }
  return text ? JSON.parse(text) : null
}

let sessionId = null
let id = 0

async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = await parseBody(res)
  if (body?.error) throw new Error(`${method} → ${JSON.stringify(body.error)}`)
  return body?.result
}

console.log('\nCallsheet MCP smoke test\n')

// 1 ── a real Supabase access token
const authRes = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
const auth = await authRes.json()
if (!auth.access_token) { bad(`sign-in failed: ${JSON.stringify(auth).slice(0, 200)}`); process.exit(1) }
const token = auth.access_token
ok('signed in, got a Supabase access token')

// 2 ── initialize
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'callsheet-smoke', version: '1.0.0' },
})
ok(`initialize → ${init.serverInfo.name} v${init.serverInfo.version}`)
init.instructions?.length > 200
  ? ok(`instructions delivered (${init.instructions.length} chars)`)
  : bad('instructions missing or too short')

await fetch(MCP, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'mcp-session-id': sessionId ?? '',
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
})

// 3 ── tools/list
const { tools } = await rpc('tools/list', {})
ok(`tools/list → ${tools.length} tools`)
const names = tools.map((t) => t.name).sort()
console.log(`     ${names.join(', ')}`)

for (const required of ['get_daily_summary', 'list_calls', 'set_call_outcome']) {
  names.includes(required) ? ok(`${required} registered`) : bad(`${required} MISSING`)
}

// 4 ── the assumption under test: does the token reach PostgREST as `authenticated`?
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args })
  return JSON.parse(r.content[0].text)
}

const ws = await call('list_workspaces')
if (ws.error) bad(`list_workspaces → ${ws.error}`)
else if (!ws.workspaces?.length) bad('list_workspaces returned none — RLS did not see the caller')
else ok(`list_workspaces → "${ws.workspaces[0].name}" (${ws.workspaces[0].role}) — RLS resolved the caller`)

const summary = await call('get_daily_summary', { timezone: 'America/Chicago' })
summary.error
  ? bad(`get_daily_summary → ${summary.error}`)
  : ok(`get_daily_summary → ${summary.date}: ${summary.totals.calls} calls, ` +
       `${summary.totals.connected} connected, ${summary.totals.talk_time} talk time`)

const stats = await call('get_call_stats', { timezone: 'America/Chicago' })
stats.error
  ? bad(`get_call_stats → ${stats.error}`)
  : ok(`get_call_stats → ${stats.stats.calls_total} calls all time (RPC via caller JWT)`)

const leads = await call('list_leads', { limit: 3 })
leads.error ? bad(`list_leads → ${leads.error}`) : ok(`list_leads → ${leads.leads.length} leads`)

console.log(process.exitCode ? '\n\x1b[31mFAILED\x1b[0m\n' : '\n\x1b[32mAll checks passed\x1b[0m\n')
