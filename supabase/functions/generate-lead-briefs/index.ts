/**
 * generate-lead-briefs — a short pre-call brief for every lead.
 *
 * Called by the app after an import, and safe to call repeatedly: the RPC only
 * returns leads that have no brief, so re-running costs nothing and the unique
 * constraint on (lead_id, kind) catches any race the RPC misses.
 *
 * Batched on purpose. A 5,000-row CSV must not become 5,000 model calls on the
 * import's critical path — the caller loops on `remaining` and can stop whenever
 * it likes, and anything left is picked up by the next run.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { env, requireMember } from '../_shared/db.ts'
import { errorResponse, json, preflight } from '../_shared/http.ts'
import { completeText, textAvailable } from '../_shared/llm.ts'

declare const Deno: { serve(handler: (req: Request) => Promise<Response>): void }

const DEFAULT_BATCH = 20
const MAX_BATCH = 50
const CONCURRENCY = 5
/** Leave headroom under the platform's wall clock so a slow batch fails cleanly. */
const BUDGET_MS = 90_000

const SYSTEM = `You brief a salesperson in the ten seconds before they dial a cold call.

You are given one business, from a purchased or scraped list. Write what is
useful to the person holding the phone and nothing else.

Rules:
- Never invent specifics. You do not know their revenue, their staff, their
  systems or their problems. If a field is absent, work from what the category
  and location make LIKELY, and say so in those terms.
- "angle" is one sentence on why this business might care at all.
- "opener" is a single spoken line, under 25 words, that a human would say out
  loud. No corporate throat-clearing.
- "questions" are three short things worth asking to qualify them.
- "watch_out" is what would make this a waste of time, or what not to say.
- confidence is "low" whenever you are working from little more than a name.
- "tier" is how worth calling this looks: a = call today, b = worth a call,
  c = only if the list runs dry. Judge it on how likely they are to have the
  problem AND to be able to act on it. Most leads are b; if everything is an a
  the tier means nothing.
- "tier_reason" is one line the rep reads when deciding whether to overrule you.

Be terse. This is read while the phone rings, not studied.`

const SCHEMA = {
  type: 'OBJECT',
  required: ['angle', 'opener', 'questions', 'watch_out', 'confidence', 'attributes',
             'tier', 'tier_reason'],
  properties: {
    tier: { type: 'STRING', enum: ['a', 'b', 'c'] },
    tier_reason: { type: 'STRING' },
    angle: { type: 'STRING' },
    opener: { type: 'STRING' },
    questions: { type: 'ARRAY', items: { type: 'STRING' } },
    watch_out: { type: 'STRING' },
    confidence: { type: 'STRING', enum: ['high', 'low'] },
    // Structured facts so analytics can group by them later. Values must be
    // stable enough to aggregate, which is why the enums are narrow.
    attributes: {
      type: 'OBJECT',
      properties: {
        business_type: { type: 'STRING' },
        segment: { type: 'STRING', enum: ['budget', 'midscale', 'upscale', 'luxury', 'unknown'] },
        size_band: { type: 'STRING', enum: ['very_small', 'small', 'medium', 'large', 'unknown'] },
        independent: { type: 'STRING', enum: ['independent', 'chain', 'unknown'] },
      },
    },
  },
}

interface Brief {
  tier: 'a' | 'b' | 'c'
  tier_reason: string
  angle: string
  opener: string
  questions: string[]
  watch_out: string
  confidence: 'high' | 'low'
  attributes: Record<string, string>
}

interface LeadRow {
  id: string
  business_name: string
  contact_name: string | null
  room_count: number | null
  phone: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  website: string | null
  email: string | null
  notes: string | null
  metadata_json: Record<string, unknown>
}

function describe(lead: LeadRow): string {
  const known = Object.entries({
    Name: lead.business_name,
    // Room count left metadata_json when it became a column, and until this
    // was added the model had not seen one since — so it scored 2-room B&Bs as
    // tier A on pain signals alone.
    Rooms: lead.room_count ? String(lead.room_count) : null,
    Contact: lead.contact_name,
    Address: [lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(', '),
    Website: lead.website,
    Email: lead.email,
    'Existing notes': lead.notes,
    Extra: Object.keys(lead.metadata_json ?? {}).length
      ? JSON.stringify(lead.metadata_json)
      : null,
  }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)

  return `Business to brief:\n${known.join('\n')}`
}

function render(b: Brief): string {
  const lines = [
    b.angle,
    '',
    `**Opener** — "${b.opener}"`,
    '',
    '**Ask**',
    ...b.questions.slice(0, 3).map((q) => `- ${q}`),
  ]
  if (b.watch_out?.trim()) lines.push('', `**Watch out** — ${b.watch_out}`)
  if (b.confidence === 'low') {
    lines.push('', '_Thin list data — this is inference from the name and area, not research._')
  }
  return lines.join('\n')
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const body = await req.json() as { workspaceId?: string; limit?: number }
    if (!body.workspaceId) return json({ error: 'workspaceId is required' }, 400)

    // The caller is a signed-in member, not an internal secret: this is invoked
    // straight from the import dialog.
    await requireMember(req, body.workspaceId)

    // Availability first, and as a 200. A non-2xx would make callFunction()
    // throw and raise a toast, and "no API key configured" is not something to
    // interrupt an import with.
    if (!textAvailable()) {
      return json({ available: false, generated: 0, failed: 0, remaining: 0, reason: 'no_llm_key' })
    }

    const limit = Math.min(Math.max(body.limit ?? DEFAULT_BATCH, 1), MAX_BATCH)

    // Run as the caller, not the service role. leads_needing_brief is
    // security-invoker and gates on is_workspace_member, which the service role
    // is not — calling it with the service key returns 403 every time. Running
    // as the user also means RLS decides which leads are reachable, so a bug
    // here cannot reach another workspace's list.
    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // The floor is the workspace's. The model hears it so tier_reason can say
    // why, but the database caps the stored tier regardless — that is what
    // makes it a guarantee rather than a request.
    const { data: wsRow } = await db
      .from('workspaces').select('min_rooms').eq('id', body.workspaceId).maybeSingle()
    const minRooms = (wsRow as { min_rooms: number | null } | null)?.min_rooms ?? null
    const system = minRooms
      ? `${SYSTEM}\n\nSize floor: a property with fewer than ${minRooms} rooms is too small to ` +
        `be worth a call. If Rooms is below ${minRooms}, tier is c whatever else is true, and ` +
        `tier_reason says it is under the floor.`
      : SYSTEM

    const { data: leads, error } = await db.rpc('leads_needing_brief', {
      ws: body.workspaceId,
      max_rows: limit,
    })
    // Shape the failure like a completed run so the caller's loop still has
    // the counters it breaks on.
    if (error) {
      return json({
        available: true, generated: 0, failed: 0, remaining: 0, error: error.message,
      })
    }

    const queue = (leads ?? []) as LeadRow[]
    if (queue.length === 0) {
      return json({ available: true, generated: 0, failed: 0, remaining: 0 })
    }

    const startedAt = Date.now()
    let generated = 0
    let failed = 0
    let costUsd = 0
    let stoppedEarly = false

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const lead = queue.shift()
        if (!lead) return
        if (Date.now() - startedAt > BUDGET_MS) {
          stoppedEarly = true
          return
        }

        try {
          const result = await completeText<Brief>({
            system,
            prompt: describe(lead),
            schema: SCHEMA,
            maxTokens: 700,
          })

          // ignoreDuplicates: two overlapping runs must not fight over a lead.
          const { error: writeErr } = await db.from('documents').upsert({
            workspace_id: body.workspaceId,
            kind: 'lead_brief',
            lead_id: lead.id,
            title: `Pre-call brief — ${lead.business_name}`,
            body_md: render(result.value),
            summary_json: result.value.attributes ?? {},
            author: 'system',
            model: result.model,
            cost_usd: result.costUsd,
          }, { onConflict: 'lead_id,kind', ignoreDuplicates: true })

          if (writeErr) throw new Error(writeErr.message)

          // A suggestion, never a decision. `tier` on the lead is a generated
          // column over the human's override, so writing tier_suggested cannot
          // overrule a rep who has already made the call.
          if (result.value.tier) {
            await db.from('leads').update({
              tier_suggested: result.value.tier,
              tier_suggested_reason: (result.value.tier_reason ?? '').slice(0, 280) || null,
            }).eq('id', lead.id)
          }

          generated += 1
          costUsd += result.costUsd ?? 0
        } catch (e) {
          // One bad lead must not abort the batch.
          failed += 1
          console.error('brief failed', lead.id, (e as Error).message)
        }
      }
    })

    await Promise.all(workers)

    // What is left for the caller to loop on, counting anything this run
    // deliberately did not reach.
    const { data: still } = await db.rpc('leads_needing_brief', {
      ws: body.workspaceId, max_rows: MAX_BATCH,
    })

    return json({
      available: true,
      generated,
      failed,
      remaining: (still ?? []).length,
      stopped_early: stoppedEarly || undefined,
      cost_usd: Number(costUsd.toFixed(6)),
    })
  } catch (error) {
    return errorResponse(error)
  }
})
