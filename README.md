# Callsheet

A dark-industrial B2B power-dialer CRM for cold-calling local service businesses.
Import CSVs of leads into a workspace, freeze a filtered slice into an ordered
calling session, and power through it with a browser-based dialer that logs
every call, recording, and outcome.

Built from the spec in *The Newbie's Guide to Building Your Own Dialer*, as a
real codebase you own outright rather than a hosted no-code build.

---

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React 19 · Vite · TypeScript · Tailwind v4 · Radix primitives |
| Data | TanStack Query, server-side pagination throughout |
| Charts | Recharts |
| Voice | Twilio Voice SDK (WebRTC, in-browser) |
| Backend | Supabase — Postgres, Auth, Edge Functions |
| Isolation | Row Level Security on every workspace-scoped table |

---

## Setup

### 1. Supabase project

Create a project at [supabase.com](https://supabase.com), then apply the
migrations in `supabase/migrations/` in filename order (SQL Editor, or
`supabase db push` with the CLI linked).

### 2. Environment

```bash
cp .env.example .env.local
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from
**Project Settings → API**.

### 3. Edge functions

Deploy the eleven functions in `supabase/functions/`. `supabase/config.toml`
already records which ones must skip JWT verification:

```bash
supabase functions deploy twilio-token twilio-provision twilio-conference recording-proxy delete-calls generate-lead-briefs
supabase functions deploy twilio-voice twilio-status twilio-recording mcp process-recording --no-verify-jwt
```

Three of those skip JWT verification because they are Twilio webhooks — Twilio
cannot present a Supabase JWT, so they authenticate every request by its
`X-Twilio-Signature` instead, using the workspace's own auth token. The other
two have their own schemes: `mcp` takes an OAuth bearer token from Claude, and
`process-recording` is only ever called by `twilio-recording` and checks a
shared `INTERNAL_FN_SECRET`.

### 4. Run it

```bash
npm install && npm run dev
```

To deploy the frontend (Cloudflare Pages):

```bash
npm run build && npx wrangler pages deploy dist --project-name callsheet --branch main
```

`public/_redirects` sends unmatched paths to `index.html` so client-side routes
survive a hard refresh. Real files are still served first, which is what keeps
`/oauth-consent.html` (built from `oauth-consent.html`, a second Vite entry) a
genuine page rather than the SPA shell — Pages redirects
it to the extensionless `/oauth-consent` and preserves the query string, so the
`.html` form is the one to configure everywhere: it works both here and on the
Vite dev server, which has no such rewrite.

### 5. Twilio

Sign up at [twilio.com](https://twilio.com), buy a Voice-capable number, then
sign in to your own app and open **Settings**. Paste the Account SID, Auth
Token, and phone number, and save.

Saving does more than store three strings. The `twilio-provision` function:

1. verifies the credentials against the Twilio API,
2. confirms the number is on your account and has Voice enabled,
3. **creates an API key and a TwiML application for you**, pointed at this
   project's `twilio-voice` webhook, and
4. writes the Auth Token and API key secret to a table only the edge functions
   can read.

Browser calling needs an API key pair (to sign access tokens) and a TwiML app
(to route the call). Provisioning them automatically is why the Settings page
only asks for the three things you already have.

### 6. Recordings and transcripts (optional)

Everything above works without this step. Calls record either way; these
secrets decide where the audio lives and whether it gets transcribed. Set them
under **Project Settings → Edge Functions → Secrets**, or with the CLI:

| Secret | What it does | Without it |
| --- | --- | --- |
| `INTERNAL_FN_SECRET` | Lets `twilio-recording` call `process-recording`. Any long random string. | Recordings are never offloaded or transcribed |
| `LLM_API_KEY` | A [Google AI Studio](https://aistudio.google.com/apikey) key. Transcribes the audio. **Enable billing on it** — on Gemini's free tier Google may use submitted content to improve its products and human reviewers may read it, and what gets submitted here is recorded calls with real people. See `docs/COSTS.md`. | Recording is stored; `transcription_error` reads `no_stt_key` |
| `R2_ACCOUNT_ID` | Cloudflare account id | |
| `R2_ACCESS_KEY_ID` | R2 API token id | Audio stays on Twilio, where storage bills |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | **monthly, forever** — see `docs/COSTS.md` |
| `R2_BUCKET` | Bucket name, e.g. `callsheet-recordings` | |

Optional: `STT_PROVIDER` (`gemini` by default, or `deepgram` / `groq`) and
`STT_API_KEY` if the transcription key differs from `LLM_API_KEY`. Switching
provider is one env var — no code change.

**Every one of these degrades quietly.** A missing key is recorded on the call
row as `transcription_error` and never raises a toast, so a half-configured
install still places and logs calls normally.

### 7. Keep a free project awake (optional)

Supabase pauses free projects after seven days without database activity.
`workers/heartbeat` is a Cloudflare cron worker that makes one tiny RPC call a
day. Point it at your project and deploy:

```bash
cd workers/heartbeat
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler deploy
```

### 8. Claude (optional)

To query your calls from Claude, enable the OAuth server under
**Authentication → OAuth**, turn on dynamic client registration, set the
Authorization Path to `/oauth-consent.html`, then add
`https://<project>.supabase.co/functions/v1/mcp` as a connector in
**Claude → Settings → Connectors**. See `MCP.md` for the tool list.

---

## Architecture

```
Agent browser                Supabase                    Twilio
─────────────                ────────                    ──────
Twilio Voice SDK  ──token──▶ twilio-token
      │                            │
      │◀─────── access token ──────┘
      │
      └── WebRTC ──────────────────────────────────────▶ Voice API
                                                             │
                             twilio-voice  ◀────TwiML req────┘
                                   │                         │
                                   └──── <Dial> ────────────▶│
                             twilio-status  ◀──call events───┤
                          twilio-recording  ◀──recording─────┘
                                   │
                          Postgres (RLS per workspace)
```

The browser talks to Twilio directly over WebRTC. There is no phone-bridge
step and no separate softphone, which is what makes the persistent DTMF
keypad, live mute, and conference join-me mode possible.

---

## The call flow

1. Agent clicks Call (session queue or floating widget).
2. A `dial_call_logs` row is created **first** — the do-not-call trigger
   rejects flagged leads here, before any Twilio request goes out.
3. Local ringback (440 + 480 Hz, Web Audio API) starts immediately.
4. `Device.connect()` opens the WebRTC leg; Twilio asks `twilio-voice` for TwiML.
5. `<Dial answerOnBridge>` rings the lead. The agent's leg stays unanswered
   until pickup, which is why the local ringback lines up with reality.
6. `twilio-status` records progress and real talk duration; `twilio-recording`
   attaches the recording once Twilio finishes processing it.
7. Disposition chips appear. Outcomes stay editable from the Call Log.

---

## Schema

Every workspace-scoped table carries `workspace_id` and is covered by an RLS
policy keyed off `is_workspace_member()`.

| Table | Purpose |
| --- | --- |
| `workspaces` | Org container, one auto-created per signup |
| `workspace_members` | User/workspace membership and role |
| `leads` | Imported businesses, unique on `(workspace_id, phone_normalized)` |
| `calling_sessions` | Dial sessions with status and progress |
| `session_leads` | Queue order, unique on `(session_id, phone_normalized)` |
| `dial_call_logs` | Call records: SID, duration, recording, outcome |
| `call_transcripts` | Transcript text, one per call |
| `call_scripts` | Script blocks the prompter reads, one default per workspace |
| `documents` | Claude's own writing: lead briefs and reports |
| `tasks` | Follow-ups, from a playbook or by hand |
| `playbooks` | Task templates that fire on a stage change |
| `workspace_twilio_settings` | Account SID, numbers, TwiML app |

Filter presets live in `localStorage`, not the database — they are per-browser.

Two details worth knowing:

- **`outcome` lives in two places.** On `leads` it is the lead's *current*
  state; on `dial_call_logs` it is the result of *that* call. A lead can be
  called many times with a different outcome each time.
- **Twilio secrets are in their own table.** `workspace_twilio_secrets` has RLS
  on with **no policies at all**, so every client role is denied and only the
  service role can read the Auth Token. Postgres RLS is row-level, not
  column-level — hence two tables.

### Server-side logic

| Function | Does |
| --- | --- |
| `import_leads(ws, payload)` | Idempotent CSV upsert by normalized phone |
| `build_session(ws, name, filters, max)` | Freezes a filtered slice into an ordered queue |
| `workspace_call_stats(ws, tz)` | Dashboard KPIs in one round trip |
| `workspace_daily_calls(ws, days, tz)` | Chart series |
| `normalize_phone(raw)` | Digits only, US country code dropped |

Re-importing an overlapping list refreshes business details but never resets a
lead's status, outcome, notes, or do-not-call flag.

---

## Compliance

This is not legal advice. US outbound calling is governed by the TCPA and
state DNC rules; get real guidance before scaling volume.

**What is enforced here:**

- `leads.do_not_call` is a hard boolean, separate from the `do_not_call`
  outcome. A `BEFORE INSERT` trigger on `dial_call_logs` **raises an exception**
  if the lead is flagged — the block is in the database, not the UI.
- Logging a `do_not_call` outcome raises that flag automatically via trigger,
  so a future session built from a filter can never pick the number back up.
- `build_session()` excludes flagged leads at queue-build time.

**What is not:**

- No National DNC Registry checking. That needs a compliance API.
- No calling-hour restrictions by the lead's local time zone. Add this before
  running volume across time zones.
- Built for human-initiated, one-at-a-time dialing. Bolting on multi-line or
  autodialing behavior changes your regulatory posture materially.

---

## Tests

Two SQL scripts under `supabase/tests/` create their own users and workspaces,
assert, and clean up after themselves:

```bash
psql "$DATABASE_URL" -f supabase/tests/schema_test.sql
psql "$DATABASE_URL" -f supabase/tests/rls_test.sql
```

`schema_test.sql` (12 checks) covers signup side effects, CSV import
idempotency, session building, the do-not-call block, call/lead triggers, and
dashboard stats. `rls_test.sql` (8 checks) creates two unrelated users and
confirms neither can read, write, or RPC into the other's workspace — including
that the Twilio auth token is unreadable by any client role.

All 20 pass against a fresh project, as does the full UI path: signup → sign in →
CSV import with column mapping → filtered session build → queue advance.

---

## Security posture

Run `supabase inspect` or the dashboard's Advisors page and three warnings
remain. All three are deliberate:

| Warning | Why it stays |
| --- | --- |
| `workspace_twilio_secrets` has RLS on with no policies | That is the point. Zero policies means every client role is denied and only the service role can read the auth token. |
| `authenticated` can execute `is_workspace_member` / `is_workspace_admin` / `shares_workspace_with` | RLS policies are evaluated with the *querying* role's privileges, so revoking these would break every policy. Each only answers a question about the caller's own membership, so there is nothing to leak. |
| Leaked password protection disabled | A one-click toggle under **Authentication → Policies** if you want signups checked against HaveIBeenPwned. Worth enabling before you add teammates. |

Everything else the linter flagged has been fixed: `search_path` is pinned on
every function, `pg_trgm` lives in the `extensions` schema, and no function is
callable by `anon` at all.

> A note on the fix, because it is an easy thing to get wrong: Postgres grants
> `EXECUTE` on every new function to `PUBLIC`, and `anon` inherits it from
> there. `REVOKE ... FROM anon` is a silent no-op while that `PUBLIC` grant
> stands. `migrations/…_hardening.sql` revokes from `PUBLIC` and then grants
> back only to the roles that need it.

---

## Signing in

Supabase requires email confirmation by default, so a new signup gets a
confirmation link before it can sign in. Two options:

- Leave it on and click the link in the email.
- Turn it off for frictionless team signup: **Authentication → Sign In / Up →
  Email → uncheck "Confirm email"** in the dashboard.

---

## Where to take it next

1. **DNC registry checking** at import time via a compliance API.
2. **Multi-line dialing** — 2–4 numbers per agent, connect the first answer.
   Biggest talk-time gain, biggest compliance risk.
3. **AI-scored transcripts** — `call_transcripts` already exists; run each
   through an LLM to suggest a disposition or flag high-intent calls.
4. **AI voicemail drop** on `voicemail` outcomes.
5. **CRM sync** — push outcomes to GoHighLevel via an edge function.
6. **Workspace roles** — `workspace_members.role` already carries
   owner/admin/agent; give admins cross-agent stats and session assignment.

---

## Layout

```
src/
  components/
    ui/           Buttons, tables, dialogs — theme primitives
    dialer/       Keypad, disposition chips, mic picker, floating widget
    leads/        CSV import with column mapping, filter bar
    calls/        Recording player
    layout/       App shell and page chrome
  hooks/
    useAuth       Session state with an initialization guard
    useWorkspace  Active workspace, role, Twilio readiness
    useDialer     Twilio Device lifecycle and the call state machine
    useLeads / useSessions / useCalls
  lib/
    ringback.ts   440+480 Hz ringback and DTMF feedback tones
    types.ts      Enums and their human labels, in one place
supabase/
  migrations/     Schema, RLS, server-side functions
  functions/      Eleven edge functions
workers/
  heartbeat/      Daily ping that keeps a free Supabase project from pausing
```

---

## License

[MIT](LICENSE)
