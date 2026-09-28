// Callsheet MCP server as a Supabase Edge Function — the OAuth-authenticated connector Claude
// talks to. Claude discovers the auth server via this function's protected-resource metadata,
// the user approves access, and Supabase issues a token this function validates per request.
//
// Deployed with verify_jwt = false: auth happens in-function so the OAuth discovery handshake
// (an unauthenticated request must get 401 + WWW-Authenticate pointing at our metadata) works.
//
// SECURITY MODEL — deliberately different from the PriMed connector this mirrors.
// PriMed uses a service-role client and filters `user_id` by hand in every query, backed by a
// grep test that fails if the filter is missing. Callsheet does NOT do that. It has complete
// RLS keyed on is_workspace_member(workspace_id), already covered by the isolation suite in
// supabase/tests/rls_test.sql, so this function passes the CALLER'S token to an ordinary
// supabase-js client and lets Postgres enforce the boundary. Consequences worth stating:
//   - A tool that forgets a workspace filter returns the caller's OWN rows across their own
//     workspaces — a wrong answer, not a cross-tenant leak.
//   - workspace_twilio_secrets has RLS on and zero policies, so no tool here can read a Twilio
//     auth token even by accident.
//   - The existing RPCs are `security invoker` and granted to `authenticated`; they are designed
//     to be called exactly this way and would need membership re-asserted by hand on service role.
// There is intentionally no service-role client in this file. supabase/tests/mcp_no_service_role
// asserts that, and that single assertion is stronger than a proximity heuristic over every query.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Hono } from "npm:hono@^4.9.7";
import { cors } from "npm:hono@^4.9.7/cors";
import { z } from "npm:zod@^4.1.13";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESOURCE = `${SUPABASE_URL}/functions/v1/mcp`;
const METADATA_URL = `${RESOURCE}/.well-known/oauth-protected-resource`;

// ── Vocabulary (mirrors src/lib/types.ts — keep the two in sync) ────────────
const OUTCOME_LABELS: Record<string, string> = {
  connected_dm: "Connected – DM",
  connected_gk: "Connected – Gatekeeper",
  connected_other: "Connected – Other",
  voicemail: "Voicemail",
  phone_tree: "Phone Tree",
  ai_competitor: "AI Competitor",
  busy: "Busy",
  no_answer: "No Answer",
  bad_number: "Bad Number",
  not_interested: "Not Interested",
  do_not_call: "Do Not Call",
  callback_requested: "Callback Requested",
  appointment_set: "Appointment Set",
  dialed: "Dialed",
};

const ALL_OUTCOMES = Object.keys(OUTCOME_LABELS) as [string, ...string[]];

/*
 * public.pipeline_stage, in enum order.
 *
 * Declared once because it was previously spelled out at three call sites, and
 * when the database renamed 'demo' the schemas advertised to the client went
 * stale independently — the server accepted values its own tool definitions
 * said did not exist. One list cannot disagree with itself.
 */
/** public.lead_tier. There is no "d" — declaring one only produced a
 *  schema-valid request that failed at Postgres with an enum cast error. */
const ALL_TIERS = ["a", "b", "c"] as [string, ...string[]];

const ALL_STAGES = [
  "new", "called", "demo_booked", "demo_no_show", "demo_completed",
  "pilot", "paying", "lost", "not_a_fit",
] as [string, ...string[]];

/**
 * Outcomes a playbook may fire on. Mirrors PLAYBOOK_OUTCOMES in types.ts.
 * do_not_call and bad_number are barred by the database: a closed lead does not
 * need work scheduling.
 */
const PLAYBOOK_OUTCOMES = [
  "callback_requested", "connected_dm", "connected_gk", "voicemail",
  "phone_tree", "ai_competitor", "not_interested",
] as [string, ...string[]];

/** Stages a playbook may fire on. Terminal stages cancel work, never create it. */
const PLAYBOOK_STAGES = ALL_STAGES.filter(
  (s) => s !== "lost" && s !== "not_a_fit",
) as [string, ...string[]];

// Outcomes that required a human on the other end. Mirrors is_connected_outcome() in SQL.
const CONNECTED_OUTCOMES = [
  "connected_dm", "connected_gk", "connected_other",
  "appointment_set", "callback_requested", "not_interested", "do_not_call",
];

const CALL_FIELDS =
  "id, called_at, business_name, phone, outcome, call_status, duration_seconds, " +
  "notes, lead_id, session_id, recording_sid, mode, direction, missed";

// ── Helpers ────────────────────────────────────────────────────────────────
const jsonResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Local-day bounds as UTC instants, so "today" means the rep's today. */
function dayBounds(date: string | undefined, timeZone: string): { startUtc: string; endUtc: string; date: string } {
  const now = new Date();
  const local = date ?? new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);

  // Find the UTC instant for local midnight by probing the zone's offset on that date.
  const probe = new Date(`${local}T12:00:00Z`);
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const offset = tzName.replace("GMT", "") || "+00:00";
  const startUtc = new Date(`${local}T00:00:00${offset}`).toISOString();
  const endUtc = new Date(new Date(startUtc).getTime() + 86_400_000).toISOString();
  return { startUtc, endUtc, date: local };
}

interface CallRow {
  id: string; called_at: string; business_name: string | null; phone: string;
  outcome: string | null; call_status: string; duration_seconds: number;
  notes: string | null; lead_id: string | null; session_id: string | null;
  recording_sid: string | null; mode: string;
}

/**
 * Resolve which workspace a tool call is about.
 *
 * Never guesses when there is more than one: a wrong guess would write a script or a review
 * into another team's workspace. Returns a normal tool result asking for the id instead, which
 * Claude can act on without an error round-trip.
 */
async function resolveWorkspace(
  db: SupabaseClient,
  requested?: string,
): Promise<
  { ok: true; id: string; timezone: string }
  | { ok: false; result: ReturnType<typeof jsonResult> }
> {
  const { data, error } = await db
    .from("workspace_members")
    // timezone rides along so every date-scoped tool can default to the rep's
    // own clock. Defaulting to UTC meant "calls today" from here and "calls
    // today" on the dashboard disagreed for the last four hours of every day.
    .select("workspace_id, role, workspaces(name, timezone)")
    .order("created_at", { ascending: true });

  if (error) {
    return { ok: false, result: jsonResult({ error: "lookup_failed", detail: error.message }) };
  }

  const rows = (data ?? []) as unknown as {
    workspace_id: string; role: string;
    workspaces: { name: string; timezone: string | null } | null;
  }[];

  if (rows.length === 0) {
    return { ok: false, result: jsonResult({ error: "no_workspace", hint: "This account has no workspace yet." }) };
  }

  if (requested) {
    // RLS already decides whether this id is reachable; a foreign id simply returns nothing.
    const hit = rows.find((r) => r.workspace_id === requested);
    if (!hit) {
      return { ok: false, result: jsonResult({
        error: "unknown_workspace",
        workspaces: rows.map((r) => ({ id: r.workspace_id, name: r.workspaces?.name })),
      }) };
    }
    return { ok: true, id: requested, timezone: hit.workspaces?.timezone ?? "UTC" };
  }

  if (rows.length > 1) {
    return { ok: false, result: jsonResult({
      error: "ambiguous_workspace",
      hint: "Pass workspace_id — this account belongs to more than one.",
      workspaces: rows.map((r) => ({ id: r.workspace_id, name: r.workspaces?.name, role: r.role })),
    }) };
  }

  return {
    ok: true,
    id: rows[0].workspace_id,
    timezone: rows[0].workspaces?.timezone ?? "UTC",
  };
}


// A script block, as the prompter reads it. Mirrors validate_script_blocks() in
// SQL — the database rejects anything malformed regardless, but describing the
// shape here means Claude gets it right the first time.
const BLOCK_KINDS = ['opening', 'question', 'pitch', 'objection', 'close', 'voicemail', 'note'] as const

const scriptBlock = z.object({
  id: z.string().min(1).describe('Unique within the script, e.g. "opening" or "obj_price".'),
  kind: z.enum(BLOCK_KINDS),
  label: z.string().optional().describe('Short heading shown on the prompter card.'),
  text: z.string().min(1).describe('What the rep SAYS, and nothing else. Put quoted lines in quotes — the prompter renders anything quoted as spoken words and anything else as a dimmed delivery cue. Use {{business_name}}, {{city}}, {{state}} to interpolate the lead.'),
  notes: z.string().max(2000).optional()
    .describe('Why the block is worded this way. Never rendered mid-call; keep rationale here rather than in text, where it would sit inline with the words and get read out.'),
  advance_label: z.string().max(40).optional()
    .describe('The primary action IN THE PROSPECT\'S VOICE, e.g. "They said yes", "They answered", "Got a number". The branch chips beside it read as things a prospect says, so a button reading "Next" makes the rep translate mid-call. Defaults to a generic one derived from advance_on.'),
  advance_on: z.array(z.string()).optional()
    .describe('Phrases meaning this block worked and the call moves on.'),
  branches: z.array(z.object({
    trigger: z.array(z.string()).min(1).describe('Phrases the lead might say.'),
    goto: z.string().describe('id of the block to jump to. Must exist in this script.'),
    label: z.string().optional(),
  })).optional().describe('Objection handling. Rendered as clickable cards during the call.'),
  next: z.string().optional()
    .describe('id of the next block. Omit to fall through to the next one in order.'),
})

const wsArg = { workspace_id: z.string().uuid().optional() };

// ── Connection instructions (returned at MCP initialize) ────────────────────
const INSTRUCTIONS = `You are the Callsheet analyst — you work with the call data inside Callsheet, a power-dialer CRM for cold-calling local service businesses.

How to work:
1. Read before you write. Pull the actual calls and transcripts with the tools; never characterise a call you have not read.
2. Never invent a quote. If you attribute words to a lead or the rep, they must appear verbatim in the transcript. If there is no transcript, say the call was not transcribed rather than guessing what was said.
3. Disposition vocabulary is fixed. Outcomes are stored snake_case and shown with human labels:
${Object.entries(OUTCOME_LABELS).map(([k, v]) => `   ${k} = ${v}`).join("\n")}
   A call "connected" if its outcome is one of: ${CONNECTED_OUTCOMES.join(", ")} — each required a human on the line.
4. Data is scoped to a workspace. Most accounts have exactly one and you can omit workspace_id. If a tool reports ambiguous_workspace, ask which one rather than picking.

The end-of-day summary is the main job. Call get_daily_summary once — it returns everything needed in one shot: counts, the outcome breakdown, connection rate, talk time, sessions worked, and the calls worth mentioning. Write it as the rep would post it to their team: what got done, what came of it, what needs following up tomorrow. Lead with outcomes (appointments, callbacks), not raw dial counts. Be honest about a slow day; do not inflate.

Scripts are what the rep reads from while dialling. put_script writes a whole script in one call; the database validates the block graph, so a rejected write comes back with the specific reason. When asked to add an objection, read the script first with get_script, add a branch on the block where that objection actually comes up, and hand the whole script back.

Reading transcripts is a core job. search_transcripts finds calls by what was said; list_transcripts shows what is available; get_call_transcript returns the full text. Always read the full text before quoting - snippets are truncated. Only connected calls are transcribed, so a missing transcript usually means voicemail or no answer, not a failure.

Transcripts vary in fidelity. Some carry a low speaker-confidence flag, meaning agent and lead may be mislabelled — read those with suspicion and say so if you rely on one.

**Working the task list.** list_tasks returns what is due with the lead, its brief and its last call already attached — one call, then act. Each task carries \`actionable\` and \`blocked_reason\`; trust them rather than re-deriving the rules.

Callsheet does not send email and never will, for the same reason there is no Slack tool: you already have mail connectors, and Callsheet's job is to know what needs sending, not to hold a second set of credentials. Draft from the brief and the last call's notes, send it through your own connector, then complete_task with a one-line outcome_note saying what you actually did and result_json carrying the message id and recipient. That id is the audit trail — it is what lets the rep open the real email instead of taking your word for it.

A task you cannot do is not a task you complete. If blocked_reason is no_email_on_lead, find the address and update_lead it, or snooze_task with the reason. If it is needs_a_human, leave it and name it in your summary. Never mark done something you did not do; the list stops being trustworthy the first time that happens.

**Stages and playbooks.** set_lead_stage is what creates follow-up — moving a lead into a stage fires that stage's playbook and the response lists the tasks it created. Booking a demo and holding one are separate stages: demo_booked is the commitment, demo_completed is the delivery, and a no-show stays booked until the rep says otherwise. Do not move a lead forward on your own reading of a transcript; propose it and let the rep decide. The one thing worth doing unprompted is suggest_lead_tier after reading a brief or a first call. put_playbook writes a whole playbook in one shot, validated by the database. Write the fewest steps that actually get done — three real ones beat eight that get snoozed.

get_performance is the other half of writing a report: get_period_summary says what happened, get_performance says how the calling itself is going — best hours, day of week, which script converts, dials per connect. Both were app-only before, so a weekly report was written around numbers you could not see.

Reports are documents, not chat messages. put_report stores one in the app where it stays browsable, so give it a title and write the body to be read on its own later — someone opening it in a month has none of this conversation. Read get_period_summary first and write from those numbers; do not assemble a week out of seven daily summaries, which comes out differently every time. Dates are HALF-OPEN: period_end is the day AFTER the last day counted, so a Mon-Sun week is (Monday, the following Monday). Regenerating a period rewrites that report rather than adding a second. The stored body comes back in the response — if the rep also wants it in Slack, post that text verbatim through your Slack connector so the two never drift apart. There is deliberately no Slack tool here.

Building lead lists is a real job too. Call describe_lead_fields once, then create_leads — it is idempotent on the phone number, so a re-run updates instead of duplicating, and anything without a column belongs in metadata_json under stable snake_case keys, because analytics groups by those. You cannot delete leads; that stays in the app where a human is looking at what goes.

list_leads returns pipeline_stage, tier and tags, and filters on all three. A lead has ONE state you manage — pipeline_stage — plus outcome, which is how its most recent call went and is derived from the call log rather than set on the lead. Backticks are deliberately absent from this block: it is a template literal and one breaks the bundle.

create_call is for calls that happened somewhere else — a mobile, an old spreadsheet, history sitting in a lead's notes as prose. Until it is logged, call_count and every rolling stat understate what actually happened. It is not idempotent, so read get_lead's history first. create_session freezes a filtered slice into a queue for the dialer; it builds the list and nothing else, so hand the rep the session and let them start it.

put_lead_brief is for what you know about a business before dialling: the angle, the likely pain, who to ask for, what not to say. Keep it short enough to read while the phone is ringing.`;

// ── MCP server (one per request, bound to the caller's token) ───────────────
function buildServer(db: SupabaseClient): McpServer {
  const server = new McpServer(
    { name: "callsheet", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  // ── Reads ────────────────────────────────────────────────────────────────
  server.registerTool("list_workspaces",
    {
      title: "List workspaces",
      description: "The workspaces this account belongs to, with the role held in each. Call this when another tool reports an ambiguous workspace.",
      inputSchema: {},
    },
    async () => {
      const { data, error } = await db
        .from("workspace_members")
        .select("workspace_id, role, workspaces(name, created_at, timezone)")
        .order("created_at", { ascending: true });
      if (error) return jsonResult({ error: error.message });
      const rows = (data ?? []) as unknown as {
        workspace_id: string; role: string; workspaces: { name: string; created_at: string } | null;
      }[];
      return jsonResult({
        workspaces: rows.map((r) => ({
          id: r.workspace_id,
          name: r.workspaces?.name ?? null,
          role: r.role,
          // The rep's own clock. Every date-scoped tool below defaults to it,
          // so "today" means the same thing here as it does on the dashboard.
          timezone: r.workspaces?.timezone ?? "UTC",
        })),
      });
    });

  server.registerTool("get_daily_summary",
    {
      title: "Get daily summary",
      description: "Everything that happened on one local day, in one call: every call with its outcome and duration, the outcome breakdown, connection rate, talk time, unique leads touched, sessions worked, and the calls worth mentioning. This is the tool for an end-of-day summary — prefer it over assembling list_calls yourself.",
      inputSchema: {
        ...wsArg,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("Local calendar day, YYYY-MM-DD. Defaults to today in `timezone`."),
        timezone: z.string().optional().describe("IANA zone, e.g. America/Chicago. Defaults to UTC."),
      },
    },
    async ({ workspace_id, date, timezone }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const tz = timezone ?? ws.timezone;
      const { startUtc, endUtc, date: day } = dayBounds(date, tz);

      const { data, error } = await db
        .from("dial_call_logs")
        .select(CALL_FIELDS)
        .eq("workspace_id", ws.id)
        .gte("called_at", startUtc)
        .lt("called_at", endUtc)
        .order("called_at", { ascending: true });
      if (error) return jsonResult({ error: error.message });

      const calls = (data ?? []) as unknown as CallRow[];
      const dispositioned = calls.filter((c) => c.outcome);
      const connected = calls.filter((c) => c.outcome && CONNECTED_OUTCOMES.includes(c.outcome));
      const talkSeconds = calls.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0);

      const byOutcome: Record<string, number> = {};
      for (const c of dispositioned) {
        byOutcome[c.outcome!] = (byOutcome[c.outcome!] ?? 0) + 1;
      }

      const sessionIds = [...new Set(calls.map((c) => c.session_id).filter(Boolean))] as string[];
      let sessions: unknown[] = [];
      if (sessionIds.length) {
        const { data: s } = await db
          .from("calling_sessions")
          .select("id, name, status, total_leads, completed_leads")
          .in("id", sessionIds);
        sessions = s ?? [];
      }

      // Worth mentioning: anything that moved the needle or needs a follow-up.
      const notable = calls
        .filter((c) => c.outcome && (
          ["appointment_set", "callback_requested", "connected_dm", "do_not_call"].includes(c.outcome) ||
          (c.notes && c.notes.trim().length > 0)
        ))
        .map((c) => ({
          id: c.id,
          business_name: c.business_name,
          phone: c.phone,
          outcome: c.outcome,
          outcome_label: c.outcome ? OUTCOME_LABELS[c.outcome] : null,
          duration: fmtDuration(c.duration_seconds),
          notes: c.notes,
          called_at: c.called_at,
        }));

      return jsonResult({
        date: day,
        timezone: tz,
        totals: {
          calls: calls.length,
          dispositioned: dispositioned.length,
          connected: connected.length,
          connection_rate_pct: dispositioned.length
            ? Math.round((connected.length / dispositioned.length) * 1000) / 10
            : 0,
          unique_leads: new Set(calls.map((c) => c.lead_id).filter(Boolean)).size,
          talk_time: fmtDuration(talkSeconds),
          talk_seconds: talkSeconds,
        },
        by_outcome: Object.fromEntries(
          Object.entries(byOutcome)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => [k, { count: v, label: OUTCOME_LABELS[k] }]),
        ),
        appointments_set: byOutcome["appointment_set"] ?? 0,
        callbacks_requested: byOutcome["callback_requested"] ?? 0,
        sessions,
        notable_calls: notable,
        note: calls.length === 0
          ? `No calls were logged on ${day} in ${tz}. Say so plainly rather than reporting zeros as if they were a result.`
          : undefined,
      });
    });

  server.registerTool("get_call_stats",
    {
      title: "Get call stats",
      description: "Rolling KPIs straight from the dashboard: calls today/this week/this month, unique leads touched in each, talk time today, and the month's connection rate.",
      inputSchema: { ...wsArg, timezone: z.string().optional() },
    },
    async ({ workspace_id, timezone }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;
      const { data, error } = await db.rpc("workspace_call_stats", {
        ws: ws.id, tz: timezone ?? ws.timezone,
      });
      if (error) return jsonResult({ error: error.message });
      return jsonResult({ stats: data });
    });

  server.registerTool("list_calls",
    {
      title: "List calls",
      description:
        "Recent calls with business, phone, outcome, duration and whether a " +
        "transcript exists. Filter by day, session, lead or outcome. Pass " +
        "missed_only to see inbound calls nobody picked up — those carry no " +
        "outcome, so an outcome filter will never find them.",
      inputSchema: {
        ...wsArg,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone: z.string().optional(),
        outcomes: z.array(z.enum(ALL_OUTCOMES)).optional(),
        session_id: z.string().uuid().optional(),
        lead_id: z.string().uuid().optional(),
        missed_only: z.boolean().optional()
          .describe("Inbound calls that ended without anyone answering."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ workspace_id, date, timezone, outcomes, session_id, lead_id, missed_only, limit }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      let q = db
        .from("dial_call_logs")
        .select(`${CALL_FIELDS}, call_transcripts(id)`)
        .eq("workspace_id", ws.id);

      if (date) {
        const { startUtc, endUtc } = dayBounds(date, timezone ?? ws.timezone);
        q = q.gte("called_at", startUtc).lt("called_at", endUtc);
      }
      if (outcomes?.length) q = q.in("outcome", outcomes);
      if (session_id) q = q.eq("session_id", session_id);
      if (lead_id) q = q.eq("lead_id", lead_id);
      if (missed_only) q = q.eq("missed", true);

      const { data, error } = await q
        .order("called_at", { ascending: false })
        .limit(limit ?? 50);
      if (error) return jsonResult({ error: error.message });

      const rows = (data ?? []) as unknown as (CallRow & { call_transcripts: { id: string }[] })[];
      return jsonResult({
        calls: rows.map((c) => ({
          id: c.id,
          called_at: c.called_at,
          business_name: c.business_name,
          phone: c.phone,
          outcome: c.outcome,
          outcome_label: c.outcome ? OUTCOME_LABELS[c.outcome] : null,
          duration: fmtDuration(c.duration_seconds),
          notes: c.notes,
          lead_id: c.lead_id,
          session_id: c.session_id,
          has_recording: Boolean(c.recording_sid),
          has_transcript: (c.call_transcripts ?? []).length > 0,
        })),
      });
    });

  server.registerTool("get_call",
    {
      title: "Get call",
      description: "One call in full: metadata, notes, and its transcript if one exists.",
      inputSchema: { call_id: z.string().uuid() },
    },
    async ({ call_id }) => {
      const { data, error } = await db
        .from("dial_call_logs")
        .select("*, call_transcripts(transcript_text, source, created_at)")
        .eq("id", call_id)
        .maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found", hint: "No call with that id is visible to this account." });
      return jsonResult({ call: data });
    });

  server.registerTool("get_call_transcript",
    {
      title: "Get call transcript",
      description: "The transcript for one call. Returns null when the call was never transcribed — say that rather than inferring what was said.",
      inputSchema: { call_id: z.string().uuid() },
    },
    async ({ call_id }) => {
      const { data, error } = await db
        .from("call_transcripts")
        .select("transcript_text, source, created_at")
        .eq("call_id", call_id)
        .maybeSingle();
      if (error) return jsonResult({ error: error.message });
      return jsonResult({ call_id, transcript: data ?? null });
    });

  /*
   * Which script a session serves, said plainly.
   *
   * A session either pins a script or follows the workspace default, and no
   * response said which — so on 9 Sep a pending session kept serving v6 forty
   * minutes after the default moved to v8, and nothing reading it could tell.
   */
  type ScriptRow = { id: string; name: string; is_default: boolean };
  const loadScripts = async (wsId: string): Promise<ScriptRow[]> => {
    const { data } = await db.from("call_scripts")
      .select("id, name, is_default").eq("workspace_id", wsId);
    return (data ?? []) as ScriptRow[];
  };
  const sessionScript = (scripts: ScriptRow[], scriptId: string | null) => {
    if (scriptId) {
      const pinned = scripts.find((x) => x.id === scriptId);
      return {
        id: scriptId, name: pinned?.name ?? null, pinned: true,
        is_current_default: pinned?.is_default ?? false,
      };
    }
    const fallback = scripts.find((x) => x.is_default);
    return {
      id: fallback?.id ?? null, name: fallback?.name ?? null, pinned: false,
      note: "Follows the workspace default, so a new default reaches this session.",
    };
  };

  server.registerTool("list_sessions",
    {
      title: "List calling sessions",
      description: "Calling sessions with status and progress, newest first.",
      inputSchema: { ...wsArg, limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ workspace_id, limit }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;
      const { data, error } = await db
        .from("calling_sessions")
        .select("id, name, status, total_leads, completed_leads, created_at, started_at, completed_at, script_id")
        .eq("workspace_id", ws.id)
        .order("created_at", { ascending: false })
        .limit(limit ?? 25);
      if (error) return jsonResult({ error: error.message });
      const scripts = await loadScripts(ws.id);
      return jsonResult({
        sessions: ((data ?? []) as { script_id: string | null }[])
          .map((row) => ({ ...row, script: sessionScript(scripts, row.script_id) })),
      });
    });

  server.registerTool("get_session",
    {
      title: "Get session",
      description: "One calling session: its filters, queue progress, and the outcome breakdown of calls placed from it.",
      inputSchema: { session_id: z.string().uuid() },
    },
    async ({ session_id }) => {
      const { data: session, error } = await db
        .from("calling_sessions").select("*").eq("id", session_id).maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!session) return jsonResult({ error: "not_found" });

      const { data: calls } = await db
        .from("dial_call_logs").select("outcome").eq("session_id", session_id);
      const byOutcome: Record<string, number> = {};
      for (const c of (calls ?? []) as { outcome: string | null }[]) {
        if (c.outcome) byOutcome[c.outcome] = (byOutcome[c.outcome] ?? 0) + 1;
      }
      const scripts = await loadScripts((session as { workspace_id: string }).workspace_id);
      return jsonResult({
        session,
        script: sessionScript(scripts, (session as { script_id: string | null }).script_id),
        calls_placed: (calls ?? []).length,
        by_outcome: byOutcome,
      });
    });

  server.registerTool("delete_session",
    {
      title: "Delete a calling session",
      description:
        "Remove a session built by mistake. Refused while it is active, and " +
        "refused once any call has been placed from it — at that point it is " +
        "the record of those calls, not a queue. Its queue goes with it; the " +
        "leads themselves are untouched.",
      inputSchema: { session_id: z.string().uuid() },
    },
    async ({ session_id }) => {
      const { data, error } = await db.from("calling_sessions")
        .select("id, name, status, total_leads").eq("id", session_id).maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found" });
      const session = data as { id: string; name: string; status: string; total_leads: number };

      if (session.status === "active") {
        return jsonResult({ error: "session_active", hint: "Pause or complete it in the app first." });
      }

      const { count, error: countError } = await db.from("dial_call_logs")
        .select("id", { count: "exact", head: true }).eq("session_id", session_id);
      if (countError) return jsonResult({ error: countError.message });
      if ((count ?? 0) > 0) {
        return jsonResult({
          error: "session_has_calls",
          calls_placed: count,
          hint: "Calls were placed from this session, so it stays as their record. Mark it completed instead.",
        });
      }

      // session_leads cascades; dial_call_logs would only lose the link, and the
      // check above means there are none.
      const { error: deleteError } = await db.from("calling_sessions").delete().eq("id", session_id);
      if (deleteError) return jsonResult({ error: deleteError.message });
      return jsonResult({ ok: true, deleted: session.name, queue_removed: session.total_leads });
    });

  server.registerTool("list_leads",
    {
      title: "List leads",
      description:
        "Leads matching a filter, with where each one is in the pipeline. " +
        "`stage` is the deal (demo_booked, pilot…) and `outcome` is how the " +
        "most recent call went. Filter on stages to answer " +
        "\"who has a demo booked\". Do-not-call leads are excluded unless " +
        "include_dnc is set.",
      inputSchema: {
        ...wsArg,
        search: z.string().optional()
          .describe("Matches business name, contact name, phone, city or address."),
        city: z.string().optional(),
        state: z.string().optional(),
        stages: z.array(z.enum(ALL_STAGES)).optional()
          .describe("Where the deal is. This is the one you almost always want."),
        tiers: z.array(z.enum(ALL_TIERS)).optional(),
        rooms_min: z.number().int().min(1).optional(),
        rooms_max: z.number().int().min(1).optional()
          .describe("Room-count bounds. A lead with no count is excluded by either — unknown is not zero."),
        tags: z.array(z.string()).optional()
          .describe("Match any, not all — a lead tagged either one comes back."),
        outcomes: z.array(z.enum(ALL_OUTCOMES)).optional()
          .describe("How the lead's most recent call went."),
        never_called: z.boolean().optional(),
        include_dnc: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({
      workspace_id, search, city, state, stages, tiers, tags,
      rooms_min, rooms_max, outcomes, never_called, include_dnc, limit,
    }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      let q = db
        .from("leads")
        .select(
          "id, business_name, contact_name, room_count, phone, city, state, " +
          "pipeline_stage, stage_changed_at, scheduled_at, tier, tags, " +
          "outcome, do_not_call, call_count, last_called_at, notes",
        )
        .eq("workspace_id", ws.id);

      if (!include_dnc) q = q.eq("do_not_call", false);
      if (search) q = q.ilike("search_blob", `%${search.toLowerCase()}%`);
      if (city) q = q.ilike("city", city);
      if (state) q = q.ilike("state", state);
      if (stages?.length) q = q.in("pipeline_stage", stages);
      if (tiers?.length) q = q.in("tier", tiers);
      if (rooms_min !== undefined) q = q.gte("room_count", rooms_min);
      if (rooms_max !== undefined) q = q.lte("room_count", rooms_max);
      // overlaps, not contains: someone asking for two tags wants either.
      if (tags?.length) q = q.overlaps("tags", tags);
      if (outcomes?.length) q = q.in("outcome", outcomes);
      if (never_called) q = q.is("last_called_at", null);

      const { data, error } = await q
        .order("last_called_at", { ascending: false, nullsFirst: false })
        .limit(limit ?? 50);
      if (error) return jsonResult({ error: error.message });
      return jsonResult({ leads: data ?? [] });
    });

  server.registerTool("get_lead",
    {
      title: "Get lead",
      description: "One lead with its full call history, newest first.",
      inputSchema: { lead_id: z.string().uuid() },
    },
    async ({ lead_id }) => {
      const { data: lead, error } = await db
        .from("leads").select("*").eq("id", lead_id).maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!lead) return jsonResult({ error: "not_found" });
      const { data: calls } = await db
        .from("dial_call_logs")
        .select(CALL_FIELDS)
        .eq("lead_id", lead_id)
        .order("called_at", { ascending: false })
        .limit(50);
      // Reading a lead should show what you already wrote about it, rather than
      // needing a second call to find out.
      const [{ data: brief }, { data: tasks }] = await Promise.all([
        db.from("documents")
          .select("id, title, body_md, summary_json, updated_at, model, author")
          .eq("lead_id", lead_id).eq("kind", "lead_brief").maybeSingle(),
        db.from("tasks")
          .select("id, title, kind, due_at, status")
          .eq("lead_id", lead_id).eq("status", "open")
          .order("due_at", { ascending: true }),
      ]);
      return jsonResult({
        lead, brief: brief ?? null, open_tasks: tasks ?? [], calls: calls ?? [],
      });
    });

  // ── Writes ───────────────────────────────────────────────────────────────
  server.registerTool("set_call_outcome",
    {
      title: "Set call outcome",
      description: "Change a call's disposition — for example after reading its transcript. Also updates the lead's current outcome. Logging do_not_call raises the lead's standing do-not-call flag, which blocks future dialling at the database.",
      inputSchema: {
        call_id: z.string().uuid(),
        outcome: z.enum(ALL_OUTCOMES),
      },
    },
    async ({ call_id, outcome }) => {
      const { data, error } = await db
        .from("dial_call_logs")
        .update({ outcome })
        .eq("id", call_id)
        .select("id, lead_id, business_name")
        .maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found", hint: "No call with that id is writable by this account." });

      if (data.lead_id) {
        await db.from("leads").update({ outcome }).eq("id", data.lead_id);
      }
      return jsonResult({
        ok: true, call_id, outcome, outcome_label: OUTCOME_LABELS[outcome],
        business_name: data.business_name,
      });
    });

  server.registerTool("create_call",
    {
      title: "Log a call that happened elsewhere",
      description:
        "Record a call placed outside the dialer — a mobile call, an old " +
        "spreadsheet, anything already in a lead's notes as prose. This is how " +
        "call_count, last_called_at, connection rate and every rolling stat " +
        "stop understating reality. Idempotent it is NOT: calling this twice " +
        "logs two calls, so check get_lead's history before backfilling.",
      inputSchema: {
        ...wsArg,
        lead_id: z.string().uuid()
          .describe("The lead this call was to. Required — a backfilled call with no lead updates no counters, which is the entire point."),
        called_at: z.string()
          .describe("When it actually happened, ISO 8601. Backdating is the normal case and does not move the lead's last_called_at backwards."),
        outcome: z.enum(ALL_OUTCOMES).optional()
          .describe("Leave unset only if genuinely unknown; an outcome is what makes the call count toward connection rate."),
        duration_seconds: z.number().int().min(0).max(86400).optional(),
        notes: z.string().max(4000).optional(),
        direction: z.enum(["outbound", "inbound"]).optional(),
      },
    },
    async ({ workspace_id, lead_id, called_at, outcome, duration_seconds, notes, direction }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const when = new Date(called_at);
      if (Number.isNaN(when.getTime())) {
        return jsonResult({ error: "bad_called_at", hint: "Use an ISO 8601 timestamp, e.g. 2026-08-14T15:30:00Z." });
      }
      if (when.getTime() > Date.now() + 60_000) {
        return jsonResult({
          error: "called_at_in_future",
          hint: "This logs calls that already happened. To schedule one, create_task instead.",
        });
      }

      // The phone is copied off the lead rather than taken as input: a call log
      // row whose number disagrees with the lead it points at is worse than no
      // row, and it is what inbound matching and call search read.
      const { data: lead, error: leadErr } = await db
        .from("leads")
        .select("id, business_name, phone, phone_normalized, workspace_id")
        .eq("id", lead_id)
        .eq("workspace_id", ws.id)
        .maybeSingle();
      if (leadErr) return jsonResult({ error: leadErr.message });
      if (!lead) return jsonResult({ error: "not_found", hint: "No lead with that id in this workspace." });

      const { data, error } = await db
        .from("dial_call_logs")
        .insert({
          workspace_id: ws.id,
          lead_id,
          business_name: lead.business_name,
          phone: lead.phone,
          phone_normalized: lead.phone_normalized,
          direction: direction ?? "outbound",
          // Distinguishable from a dialer call for ever after, so nobody later
          // mistakes reconstructed history for something Twilio measured.
          mode: "manual",
          call_status: "completed",
          outcome: outcome ?? null,
          duration_seconds: duration_seconds ?? 0,
          notes: notes ?? null,
          called_at: when.toISOString(),
          ended_at: when.toISOString(),
          recorded: false,
        })
        .select("id, called_at, outcome, duration_seconds")
        .single();
      if (error) return jsonResult({ error: error.message });

      const { data: after } = await db
        .from("leads")
        .select("call_count, last_called_at, pipeline_stage, do_not_call")
        .eq("id", lead_id)
        .maybeSingle();

      return jsonResult({
        ok: true,
        call: data,
        business_name: lead.business_name,
        lead_now: after ?? null,
        note: "No recording or transcript exists for a backfilled call.",
      });
    });

  server.registerTool("create_session",
    {
      title: "Build a calling session",
      description:
        "Freeze a filtered slice of the list into an ordered queue the rep " +
        "works through in the dialer. Same filters as list_leads, including " +
        "room bounds. lead_ids builds a curated batch: it is intersected with any " +
        "other filter and queued in the order given. Do-not-call leads are " +
        "excluded at the database and one number can appear once. The response " +
        "carries applied_filters, read back from the session — compare it with " +
        "what you asked for before telling the rep the list is right. Returns " +
        "the queue size and which script the session serves; this does not " +
        "start dialling anything.",
      inputSchema: {
        ...wsArg,
        name: z.string().min(1).max(120)
          .describe("What this block of calls is, e.g. 'Vermont inns — never called'."),
        search: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        stages: z.array(z.enum(ALL_STAGES)).optional(),
        tiers: z.array(z.enum(ALL_TIERS)).optional(),
        tags: z.array(z.string()).optional(),
        outcomes: z.array(z.enum(ALL_OUTCOMES)).optional(),
        never_called: z.boolean().optional(),
        not_called_since: z.string().optional()
          .describe("ISO timestamp. Queues leads not called since then, plus those never called."),
        rooms_min: z.number().int().min(1).optional(),
        rooms_max: z.number().int().min(1).optional()
          .describe("Room-count bounds. A lead with no count is excluded by either — unknown is not zero."),
        has_next_step: z.boolean().optional()
          .describe("true: only leads with an open task. false: only leads with nothing queued."),
        lead_ids: z.array(z.string().uuid()).min(1).max(500).optional()
          .describe("A curated batch. Intersected with any other filter, queued in the order given."),
        max_leads: z.number().int().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(500).optional()
          .describe("Alias of max_leads."),
        script_id: z.string().uuid().optional()
          .describe("Pin a script. Omit to follow the workspace default, so a later default reaches this session."),
      },
    },
    async ({ workspace_id, name, max_leads, limit, script_id, ...filters }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const clean = Object.fromEntries(
        Object.entries(filters).filter(([, v]) =>
          v !== undefined && !(Array.isArray(v) && v.length === 0)),
      );

      const { data: sessionId, error } = await db.rpc("build_session", {
        ws: ws.id,
        session_name: name,
        filters: clean,
        // `limit` is accepted because it is the word everyone reaches for.
        // Undeclared, the schema stripped it and 20 asked-for leads built 100.
        max_leads: max_leads ?? limit ?? 100,
      });
      if (error) return jsonResult({ error: error.message, hint: error.hint ?? undefined });

      if (script_id) {
        const { error: scriptError } = await db.from("calling_sessions")
          .update({ script_id }).eq("id", sessionId as string);
        if (scriptError) return jsonResult({ error: scriptError.message });
      }

      const { data: row } = await db
        .from("calling_sessions")
        .select("id, name, status, total_leads, created_at, filters_json, script_id")
        .eq("id", sessionId as string)
        .maybeSingle();

      const session = { ...((row ?? {}) as Record<string, unknown>) };
      // Read back from the session rather than echoed from the request: this is
      // what build_session actually used, so a filter it did not apply cannot
      // come back looking applied — which is precisely what used to happen.
      const applied_filters = session.filters_json ?? {};
      delete session.filters_json;
      const script = sessionScript(await loadScripts(ws.id), (session.script_id as string | null) ?? null);
      delete session.script_id;

      // An empty queue is a filter that matched nothing, not a session worth
      // opening. Say so rather than handing back a session with zero leads.
      if (session.total_leads === 0) {
        return jsonResult({
          ok: true, session, applied_filters, script,
          warning: "Nothing matched those filters, so the queue is empty. Widen them and build another, or remove this one with delete_session.",
        });
      }

      return jsonResult({ ok: true, session, applied_filters, script });
    });

  server.registerTool("append_call_note",
    {
      title: "Append call note",
      description: "Add a line to a call's notes without overwriting what the rep already typed.",
      inputSchema: { call_id: z.string().uuid(), note: z.string().min(1).max(2000) },
    },
    async ({ call_id, note }) => {
      const { data: existing, error: readErr } = await db
        .from("dial_call_logs").select("notes").eq("id", call_id).maybeSingle();
      if (readErr) return jsonResult({ error: readErr.message });
      if (!existing) return jsonResult({ error: "not_found" });

      const merged = existing.notes?.trim() ? `${existing.notes.trim()}\n${note.trim()}` : note.trim();
      const { error } = await db.from("dial_call_logs").update({ notes: merged }).eq("id", call_id);
      if (error) return jsonResult({ error: error.message });
      return jsonResult({ ok: true, call_id, notes: merged });
    });

  server.registerTool("set_lead_do_not_call",
    {
      title: "Flag lead do-not-call",
      description: "Mark a lead do-not-call — use when a transcript shows they asked to be removed. This is enforced at the database: a flagged lead cannot be dialled and is excluded when new sessions are built.",
      inputSchema: {
        lead_id: z.string().uuid(),
        do_not_call: z.boolean().optional().describe("Defaults to true. Pass false only to undo a mistake."),
      },
    },
    async ({ lead_id, do_not_call }) => {
      const flag = do_not_call ?? true;
      const { data, error } = await db
        .from("leads")
        .update(flag
          ? { do_not_call: true, outcome: "do_not_call" }
          : { do_not_call: false })
        .eq("id", lead_id)
        .select("id, business_name, phone, do_not_call")
        .maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found" });
      return jsonResult({ ok: true, lead: data });
    });

  // ── Scripts ──────────────────────────────────────────────────────────────
  server.registerTool("list_scripts",
    {
      title: "List call scripts",
      description: "The workspace's call scripts with block counts and which one is the default.",
      inputSchema: { ...wsArg },
    },
    async ({ workspace_id }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;
      const { data, error } = await db
        .from("call_scripts")
        .select("id, name, description, entry_block_id, is_default, blocks, updated_at")
        .eq("workspace_id", ws.id)
        .order("is_default", { ascending: false })
        .order("updated_at", { ascending: false });
      if (error) return jsonResult({ error: error.message });
      return jsonResult({
        scripts: (data ?? []).map((s: Record<string, unknown>) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          is_default: s.is_default,
          block_count: Array.isArray(s.blocks) ? s.blocks.length : 0,
          updated_at: s.updated_at,
        })),
      });
    });

  server.registerTool("get_script",
    {
      title: "Get call script",
      description: "One script's full block graph — edit it and hand the whole thing back to put_script.",
      inputSchema: { script_id: z.string().uuid() },
    },
    async ({ script_id }) => {
      const { data, error } = await db
        .from("call_scripts").select("*").eq("id", script_id).maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found" });
      return jsonResult({ script: data });
    });

  server.registerTool("put_script",
    {
      title: "Create or replace a call script",
      description:
        "Write a whole call script in one shot. Pass script_id to replace an existing one, " +
        "or omit it to create; creating with a name that already exists replaces that script " +
        "rather than making a duplicate. Blocks run in the order given and the first is where " +
        "every call starts. The database validates the graph: block ids must be unique and " +
        "every `next` and branch `goto` must point at a block that exists, so a script can " +
        "never dead-end mid-call.",
      inputSchema: {
        ...wsArg,
        script_id: z.string().uuid().optional(),
        name: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        blocks: z.array(scriptBlock).min(1).max(100),
        entry_block_id: z.string().optional()
          .describe("Where the call starts. Defaults to the first block."),
        set_default: z.boolean().optional()
          .describe("Make this the script sessions use when none is pinned."),
      },
    },
    async ({ workspace_id, script_id, name, description, blocks, entry_block_id, set_default }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const entry = entry_block_id ?? blocks[0].id;
      const row = {
        workspace_id: ws.id,
        name: name.trim(),
        description: description?.trim() ?? null,
        blocks,
        entry_block_id: entry,
      };

      // Without an id, treat a matching name as the same script. "Update the
      // discovery script" should not silently create a second one.
      let targetId = script_id ?? null;
      if (!targetId) {
        const { data: existing } = await db
          .from("call_scripts").select("id")
          .eq("workspace_id", ws.id).ilike("name", name.trim()).maybeSingle();
        targetId = existing?.id ?? null;
      }

      const { data, error } = targetId
        ? await db.from("call_scripts").update(row).eq("id", targetId).select().single()
        : await db.from("call_scripts").insert(row).select().single();

      if (error) {
        // The CHECK constraint carries the specific reason; pass it through so
        // Claude can fix the script rather than guess.
        return jsonResult({
          error: "invalid_script",
          detail: error.message,
          hint: "Every block needs a unique id and non-empty text, and every `next`/`goto` must name a block in this script.",
        });
      }

      if (set_default) {
        await db.rpc("set_default_script", { ws: ws.id, script: data.id });
      }

      return jsonResult({
        ok: true,
        script_id: data.id,
        name: data.name,
        blocks: blocks.length,
        replaced: Boolean(targetId),
        is_default: set_default ?? data.is_default,
        note: "Live in the dialer immediately — sessions read the script when they load.",
      });
    });

  server.registerTool("set_default_script",
    {
      title: "Set the default script",
      description: "Make one script the workspace default, used by any session that has not pinned its own.",
      inputSchema: { ...wsArg, script_id: z.string().uuid() },
    },
    async ({ workspace_id, script_id }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;
      const { error } = await db.rpc("set_default_script", { ws: ws.id, script: script_id });
      if (error) return jsonResult({ error: error.message });
      return jsonResult({ ok: true, script_id });
    });

  server.registerTool("delete_script",
    {
      title: "Delete a call script",
      description: "Remove a script. Sessions that pinned it fall back to the workspace default.",
      inputSchema: { script_id: z.string().uuid() },
    },
    async ({ script_id }) => {
      const { data, error } = await db
        .from("call_scripts").delete().eq("id", script_id).select("id, name").maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found" });
      return jsonResult({ ok: true, deleted: data.name });
    });

  // ── Transcripts ──────────────────────────────────────────────────────────
  server.registerTool("search_transcripts",
    {
      title: "Search call transcripts",
      description:
        "Full-text search across every transcript in the workspace. Returns the matching calls " +
        "with a highlighted snippet, ranked by relevance. Use this to answer questions about what " +
        "was actually said - objections raised, competitors named, pricing discussed - instead of " +
        "reading every call. Supports quoted phrases and OR, e.g. 'pricing OR \"too expensive\"'.",
      inputSchema: {
        ...wsArg,
        query: z.string().min(2).describe('Words or a quoted phrase to look for.'),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ workspace_id, query, limit }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;
      const { data, error } = await db.rpc("search_transcripts", {
        ws: ws.id, q: query, max_results: limit ?? 20,
      });
      if (error) return jsonResult({ error: error.message });
      const hits = (data ?? []) as Record<string, unknown>[];
      return jsonResult({
        query,
        matches: hits.length,
        results: hits.map((r) => ({
          call_id: r.call_id,
          business_name: r.business_name,
          phone: r.phone,
          outcome: r.outcome,
          outcome_label: r.outcome ? OUTCOME_LABELS[String(r.outcome)] : null,
          called_at: r.called_at,
          duration: fmtDuration(Number(r.duration_seconds ?? 0)),
          snippet: r.snippet,
        })),
        note: hits.length === 0
          ? "Nothing matched. Only connected calls are transcribed, so voicemails and no-answers have no transcript."
          : "Snippets are excerpts; call get_call_transcript for the full text before quoting.",
      });
    });

  server.registerTool("list_transcripts",
    {
      title: "List transcripts",
      description:
        "Recent calls that have a transcript, newest first, with word counts. Use it to see what " +
        "is available to read before pulling full text.",
      inputSchema: {
        ...wsArg,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ workspace_id, date, timezone, limit }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      let q = db
        .from("call_transcripts")
        .select("call_id, word_count, engine, speaker_confidence, created_at, " +
                "dial_call_logs!inner(business_name, phone, outcome, duration_seconds, called_at)")
        .eq("workspace_id", ws.id);

      if (date) {
        const { startUtc, endUtc } = dayBounds(date, timezone ?? ws.timezone);
        q = q.gte("dial_call_logs.called_at", startUtc).lt("dial_call_logs.called_at", endUtc);
      }

      const { data, error } = await q
        .order("created_at", { ascending: false })
        .limit(limit ?? 25);
      if (error) return jsonResult({ error: error.message });

      return jsonResult({
        transcripts: (data ?? []).map((t: Record<string, unknown>) => {
          const call = t.dial_call_logs as Record<string, unknown> | null;
          return {
            call_id: t.call_id,
            business_name: call?.business_name,
            phone: call?.phone,
            outcome: call?.outcome,
            outcome_label: call?.outcome ? OUTCOME_LABELS[String(call.outcome)] : null,
            called_at: call?.called_at,
            duration: fmtDuration(Number(call?.duration_seconds ?? 0)),
            words: t.word_count,
            engine: t.engine,
            speaker_confidence: t.speaker_confidence,
          };
        }),
        note: "speaker_confidence 'low' means agent/lead labels were inferred and may be swapped.",
      });
    });


  // ── Leads: Claude builds the list ────────────────────────────────────────

  server.registerTool("describe_lead_fields",
    {
      title: "Describe the lead fields",
      description:
        "The exact shape create_leads accepts. Call this before building leads " +
        "so every field lands in a real column instead of the metadata bag.",
      inputSchema: {},
    },
    async () => jsonResult({
      required: {
        phone: "Any format. Normalized server-side; anything under 10 digits is skipped.",
      },
      optional: {
        business_name: "Defaults to 'Unknown business' if omitted.",
        contact_name:
          "The person to ask for — usually a first name. Searchable, shown " +
          "under the business in the list, and available to scripts as " +
          "{{contact_name}}. This is a real column: do NOT also write owner " +
          "or ask_for into metadata_json.",
        room_count:
          "A plain integer. The single most useful qualifier for a property, " +
          "and a real column now — filterable and sortable. Leave it unset " +
          "rather than guessing; if the true answer is not one number " +
          "(\"13 main plus 21 in the lodge\"), put that in metadata_json " +
          "under rooms_note and leave room_count null.",
        address: "Street line only.",
        city: "", state: "Two-letter code is conventional but not enforced.",
        zip: "", website: "", email: "",
        notes: "Free text. Set on insert only — see the note about updates below.",
        metadata_json:
          "An object for anything without a column. The lead panel now RENDERS " +
          "this, so what you put here is read by a human mid-call — write it " +
          "to be read, not parsed. Reuse the canonical keys below rather than " +
          "minting a synonym: booking_engine and engine were both in use on " +
          "disjoint halves of one list, so neither could be filtered on.",
        metadata_canonical_keys: {
          booking_engine: "The PMS or booking engine they run. NOT `engine`.",
          property_type: "inn | b_and_b | hotel | motel | resort | lodge.",
          rooms_note: "Room counts that are not one number. See room_count.",
          alt_phone: "A second number. Digits only.",
          desk_hours: "When a human answers, e.g. \"8am-9pm daily\".",
          owner_on_site: "yes | likely | no.",
          region: "A lowercase slug, e.g. southern-vt.",
          source: "Where the lead came from.",
          price_band_usd: "Typical nightly rate, digits only. NOT `band`.",
          network: "Associations they belong to.",
          other_properties: "Anything else the same owner runs.",
        },
      },
      behaviour: {
        dedupe: "Keyed on the normalized phone within the workspace.",
        on_duplicate:
          "Existing leads are updated, but only where the incoming value is " +
          "non-null; metadata_json is merged. notes is NOT " +
          "overwritten, so a rep's own words survive a re-import.",
        do_not_call: "Never set by this tool. Flag it with set_lead_do_not_call.",
        editing:
          "To fix one existing lead rather than import a batch, use update_lead. " +
          "It can change the phone number too — the database re-derives the " +
          "normalized form, so a corrected number stays dedupable and still " +
          "matches on an inbound call.",
      },
      pipeline: {
        pipeline_stage:
          "new | called | demo_booked | demo_no_show | demo_completed | pilot | " +
          "paying | lost | not_a_fit. demo_booked is a demo agreed to, " +
          "demo_completed is one that actually happened, demo_no_show is one they " +
          "did not turn up to — which is not lost, it is the most rebookable " +
          "state there is. " +
          "Set it with set_lead_stage, never update_lead: moving a stage fires its " +
          "playbook.",
        tier:
          "READ ONLY. Generated by the database as the human's override, or your " +
          "suggestion when there is none. Propose one with suggest_lead_tier; if " +
          "a human has decided, theirs stands and that is not a failure.",
        tags: "Set with set_lead_tags. Lowercase, max 12, reuse before inventing.",
      },
    }));

  server.registerTool("create_leads",
    {
      title: "Create or update leads",
      description:
        "Add leads in bulk. Idempotent on the normalized phone, so re-running " +
        "with the same numbers updates rather than duplicating. Call " +
        "describe_lead_fields first if unsure of the shape.",
      inputSchema: {
        workspace_id: z.string().uuid().optional(),
        leads: z.array(z.object({
          phone: z.string().min(7),
          business_name: z.string().optional(),
          contact_name: z.string().optional(),
          room_count: z.number().int().min(1).max(2000).optional(),
          address: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          zip: z.string().optional(),
          website: z.string().optional(),
          email: z.string().optional(),
          notes: z.string().optional(),
          metadata_json: z.record(z.unknown()).optional(),
        })).min(1).max(200),
      },
    },
    async ({ workspace_id, leads }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const { data, error } = await db.rpc("import_leads", { ws: ws.id, payload: leads });
      if (error) return jsonResult({ error: error.message });

      const r = data as { received: number; inserted: number; updated: number; skipped: number };
      return jsonResult({
        ...r,
        note: r.skipped > 0
          ? `${r.skipped} row(s) skipped — a phone number was missing or had fewer than 10 digits.`
          : undefined,
      });
    });

  server.registerTool("update_lead",
    {
      title: "Update one lead",
      description:
        "Patch a single lead's fields. Only the keys you pass are changed. " +
        "Use this to fix what an import got wrong — a misspelt name, a missing " +
        "email, a wrong number.",
      inputSchema: {
        lead_id: z.string().uuid(),
        business_name: z.string().optional(),
        contact_name: z.string().optional()
          .describe("The human to ask for. Worth setting the moment a call turns up a name."),
        room_count: z.number().int().min(1).max(2000).nullable().optional()
          .describe(
            "How many rooms. Leave unset rather than guessing — null means " +
            "unknown, which the app shows differently from small."
          ),
        scheduled_at: z.string().nullable().optional()
          .describe(
            "The next appointment, ISO 8601 — the demo date. Playbook steps " +
            "anchored to \"scheduled\" count from this, so setting it creates " +
            "any T-1 reminder and changing it moves them. null clears it and " +
            "cancels those reminders."
          ),
        phone: z.string().min(10).optional()
          .describe(
            "Correct a wrong number. The database re-derives the normalized " +
            "form, so dedupe and inbound caller matching stay right — and " +
            "rejects a number another lead in the workspace already holds."
          ),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        website: z.string().optional(),
        email: z.string().optional(),
        notes: z.string().optional(),
        metadata_json: z.record(z.unknown()).optional(),
      },
    },
    async ({ lead_id, ...patch }) => {
      const fields = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(fields).length === 0) return jsonResult({ error: "nothing_to_update" });

      const { data, error } = await db
        .from("leads").update(fields).eq("id", lead_id)
        .select("id, business_name, contact_name, room_count, phone, city, state").maybeSingle();
      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found" });
      return jsonResult({ ok: true, lead: data });
    });

  // ── Documents: where Claude's own writing lives ──────────────────────────

  server.registerTool("get_period_summary",
    {
      title: "Summarise a date range",
      description:
        "Every number needed to write a report for a range: totals, outcome " +
        "mix, per-day and per-hour breakdowns, and the calls worth naming. " +
        "Read this before put_report — assembling a week from daily summaries " +
        "produces a different shape every time. The end date is EXCLUSIVE, and " +
        "the response echoes period.last_day_included: check it before reporting " +
        "a day as missing.",
      inputSchema: {
        workspace_id: z.string().uuid().optional(),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First day, inclusive."),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("EXCLUSIVE — the day after the last day you want counted."),
        timezone: z.string().optional(),
      },
    },
    async ({ workspace_id, start, end, timezone }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const { data, error } = await db.rpc("workspace_period_summary", {
        ws: ws.id, start_date: start, end_date: end, tz: timezone ?? ws.timezone,
      });
      if (error) return jsonResult({ error: error.message });
      return jsonResult(data);
    });

  server.registerTool("put_report",
    {
      title: "Save a report",
      description:
        "Store a written report in Callsheet, where it stays browsable. " +
        "Idempotent per period, so regenerating last week's report rewrites it " +
        "rather than adding a second. The stored body is returned verbatim — " +
        "post that to Slack rather than rewriting it, so the two never diverge.",
      inputSchema: {
        workspace_id: z.string().uuid().optional(),
        kind: z.enum(["weekly_report", "daily_report"]).default("weekly_report"),
        period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First day, inclusive."),
        period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("EXCLUSIVE — the day after the last day covered."),
        title: z.string().min(1).max(200),
        body_md: z.string().min(1).max(100000).describe("Markdown. Written to be read as a document, not a chat message."),
        summary_json: z.record(z.unknown()).optional()
          .describe("The figures behind the prose, so the numbers can be checked without parsing English."),
        model: z.string().optional(),
      },
    },
    async ({ workspace_id, kind, period_start, period_end, title, body_md, summary_json, model }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const { data, error } = await db.from("documents").upsert({
        workspace_id: ws.id, kind, period_start, period_end,
        title, body_md, summary_json: summary_json ?? {},
        author: "claude", model: model ?? null, updated_at: new Date().toISOString(),
      }, { onConflict: "workspace_id,kind,period_start,period_end" })
        .select("id, created_at, updated_at").single();

      if (error) return jsonResult({ error: error.message });
      return jsonResult({
        ok: true, document_id: data.id, kind, title, period_start, period_end,
        replaced: data.created_at !== data.updated_at,
        body_md,
      });
    });

  server.registerTool("put_lead_brief",
    {
      title: "Save a lead brief",
      description:
        "Store what you know about one lead — the angle, the likely pain, who " +
        "to ask for. Shown in the app when that lead is opened. One brief per " +
        "lead; writing again replaces it.",
      inputSchema: {
        lead_id: z.string().uuid(),
        title: z.string().min(1).max(200),
        body_md: z.string().min(1).max(20000),
        summary_json: z.record(z.unknown()).optional()
          .describe("Structured attributes — property_type, approx_rooms, segment. Analytics groups by these keys."),
        model: z.string().optional(),
      },
    },
    async ({ lead_id, title, body_md, summary_json, model }) => {
      // Derive the workspace from the lead rather than taking it as an
      // argument: RLS decides whether this lead is reachable at all, and there
      // is then no way to write a brief into the wrong workspace.
      const { data: lead, error: leadErr } = await db
        .from("leads").select("id, workspace_id, business_name").eq("id", lead_id).maybeSingle();
      if (leadErr) return jsonResult({ error: leadErr.message });
      if (!lead) return jsonResult({ error: "not_found" });

      const { data, error } = await db.from("documents").upsert({
        workspace_id: lead.workspace_id, kind: "lead_brief", lead_id,
        title, body_md, summary_json: summary_json ?? {},
        author: "claude", model: model ?? null, updated_at: new Date().toISOString(),
      }, { onConflict: "lead_id,kind" }).select("id, created_at, updated_at").single();

      if (error) return jsonResult({ error: error.message });
      return jsonResult({
        ok: true, document_id: data.id, lead_id,
        business_name: lead.business_name,
        replaced: data.created_at !== data.updated_at,
      });
    });

  server.registerTool("list_reports",
    {
      title: "List saved reports",
      description: "Reports newest first. Bodies omitted — use get_report for one.",
      inputSchema: {
        workspace_id: z.string().uuid().optional(),
        kind: z.enum(["weekly_report", "daily_report"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ workspace_id, kind, limit }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      let q = db.from("documents")
        .select("id, kind, title, period_start, period_end, created_at, updated_at, model, body_md")
        .eq("workspace_id", ws.id)
        .in("kind", kind ? [kind] : ["weekly_report", "daily_report"])
        .order("period_start", { ascending: false })
        .limit(limit ?? 25);

      const { data, error } = await q;
      if (error) return jsonResult({ error: error.message });
      return jsonResult({
        reports: (data ?? []).map((d) => ({
          id: d.id, kind: d.kind, title: d.title,
          period_start: d.period_start, period_end: d.period_end,
          created_at: d.created_at, updated_at: d.updated_at, model: d.model,
          words: String(d.body_md ?? "").split(/\s+/).filter(Boolean).length,
        })),
      });
    });

  server.registerTool("get_report",
    {
      title: "Read one report",
      description: "By id, or by period so last week's report is one call away.",
      inputSchema: {
        workspace_id: z.string().uuid().optional(),
        document_id: z.string().uuid().optional(),
        kind: z.enum(["weekly_report", "daily_report"]).optional(),
        period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      },
    },
    async ({ workspace_id, document_id, kind, period_start }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      let q = db.from("documents").select("*").eq("workspace_id", ws.id);
      if (document_id) q = q.eq("id", document_id);
      else if (period_start) q = q.eq("kind", kind ?? "weekly_report").eq("period_start", period_start);
      else return jsonResult({ error: "need_document_id_or_period_start" });

      const { data, error } = await q.maybeSingle();
      if (error) return jsonResult({ error: error.message });
      return jsonResult({ report: data ?? null });
    });

  server.registerTool("delete_document",
    {
      title: "Delete a report or brief",
      description: "Removes one document Claude wrote. Does not touch calls or leads.",
      inputSchema: { document_id: z.string().uuid() },
    },
    async ({ document_id }) => {
      const { error } = await db.from("documents").delete().eq("id", document_id);
      if (error) return jsonResult({ error: error.message });
      return jsonResult({ ok: true, document_id });
    });


  // ── Pipeline ─────────────────────────────────────────────────────────────

  server.registerTool("set_lead_stage",
    {
      title: "Move a lead's stage",
      description:
        "Move a lead through the pipeline. Moving into a stage fires that " +
        "stage's playbook, so this is what creates follow-up work — the response " +
        "lists what it created. Moving to lost or not_a_fit cancels open tasks.",
      inputSchema: {
        lead_id: z.string().uuid(),
        stage: z.enum(ALL_STAGES),
        scheduled_at: z.string().optional()
          .describe(
            "Set the appointment in the same call as the stage, ISO 8601. Doing " +
            "it here rather than afterwards is what lets a demo_booked playbook " +
            "create its day-before reminder immediately."
          ),
      },
    },
    async ({ lead_id, stage, scheduled_at }) => {
      const { data: before, error: readErr } = await db
        .from("leads").select("id, business_name, pipeline_stage").eq("id", lead_id).maybeSingle();
      if (readErr) return jsonResult({ error: readErr.message });
      if (!before) return jsonResult({ error: "not_found" });

      /*
       * One statement, so the stage trigger sees the appointment on NEW and a
       * demo_booked playbook can date its day-before reminder immediately.
       * Two writes would fire the playbook first, with no date to count from,
       * and leave the reminder to be created by the re-anchor trigger a
       * moment later — the same end state by a longer route, but only if the
       * second write actually happens.
       */
      const patch: Record<string, unknown> = { pipeline_stage: stage };
      if (scheduled_at !== undefined) {
        const when = new Date(scheduled_at);
        if (Number.isNaN(when.getTime())) {
          return jsonResult({ error: "bad_scheduled_at", hint: "Use an ISO 8601 timestamp." });
        }
        patch.scheduled_at = when.toISOString();
      }

      const { error } = await db.from("leads").update(patch).eq("id", lead_id);
      if (error) return jsonResult({ error: error.message });

      // Show the consequence rather than making Claude guess at it — and so it
      // can say "that created three follow-ups" out loud.
      const { data: tasks } = await db
        .from("tasks")
        .select("id, title, kind, due_at")
        .eq("lead_id", lead_id).eq("status", "open")
        .order("due_at", { ascending: true });

      return jsonResult({
        ok: true,
        lead_id,
        business_name: before.business_name,
        from_stage: before.pipeline_stage,
        to_stage: stage,
        open_tasks: tasks ?? [],
        note: ["lost", "not_a_fit"].includes(stage)
          ? "Open tasks for this lead were cancelled."
          : undefined,
      });
    });

  server.registerTool("suggest_lead_tier",
    {
      title: "Suggest a tier for a lead",
      description:
        "Record how worth calling a lead looks: a = call today, b = worth a " +
        "call, c = only if the list runs dry. This writes a SUGGESTION. If the " +
        "rep has set a tier by hand theirs stands and yours is recorded but not " +
        "used — that is not a failure, and the response says when it happened." +
        " The stored tier is capped at c for a property below the workspace size " +
        "floor; your suggestion is kept, and returns if the floor is lowered.",
      inputSchema: {
        lead_id: z.string().uuid(),
        tier: z.enum(ALL_TIERS),
        reason: z.string().min(1).max(280)
          .describe("Why, in one line. Shown to the rep when they decide whether to override."),
      },
    },
    async ({ lead_id, tier, reason }) => {
      const { data, error } = await db
        .from("leads")
        .update({ tier_suggested: tier, tier_suggested_reason: reason })
        .eq("id", lead_id)
        .select("id, business_name, tier, tier_override")
        .maybeSingle();

      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found" });

      const overridden = Boolean(data.tier_override);
      return jsonResult({
        ok: true,
        lead_id,
        business_name: data.business_name,
        suggested: tier,
        effective_tier: data.tier,
        overridden_by_human: overridden,
        note: overridden
          ? `A human set tier ${String(data.tier_override).toUpperCase()}. Your suggestion is ` +
            `recorded and visible in the app, but it is not the tier this lead is worked at.`
          : undefined,
      });
    });

  server.registerTool("set_lead_tags",
    {
      title: "Tag a lead",
      description:
        "Short lowercase labels for how a lead is grouped — property type, a " +
        "hook, a blocker. Reuse tags that already exist on other leads rather " +
        "than inventing a synonym: 'small rooms' and 'small-rooms' become two " +
        "things nobody can filter by. Max 12 per lead.",
      inputSchema: {
        lead_id: z.string().uuid(),
        tags: z.array(z.string().min(1).max(32)).max(12),
        mode: z.enum(["replace", "add", "remove"]).default("add"),
      },
    },
    async ({ lead_id, tags, mode }) => {
      // One atomic statement, shared with the app, rather than a
      // read-modify-write that two callers can interleave.
      const { data, error } = await db.rpc("set_lead_tags", {
        lead: lead_id, new_tags: tags, mode,
      });
      if (error) return jsonResult({ error: error.message });
      return jsonResult({ ok: true, lead_id, tags: data });
    });

  // ── Tasks: the loop a scheduled session works ────────────────────────────

  server.registerTool("list_tasks",
    {
      title: "List follow-up tasks",
      description:
        "What is due, with the lead, its brief and its last call already " +
        "attached — one call, then act. Each task carries `actionable` and " +
        "`blocked_reason`; trust them rather than re-deriving the rules.",
      inputSchema: {
        workspace_id: z.string().uuid().optional(),
        status: z.enum(["open", "done", "cancelled"]).default("open"),
        due_before: z.string().optional().describe("ISO timestamp. Omit for everything open."),
        lead_id: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ workspace_id, status, due_before, lead_id, limit }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      let q = db.from("tasks")
        .select("id, title, body_md, kind, status, due_at, snooze_count, source, lead_id, " +
                "leads(id, business_name, phone, email, pipeline_stage, tier, tags, do_not_call, notes)")
        .eq("workspace_id", ws.id)
        .eq("status", status)
        .order("due_at", { ascending: true })
        .limit(limit ?? 40);

      if (due_before) q = q.lte("due_at", due_before);
      if (lead_id) q = q.eq("lead_id", lead_id);

      const { data, error } = await q;
      if (error) return jsonResult({ error: error.message });

      const rows = (data ?? []) as unknown as {
        id: string; title: string; body_md: string | null; kind: string;
        due_at: string; snooze_count: number; source: string; lead_id: string | null;
        leads: {
          id: string; business_name: string; phone: string; email: string | null;
          pipeline_stage: string; tier: string | null; tags: string[];
          do_not_call: boolean; notes: string | null;
        } | null;
      }[];

      const leadIds = rows.map((r) => r.lead_id).filter((v): v is string => Boolean(v));
      const [{ data: briefs }, { data: calls }] = await Promise.all([
        leadIds.length
          ? db.from("documents").select("lead_id, body_md")
              .in("lead_id", leadIds).eq("kind", "lead_brief")
          : Promise.resolve({ data: [] as { lead_id: string; body_md: string }[] }),
        leadIds.length
          ? db.from("dial_call_logs")
              .select("lead_id, called_at, outcome, notes")
              .in("lead_id", leadIds).order("called_at", { ascending: false })
          : Promise.resolve({ data: [] as { lead_id: string; called_at: string; outcome: string | null; notes: string | null }[] }),
      ]);

      const briefBy = new Map((briefs ?? []).map((b) => [b.lead_id, b.body_md]));
      const lastCallBy = new Map<string, { called_at: string; outcome: string | null; notes: string | null }>();
      for (const c of calls ?? []) if (!lastCallBy.has(c.lead_id)) lastCallBy.set(c.lead_id, c);

      const now = Date.now();
      return jsonResult({
        tasks: rows.map((t) => {
          // Computed here so Claude does not have to infer policy, and so the
          // rules live in one place rather than in the model's judgement.
          let blocked: string | null = null;
          if (t.kind === "call") blocked = "needs_a_human";
          else if (t.leads?.do_not_call) blocked = "lead_is_dnc";
          else if (t.kind === "email" && !t.leads?.email) blocked = "no_email_on_lead";

          return {
            id: t.id,
            title: t.title,
            body_md: t.body_md,
            kind: t.kind,
            due_at: t.due_at,
            overdue: new Date(t.due_at).getTime() < now,
            snooze_count: t.snooze_count,
            source: t.source,
            lead: t.leads,
            brief: t.lead_id ? briefBy.get(t.lead_id) ?? null : null,
            last_call: t.lead_id ? lastCallBy.get(t.lead_id) ?? null : null,
            actionable: blocked === null,
            blocked_reason: blocked,
          };
        }),
        hint: "Callsheet does not send email. Draft from the brief and the last call, " +
              "send it with your own connector, then complete_task with what you did.",
      });
    });

  server.registerTool("create_task",
    {
      title: "Create a follow-up",
      description: "A one-off task. Recurring work belongs in a playbook instead.",
      inputSchema: {
        workspace_id: z.string().uuid().optional(),
        lead_id: z.string().uuid().optional(),
        title: z.string().min(1).max(120),
        body_md: z.string().max(4000).optional(),
        kind: z.enum(["email", "call", "research", "prep", "admin", "other"]).default("other"),
        due_at: z.string().describe("ISO timestamp."),
      },
    },
    async ({ workspace_id, lead_id, title, body_md, kind, due_at }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const { data, error } = await db.from("tasks").insert({
        workspace_id: ws.id, lead_id: lead_id ?? null,
        title, body_md: body_md ?? null, kind, due_at, source: "claude",
      }).select("id, title, due_at").single();

      if (error) return jsonResult({ error: error.message });
      return jsonResult({ ok: true, task: data });
    });

  server.registerTool("complete_task",
    {
      title: "Complete a task",
      description:
        "Record what you actually did. Never mark done something you did not " +
        "do — the list stops being trustworthy the first time that happens. " +
        "Put the message id in result_json so the rep can open the real email.",
      inputSchema: {
        task_id: z.string().uuid(),
        outcome_note: z.string().min(1).max(1000),
        result_json: z.record(z.unknown()).optional(),
      },
    },
    async ({ task_id, outcome_note, result_json }) => {
      const { data, error } = await db.from("tasks").update({
        status: "done",
        closed_at: new Date().toISOString(),
        closed_by: "claude",
        outcome_note,
        result_json: result_json ?? {},
      }).eq("id", task_id).select("id, title").maybeSingle();

      if (error) return jsonResult({ error: error.message });
      if (!data) return jsonResult({ error: "not_found" });
      return jsonResult({ ok: true, task_id, title: data.title });
    });

  server.registerTool("snooze_task",
    {
      title: "Push a task back",
      description:
        "For work genuinely blocked, not work you would rather not do. Refused " +
        "after three, because a task snoozed forever is a task nobody will ever " +
        "see again.",
      inputSchema: {
        task_id: z.string().uuid(),
        due_at: z.string().describe("ISO timestamp."),
        reason: z.string().min(1).max(500),
      },
    },
    async ({ task_id, due_at, reason }) => {
      // The three-snooze rule and the reason trail live in snooze_task() now,
      // so the app's own snooze button cannot be a laxer second copy of them.
      const { data, error } = await db.rpc("snooze_task", {
        task: task_id, new_due: due_at, reason,
      });
      if (error) {
        return jsonResult({
          error: error.message,
          hint: error.message.includes("three times")
            ? "Complete it with what you did, or say in your summary that a human needs to."
            : undefined,
        });
      }
      const task = data as { id: string; due_at: string; snooze_count: number };
      return jsonResult({
        ok: true, task_id, due_at: task.due_at, snooze_count: task.snooze_count,
      });
    });

  server.registerTool("get_performance",
    {
      title: "Performance breakdowns",
      description:
        "What the Analytics page shows: best hours to call, day-of-week, " +
        "per-script conversion, dials needed per connect, and outcome mix by " +
        "segment. These were reachable only from the app, which made writing " +
        "a weekly report a matter of guessing at numbers the database already " +
        "had. Read this before put_report when the report is about HOW the " +
        "calling is going rather than what happened on a given day.",
      inputSchema: {
        ...wsArg,
        dimension: z.enum(["hour", "day_of_week", "script", "script_blocks", "pace", "segment"])
          .describe(
            "hour and day_of_week answer when to call. script answers which " +
            "opener works; script_blocks answers WHERE it stops working — per " +
            "block, how many calls reached it and how many got no further. " +
            "pace answers how many dials a conversation costs. segment answers " +
            "who to call."
          ),
        segment_by: z.enum(["city", "state", "business_type", "segment", "size_band", "independent"])
          .optional()
          .describe(
            "Only with dimension=segment. Note that business_type, segment, " +
            "size_band and independent come from a lead's brief, so leads " +
            "without one land under 'unknown'."
          ),
        script_id: z.string().uuid().optional()
          .describe("Only with dimension=script_blocks. Omit to pool every script."),
        days: z.number().int().min(1).max(365).optional(),
        timezone: z.string().optional().describe("Defaults to the workspace's own."),
      },
    },
    async ({ workspace_id, dimension, segment_by, script_id, days, timezone }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const tz = timezone ?? ws.timezone;
      const call = {
        hour: ["workspace_hourly_performance", { days: days ?? 30, tz }],
        day_of_week: ["workspace_dow_performance", { days: days ?? 90, tz }],
        script: ["workspace_script_performance", { days: days ?? 90 }],
        script_blocks: [
          "workspace_script_block_performance",
          { script: script_id ?? null, days: days ?? 90 },
        ],
        pace: ["workspace_pace", { days: days ?? 30, tz }],
        segment: [
          "workspace_segment_performance",
          { dimension: segment_by ?? "state", days: days ?? 365 },
        ],
      }[dimension] as [string, Record<string, unknown>];

      const { data, error } = await db.rpc(call[0], { ws: ws.id, ...call[1] });
      if (error) return jsonResult({ error: error.message });

      return jsonResult({
        dimension,
        ...(dimension === "segment" ? { segment_by: segment_by ?? "state" } : {}),
        ...(dimension === "script_blocks"
          ? {
              note:
                "fell_off is the count of calls that reached a block and left " +
                "by no route the script knows — usually a phrase list that " +
                "does not cover what prospects actually say. The path is " +
                "inferred from the transcript, not recorded live.",
            }
          : {}),
        days: (call[1].days as number) ?? null,
        timezone: tz,
        rows: data,
      });
    });

  // ── Playbooks ────────────────────────────────────────────────────────────

  server.registerTool("list_playbooks",
    {
      title: "List playbooks",
      description:
        "What happens automatically when a lead reaches a stage. Steps are " +
        "returned in full — a playbook is at most eight short steps, so a " +
        "separate get would be a round trip for nothing.",
      inputSchema: { workspace_id: z.string().uuid().optional() },
    },
    async ({ workspace_id }) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      const { data, error } = await db.from("playbooks")
        .select("id, name, description, trigger_stage, steps, is_active, updated_at")
        .eq("workspace_id", ws.id)
        .order("trigger_stage");

      if (error) return jsonResult({ error: error.message });
      return jsonResult({ playbooks: data ?? [] });
    });

  server.registerTool("put_playbook",
    {
      title: "Create or replace a playbook",
      description:
        "The whole playbook in one call. Idempotent on name, so revising one " +
        "rewrites it rather than adding a second. The database validates it: at " +
        "most 8 steps, one active playbook per stage, and no playbook on a " +
        "terminal stage. Write the fewest steps that actually get done — three " +
        "real ones beat eight that get snoozed.",
      inputSchema: {
        workspace_id: z.string().uuid().optional(),
        playbook_id: z.string().uuid().optional(),
        name: z.string().min(1).max(80),
        description: z.string().max(400).optional(),
        trigger_stage: z.enum(PLAYBOOK_STAGES).optional()
          .describe("Fires when a lead ENTERS this stage. Give exactly one of trigger_stage or trigger_outcome."),
        trigger_outcome: z.enum(PLAYBOOK_OUTCOMES).optional()
          .describe(
            "Fires the moment a call is dispositioned this way, before anyone has decided " +
            "what the lead is. Use it for the promises a call leaves behind — a callback " +
            "agreed, a voicemail left. Give exactly one of trigger_stage or trigger_outcome.",
          ),
        steps: z.array(z.object({
          id: z.string().regex(/^[a-z0-9_]{1,40}$/),
          title: z.string().min(1).max(120),
          kind: z.enum(["email", "call", "research", "prep", "admin", "other"]),
          anchor: z.enum(["stage", "scheduled"]).optional()
            .describe(
              "What offset_days counts from. \"stage\" (the default) counts " +
              "forward from the stage change. \"scheduled\" counts from the " +
              "lead's appointment date, and is the only way to express a " +
              "reminder BEFORE a demo. A scheduled step with no date yet is " +
              "created the moment one is set."
            ),
          offset_days: z.string().regex(/^-?\d{1,2}$/)
            .describe(
              "Whole days, -30 to 90. Negative only with anchor \"scheduled\" — " +
              "\"-1\" is the day-before confirm that stops no-shows."
            ),
          due_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()
            .describe("Local time, defaults to 09:00."),
          body_md: z.string().max(2000).optional(),
        })).min(1).max(8),
        activate: z.boolean().default(true),
      },
    },
    async (
      { workspace_id, playbook_id, name, description, trigger_stage, trigger_outcome, steps, activate },
    ) => {
      const ws = await resolveWorkspace(db, workspace_id);
      if (!ws.ok) return ws.result;

      // Checked here as well as by the CHECK constraint, because the error a
      // constraint gives for this reads as a database fault rather than a
      // missing argument.
      if (Boolean(trigger_stage) === Boolean(trigger_outcome)) {
        return jsonResult({
          error: "invalid_playbook",
          detail: "Give exactly one of trigger_stage or trigger_outcome.",
          hint: "A stage playbook fires when the lead moves; an outcome playbook fires when a call is dispositioned.",
        });
      }

      let targetId = playbook_id ?? null;
      if (!targetId) {
        const { data: existing } = await db.from("playbooks")
          .select("id").eq("workspace_id", ws.id).ilike("name", name).maybeSingle();
        targetId = existing?.id ?? null;
      }

      const row = {
        workspace_id: ws.id, name, description: description ?? null,
        trigger_stage: trigger_stage ?? null,
        trigger_outcome: trigger_outcome ?? null,
        steps, is_active: activate,
      };

      const { data, error } = targetId
        ? await db.from("playbooks").update(row).eq("id", targetId).select("id").single()
        : await db.from("playbooks").insert(row).select("id").single();

      if (error) {
        // The CHECK's message names the specific problem; pass it through rather
        // than flattening it to "invalid".
        return jsonResult({
          error: "invalid_playbook",
          detail: error.message,
          hint: "At most 8 steps, unique step ids, offset_days 0-90, and a known kind.",
        });
      }

      if (activate) {
        const { error: activateErr } = await db.rpc("activate_playbook", {
          ws: ws.id, playbook: data.id,
        });
        if (activateErr) return jsonResult({ error: activateErr.message });
      }

      return jsonResult({
        ok: true, playbook_id: data.id, replaced: Boolean(targetId),
        trigger_stage: trigger_stage ?? null,
        trigger_outcome: trigger_outcome ?? null,
        steps: steps.length,
      });
    });

  return server;
}

// ── Auth: validate the Supabase-issued bearer, keep the token for PostgREST ─
async function resolveCaller(req: Request): Promise<{ uid: string; token: string } | null> {
  const header = req.headers.get("authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const { data, error } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  return error || !data.user ? null : { uid: data.user.id, token };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const app = new Hono().basePath("/mcp");
app.use("*", cors({
  origin: "*",
  allowHeaders: ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"],
  exposeHeaders: ["mcp-session-id", "www-authenticate"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
}));

// RFC 9728 protected-resource metadata: points MCP clients at Supabase's OAuth 2.1 server.
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: RESOURCE,
    authorization_servers: [`${SUPABASE_URL}/auth/v1`],
    bearer_methods_supported: ["header"],
  }));

app.all("/", async (c) => {
  const caller = await resolveCaller(c.req.raw);
  if (!caller) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${METADATA_URL}"`,
      },
    });
  }

  // The caller's own token drives every query, so RLS is what enforces the workspace
  // boundary. See the security note at the top of this file.
  const db = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${caller.token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const transport = new WebStandardStreamableHTTPServerTransport();
  await buildServer(db).connect(transport);
  return transport.handleRequest(c.req.raw);
});

Deno.serve(app.fetch);
