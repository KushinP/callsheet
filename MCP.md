# Callsheet MCP connector

Lets Claude read and write your Callsheet data from chat — end-of-day summaries,
reviewing calls, correcting dispositions.

**Endpoint:** `https://<project-ref>.supabase.co/functions/v1/mcp`

---

## How it's secured

The connector authenticates as **you**, not as the server.

Supabase's OAuth server issues an access token for your account; the function
validates it and then passes that same token to `supabase-js`, so every query
runs as `authenticated` with your `auth.uid()` and **Row Level Security decides
what is visible**. There is no service-role client anywhere in the file — it is
the one thing `scripts/check-mcp-safety.mjs` asserts, and it's checked on every
build.

Three consequences worth knowing:

- A bug in a tool returns **your own** rows, never another workspace's.
- The connector **cannot read your Twilio credentials.**
  `workspace_twilio_secrets` has RLS on with zero policies, so it's unreachable
  by any client role.
- The connector **cannot place calls.** There is no dialling tool.

---

## Setup

Steps 1–3 are one-time configuration in the Supabase dashboard. I can't do these
through the API — they're console-only.

### 1. Enable the OAuth server

[Authentication → OAuth Server](https://supabase.com/dashboard/project/<project-ref>/auth/oauth-server)

- Turn **Enable OAuth server** on.
- Turn **Allow dynamic client registration** on — this is what lets Claude
  register itself. Without it there's no `registration_endpoint` in the
  discovery document and Claude can't complete setup.
- Set **Authorization Path** to `/oauth-consent.html`.

### 2. Set the Site URL

[Authentication → URL Configuration](https://supabase.com/dashboard/project/<project-ref>/auth/url-configuration)

**Site URL** is where the consent page lives. The redirect happens in *your*
browser, not server-to-server, so a local dev server is fine for testing:

| Situation | Site URL |
| --- | --- |
| Testing locally | `http://localhost:5173` (dev server must be running when you connect) |
| Deployed | your app's URL, e.g. `https://callsheet.yourdomain.com` |

The consent page is `oauth-consent.html`, a second Vite entry, so it ships with
the app automatically and reads the same `.env.local`. No separate host needed.

> Why it can't live on Supabase: `*.supabase.co` force-downgrades HTML responses
> to `text/plain` as an anti-phishing measure, so a consent page served from an
> edge function renders as source code.

### 3. Add the connector in Claude

Settings → Connectors → **Add custom connector** → paste:

```
https://<project-ref>.supabase.co/functions/v1/mcp
```

You'll be sent to the consent page, sign in with your Callsheet email and
password, and click **Allow**.

---

## Verifying

```bash
SMOKE_EMAIL=you@email.com SMOKE_PASSWORD=… node scripts/mcp-smoke.mjs
```

Signs in, runs `initialize → tools/list → tools/call`, and confirms RLS resolved
you. It uses a password grant rather than OAuth, but both mint the same kind of
Supabase access token — so it exercises the exact assumption the security model
rests on, and works before the dashboard steps are done.

Then the real test: ask Claude *"summarise my calls today"* and check it against
the Call Log.

---

## Tools

**Calls and leads (read)** — `list_workspaces`, `get_daily_summary`,
`get_call_stats`, `list_calls`, `get_call`, `list_sessions`, `get_session`,
`list_leads`, `get_lead`

**Transcripts** — `get_call_transcript`, `list_transcripts`, `search_transcripts`

**Scripts** — `list_scripts`, `get_script`, `put_script`, `set_default_script`,
`delete_script`

**Analytics** — `get_period_summary`, `get_performance`

**Building the list** — `describe_lead_fields`, `create_leads`, `update_lead`,
`create_call`, `create_session`

**Pipeline** — `set_lead_stage`, `suggest_lead_tier`, `set_lead_tags`

**Documents** — `list_reports`, `get_report`, `put_report`, `put_lead_brief`,
`delete_document`

**Follow-ups** — `list_tasks`, `create_task`, `complete_task`, `snooze_task`,
`list_playbooks`, `put_playbook`

`list_tasks` is built for a scheduled session: it returns what is due with the
lead, its brief and its last call already attached, so acting on a task is one
round trip rather than four. Each task carries `actionable` and
`blocked_reason` computed server-side — a `call` task is never actionable
because there is no dialling tool, an `email` task on a lead with no address
says so — because those rules belong in one place rather than in the model's
judgement every night.

`complete_task` requires an `outcome_note` and takes a `result_json` for the
message id. A tick with no record is not worth storing, and that id is what
lets you open the real email instead of taking Claude's word for it.
`snooze_task` refuses after three: the alternative to snoozing forever is
marking done something that was never done, which corrupts the list for good.

**Playbooks** turn a stage change into follow-ups. `put_playbook` writes one in
a single call and the database validates it — at most 8 steps, one active
playbook per stage, and a step fires at most once per lead ever. Those limits
are constraints, not conventions, so a playbook that would spawn forty tasks
comes back rejected with the reason.

`suggest_lead_tier` writes a suggestion. If you have set a tier by hand, yours
stands: `tier` is a generated column over your override, so Claude cannot write
it at all rather than being asked not to.

**Write** — `set_call_outcome`, `append_call_note`, `set_lead_do_not_call`

`get_performance` is the other half of writing a report. `get_period_summary`
says what happened in a range; this says how the calling itself is going — best
hour, day of week, which script converts, dials per connect, outcome mix by
segment. Both read the same RPCs the Analytics page does, so a report and the
page cannot quote different numbers.

`create_call` backfills a call placed somewhere else — a mobile, an old
spreadsheet, history sitting in a lead's notes as prose. Until it is logged,
`call_count` and every rolling stat understate what actually happened. It is
deliberately not idempotent, so read `get_lead`'s history first, and backfilled
rows carry `mode: "manual"` so reconstructed history is never mistaken for
something Twilio measured.

`search_transcripts` is full-text across everything you've said on the phone —
Postgres `tsvector` with a GIN index and `ts_headline` snippets, so *"find calls
where they pushed back on price"* returns the matching lines, not just call ids.
That is the point of keeping transcripts at all: they're a corpus to interrogate
after the fact, not a wall of text to read.

`put_script` takes a whole script document in one call and is idempotent on
`(workspace, name)`, so *"update the discovery script to open with X"* rewrites
the existing one instead of creating a second. The blocks are validated by a
Postgres `CHECK` before the row lands — duplicate ids, unknown block kinds, and
branches pointing at blocks that don't exist are all rejected at write time,
including from here. A script Claude writes cannot be one the prompter chokes on.

`get_daily_summary` is the one that matters for the end-of-day post. One call
returns the totals, the outcome breakdown with human labels, connection rate,
talk time, sessions worked, and the calls worth mentioning with your own notes
attached — so the summary reads the same way every evening instead of Claude
assembling it differently each time.

There is deliberately **no Slack tool**. Claude already has a Slack connector;
Callsheet's job is to produce the data, Slack's is to post it. Adding one would
mean storing a Slack token here for no benefit.

Still deliberately absent: **any way to send email.** A task says what needs
sending; Claude sends it with its own Gmail or Outlook connector. Same argument
as the missing Slack tool — storing a second set of credentials to do something
Claude can already do is pure downside.

Also deliberately absent: anything that deletes calls or leads. The app has UI
for those, and they're where a connector earns a bad day. `delete_script` and
`delete_document` are the exceptions — a script or a report is a document you
can rewrite, not a record of something that happened.

Bulk creation is allowed and bulk destruction is not, which is the asymmetry
worth having: `create_leads` takes an array because building a list is the job,
while removing one stays where a human is looking at what goes.

---

## Multiple workspaces

Most accounts have exactly one, and every tool defaults to it. If you belong to
several, tools return `ambiguous_workspace` with the list rather than guessing —
a wrong guess would write into the wrong team's data. Pass `workspace_id`, or
just tell Claude which one.
