#!/usr/bin/env node
// Asserts the one property the MCP server's security model rests on: it never
// constructs a service-role client.
//
// The connector passes the CALLER'S token to supabase-js so Postgres RLS enforces
// the workspace boundary. A service-role client would silently bypass every policy
// and put isolation back in the hands of hand-written filters. Checking for the
// absence of one token is a far stronger guarantee than grepping every query for a
// filter that might be present but wrong.
import { readFileSync } from 'node:fs'

const FILE = 'supabase/functions/mcp/index.ts'
const src = readFileSync(new URL(`../${FILE}`, import.meta.url), 'utf8')

// Strip comments so the explanatory note at the top of the file (which names the
// service role in prose) doesn't trip the check.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

const banned = [
  ['SUPABASE_SERVICE_ROLE_KEY', 'reads the service-role key from the environment'],
  ['SERVICE_KEY', 'references a service key'],
  ['serviceClient', 'imports the shared service-role client helper'],
]

const found = banned.filter(([needle]) => code.includes(needle))

if (found.length) {
  console.error(`\n✗ ${FILE} breaks the MCP security model:\n`)
  for (const [needle, why] of found) console.error(`  - ${why}  (found "${needle}")`)
  console.error(`\nThe connector must authenticate as the caller so RLS applies.`)
  console.error(`If a tool genuinely needs elevated access, put it in its own edge`)
  console.error(`function with an explicit membership check — not in the MCP server.\n`)
  process.exit(1)
}

console.log(`✓ ${FILE} constructs no service-role client — RLS enforces isolation`)
