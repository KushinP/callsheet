#!/usr/bin/env node
// Asserts that the shared vocabularies agree across the three places they live:
// the SQL enums, the React app's label maps, and the MCP server's Zod schemas.
//
// Each of these lists is written out three times because the three runtimes
// cannot import from each other — the app is bundled by Vite, the connector
// runs on Deno, and Postgres has neither. That is a reasonable constraint and a
// terrible invariant to leave unchecked, because a copy that drifts fails in
// the least useful way available: the schema accepts a value the database then
// rejects, or a report says "Connected – Decision Maker" while the badge beside
// it says "Connected – DM".
//
// Both of those actually happened, which is why this exists.
import { readdirSync, readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

const TYPES = read('src/lib/types.ts')
const MCP = read('supabase/functions/mcp/index.ts')

const failures = []

/**
 * The live values of an enum: its `create type` declaration plus every value a
 * later migration added.
 *
 * Reading only the declaration was fine until an enum grew. `phone_tree` was
 * added by ALTER TYPE, so a checker that stopped at the init file would have
 * reported the app as wrong for knowing about it — a false alarm that trains
 * you to ignore this script, which is worse than not having it.
 */
function sqlEnum(migration, typeName) {
  const src = read(`supabase/migrations/${migration}`)
  const decl = new RegExp(
    `create type public\\.${typeName}\\s+as enum\\s*\\(([^)]*)\\)`, 'i',
  ).exec(src)
  if (!decl) return null

  const values = [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1])

  const dir = new URL('../supabase/migrations/', import.meta.url)
  const added = new RegExp(
    `alter type public\\.${typeName}\\s+add value(?:\\s+if not exists)?\\s+'([^']+)'`, 'gi',
  )
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue
    const body = readFileSync(new URL(file, dir), 'utf8')
    for (const m of body.matchAll(added)) {
      if (!values.includes(m[1])) values.push(m[1])
    }
  }

  return values
}

/** Keys of an object literal like `export const X: Record<…> = { a: '…', … }`. */
function objectKeys(src, name) {
  const at = src.indexOf(name)
  if (at === -1) return null
  const open = src.indexOf('{', at)
  let depth = 0
  let end = open
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++
    else if (src[end] === '}' && --depth === 0) break
  }
  const body = src.slice(open + 1, end)
  return [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\s*:/gim)].map((m) => m[1])
}

/** Members of a `const X = [ "a", "b" ]` array literal. */
function arrayLiteral(src, name) {
  const decl = new RegExp(`${name}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\]`).exec(src)
  if (!decl) return null
  return [...decl[1].matchAll(/['"]([a-z_][a-z0-9_]*)['"]/g)].map((m) => m[1])
}

function compare(what, a, b, aName, bName) {
  if (!a || !b) {
    failures.push(`${what}: could not read ${!a ? aName : bName} — this check needs updating`)
    return
  }
  const missing = a.filter((v) => !b.includes(v))
  const extra = b.filter((v) => !a.includes(v))
  if (missing.length || extra.length) {
    failures.push(
      `${what}: ${aName} and ${bName} disagree\n` +
      (missing.length ? `      only in ${aName}: ${missing.join(', ')}\n` : '') +
      (extra.length ? `      only in ${bName}: ${extra.join(', ')}\n` : ''),
    )
  }
}

// ── Pipeline stages ────────────────────────────────────────────────────────
// The enum is renamed and extended by later migrations, so read the live shape
// from the app and the connector and check them against each other and against
// the stage labels, which is where a new stage most often gets forgotten.
const allStagesApp = arrayLiteral(TYPES, 'ALL_STAGES')

// The grouped lists must between them cover every stage, or a stage exists that
// the funnel renders nowhere — which is how one would go missing silently.
{
  const grouped = ['PIPELINE_STAGES', 'SETBACK_STAGES', 'EXIT_STAGES']
    .flatMap((n) => arrayLiteral(TYPES, n) ?? [])
  compare('stage grouping', allStagesApp, grouped, 'ALL_STAGES', 'the funnel groups')
}
compare('pipeline stages', allStagesApp, arrayLiteral(MCP, 'ALL_STAGES'), 'types.ts', 'mcp/index.ts')
compare('pipeline stages', allStagesApp, objectKeys(TYPES, 'STAGE_LABELS'), 'types.ts', 'STAGE_LABELS')
compare('pipeline stages', allStagesApp, objectKeys(TYPES, 'STAGE_TONES'), 'types.ts', 'STAGE_TONES')

// The outcomes a playbook may fire on, written out in both runtimes. A copy
// that drifts here means the connector offers a trigger the app cannot show, or
// the app offers one the connector rejects.
compare('playbook outcomes',
  arrayLiteral(TYPES, 'PLAYBOOK_OUTCOMES'), arrayLiteral(MCP, 'PLAYBOOK_OUTCOMES'),
  'types.ts', 'mcp/index.ts')

// ── Lead tiers ─────────────────────────────────────────────────────────────
// This is the one that shipped broken: the connector advertised a "d" the
// database has never had, so the request validated and then failed at Postgres.
const tiersSql = sqlEnum('20260905000014_tier_and_tags.sql', 'lead_tier')
compare('lead tiers', tiersSql, arrayLiteral(MCP, 'ALL_TIERS'), 'SQL enum', 'mcp/index.ts')
compare('lead tiers', tiersSql, arrayLiteral(TYPES, 'ALL_TIERS'), 'SQL enum', 'types.ts')

// ── Call outcomes, and their labels ────────────────────────────────────────
const outcomesSql = sqlEnum('20260831000001_init.sql', 'call_outcome')
const outcomesApp = objectKeys(TYPES, 'OUTCOME_LABELS')
compare('call outcomes', outcomesSql, outcomesApp, 'SQL enum', 'types.ts')
compare('call outcomes', outcomesApp, objectKeys(MCP, 'OUTCOME_LABELS'), 'types.ts', 'mcp/index.ts')
compare('call outcomes', outcomesApp, objectKeys(TYPES, 'OUTCOME_TONES'), 'OUTCOME_LABELS', 'OUTCOME_TONES')

// The label TEXT has to match too, not just the keys — a report written by the
// connector sits next to a badge rendered by the app.
{
  const labelText = (src) => {
    const at = src.indexOf('OUTCOME_LABELS')
    const open = src.indexOf('{', at)
    let depth = 0, end = open
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++
      else if (src[end] === '}' && --depth === 0) break
    }
    return Object.fromEntries(
      [...src.slice(open + 1, end).matchAll(/^\s{2}([a-z_]+)\s*:\s*['"](.+?)['"]/gim)]
        .map((m) => [m[1], m[2]]),
    )
  }
  const a = labelText(TYPES)
  const b = labelText(MCP)
  const differing = Object.keys(a).filter((k) => b[k] !== undefined && b[k] !== a[k])
  if (differing.length) {
    failures.push(
      'outcome label text: types.ts and mcp/index.ts disagree\n' +
      differing.map((k) => `      ${k}: "${a[k]}" vs "${b[k]}"`).join('\n') + '\n',
    )
  }
}

// ── Connected outcomes ─────────────────────────────────────────────────────
// Mirrors is_connected_outcome() in SQL. Both TS copies carry a comment saying
// so, which until now nothing verified.
{
  const fnSrc = read('supabase/migrations/20260831000003_functions.sql')
  const body = /create or replace function public\.is_connected_outcome[\s\S]*?\$\$([\s\S]*?)\$\$/i
    .exec(fnSrc)
  const sqlList = body ? [...body[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : null
  compare('connected outcomes', sqlList, arrayLiteral(MCP, 'CONNECTED_OUTCOMES'),
    'is_connected_outcome()', 'mcp/index.ts')
}

if (failures.length) {
  console.error('\n✗ shared vocabularies have drifted:\n')
  for (const f of failures) console.error(`  - ${f}`)
  console.error(
    'These lists are written out once per runtime because the three cannot\n' +
    'import from each other. Update every copy, or this fails in the least\n' +
    'useful way available: a request that validates and then dies at Postgres.\n',
  )
  process.exit(1)
}

console.log('  ✓ stages, tiers and outcomes agree across SQL, the app and the connector')
