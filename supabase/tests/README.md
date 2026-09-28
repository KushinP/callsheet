# Database tests

Two self-contained SQL scripts that create their own users and workspaces,
assert, then clean up after themselves. Both leave the database exactly as they
found it.

Run them against a project with the migrations applied — Supabase SQL Editor,
`psql`, or `supabase db execute`:

```bash
psql "$DATABASE_URL" -f supabase/tests/schema_test.sql
psql "$DATABASE_URL" -f supabase/tests/rls_test.sql
```

Each prints a `step | result` table. Every row should read `PASS`.

| File | Covers |
| --- | --- |
| `schema_test.sql` | Signup side effects, CSV import idempotency, session building, the do-not-call block, call/lead triggers, dashboard stats |
| `rls_test.sql` | Cross-workspace isolation: reads, writes, RPCs, and the Twilio secret table |

> Run these on a scratch project, not one holding real call history. They insert
> directly into `auth.users`, which needs the service role.
