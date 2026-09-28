-- ============================================================================
-- Claude-authored narrative: reports, lead briefs, and later call analyses.
--
-- One table, several kinds — they differ only in what they are *about*, and
-- splitting them would mean twice the RLS policies, two hook files that drift,
-- and cost_usd maintained in two places so "what has Claude cost me" becomes a
-- UNION.
--
-- This is deliberately NOT the classic (subject_type text, subject_id uuid)
-- polymorphic shape. That trades away every foreign key: delete a lead and its
-- brief becomes an orphan pointing at a meaningless uuid, and nothing stops a
-- row claiming workspace A while pointing at a lead in workspace B — which RLS
-- would happily serve.
--
-- Instead: one nullable, properly-keyed column per subject ("exclusive arc"),
-- with a CHECK saying which one each kind must use. Real keys, real cascades,
-- and — via COMPOSITE foreign keys — the database refuses a cross-workspace
-- subject outright rather than trusting every writer to get it right.
-- ============================================================================

create type public.document_kind as enum (
  'weekly_report',
  'daily_report',
  'lead_brief',
  'call_analysis'
);

-- Composite FK targets. Redundant with the primary keys, but a foreign key can
-- only reference a uniquely-constrained column list, and it is the pairing with
-- workspace_id that makes cross-workspace references impossible.
alter table public.leads
  add constraint leads_workspace_id_key unique (workspace_id, id);
alter table public.dial_call_logs
  add constraint dial_call_logs_workspace_id_key unique (workspace_id, id);

create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces on delete cascade,
  kind          public.document_kind not null,

  -- The exclusive arc. Exactly one is set for a subject-bearing kind; both are
  -- null for a report, which is about a workspace and a period, not a row.
  lead_id       uuid,
  call_id       uuid,

  title         text not null,
  body_md       text not null,
  -- The machine-readable facts behind the prose, so the UI can render chips and
  -- analytics can group by them without parsing English. This is what makes
  -- "which types of property convert" answerable.
  summary_json  jsonb not null default '{}'::jsonb,

  -- Reporting window, HALF-OPEN: [period_start, period_end). A week beginning
  -- Monday the 1st is (2026-09-01, 2026-09-08). Written down because the
  -- inclusive/exclusive ambiguity is the likeliest cause of a double-counted day.
  period_start  date,
  period_end    date,

  -- 'claude' wrote it through the MCP connector; 'system' generated it
  -- server-side; 'human' typed or edited it in the app.
  author        text not null default 'claude'
                  check (author in ('claude', 'system', 'human')),
  model         text,
  cost_usd      numeric(10, 6),

  created_by    uuid references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- MATCH SIMPLE (the default) makes these inert while the id is null, which is
  -- what lets one table carry both subject-bearing and workspace-wide rows.
  foreign key (workspace_id, lead_id)
    references public.leads (workspace_id, id) on delete cascade,
  foreign key (workspace_id, call_id)
    references public.dial_call_logs (workspace_id, id) on delete cascade,

  constraint documents_subject_matches_kind check (
    case kind
      when 'lead_brief'    then lead_id is not null and call_id is null
      when 'call_analysis' then call_id is not null and lead_id is null
      else                      lead_id is null     and call_id is null
    end
  ),
  constraint documents_period_matches_kind check (
    case kind
      when 'weekly_report' then period_start is not null and period_end is not null
      when 'daily_report'  then period_start is not null and period_end is not null
      else true
    end
  ),
  constraint documents_period_ordered check (
    period_start is null or period_end is null or period_end > period_start
  ),
  constraint documents_title_nonempty check (length(btrim(title)) > 0),
  constraint documents_body_nonempty  check (length(btrim(body_md)) > 0),
  -- A runaway generation should fail loudly rather than store a novel.
  constraint documents_body_bounded   check (length(body_md) <= 100000),

  -- REAL unique constraints, not partial indexes. PostgREST emits a bare
  -- ON CONFLICT (cols) for upserts, and a partial unique index cannot act as an
  -- arbiter without its WHERE clause, which PostgREST never sends. NULLs being
  -- distinct is what scopes each constraint to the kinds it should touch:
  -- brief rows have null periods and never collide on the first, report rows
  -- have a null lead_id and never collide on the second.
  constraint documents_one_report_per_period
    unique (workspace_id, kind, period_start, period_end),
  constraint documents_one_per_lead unique (lead_id, kind),
  constraint documents_one_per_call unique (call_id, kind)
);

create index documents_workspace_kind_idx
  on public.documents (workspace_id, kind, created_at desc);
create index documents_period_idx
  on public.documents (workspace_id, kind, period_start desc)
  where period_start is not null;

create trigger documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();

-- ── RLS: full CRUD for members, matching the leads and call_scripts pattern ──
alter table public.documents enable row level security;

create policy "documents readable by members" on public.documents
  for select to authenticated using (public.is_workspace_member(workspace_id));

create policy "documents insertable by members" on public.documents
  for insert to authenticated with check (public.is_workspace_member(workspace_id));

create policy "documents updatable by members" on public.documents
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "documents deletable by members" on public.documents
  for delete to authenticated using (public.is_workspace_member(workspace_id));

-- ============================================================================
-- workspace_period_summary — everything that happened between two dates.
--
-- The end-of-day tool answers one day. A weekly report needs a range, and
-- assembling it from seven daily calls produces a different shape every time.
-- One function means the report and (later) the analytics page cite identical
-- numbers; if those two ever disagree, both lose their credibility.
--
-- The range is HALF-OPEN, [start_date, end_date), matching documents.period_*.
-- ============================================================================
create or replace function public.workspace_period_summary(
  ws uuid,
  start_date date,
  end_date date,
  tz text default 'UTC'
)
returns jsonb
language plpgsql
security invoker
stable
set search_path = public
as $$
declare
  from_ts timestamptz;
  to_ts   timestamptz;
  result  jsonb;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  if end_date <= start_date then
    raise exception 'end_date must be after start_date (the range is half-open)'
      using errcode = '22007';
  end if;

  from_ts := (start_date::timestamp at time zone tz);
  to_ts   := (end_date::timestamp   at time zone tz);

  with scoped as (
    select *
    from public.dial_call_logs
    where workspace_id = ws
      and called_at >= from_ts
      and called_at <  to_ts
  ),
  totals as (
    select
      count(*)                                                          as calls,
      count(*) filter (where outcome is not null)                       as dispositioned,
      count(*) filter (where public.is_connected_outcome(outcome))      as connected,
      count(*) filter (where outcome = 'appointment_set')               as appointments,
      count(*) filter (where outcome = 'callback_requested')            as callbacks,
      count(distinct lead_id) filter (where lead_id is not null)        as unique_leads,
      coalesce(sum(duration_seconds), 0)                                as talk_seconds
    from scoped
  ),
  by_outcome as (
    select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb) as v
    from (select outcome, count(*) n from scoped where outcome is not null group by outcome) x
  ),
  by_day as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'day', d, 'calls', calls, 'connects', connects) order by d), '[]'::jsonb) as v
    from (
      select
        date(timezone(tz, s.called_at))                                as d,
        count(*)                                                       as calls,
        count(*) filter (where public.is_connected_outcome(s.outcome)) as connects
      from scoped s
      group by 1
    ) x
  ),
  by_hour as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'hour', h, 'calls', calls, 'connects', connects) order by h), '[]'::jsonb) as v
    from (
      select
        extract(hour from timezone(tz, s.called_at))::int               as h,
        count(*)                                                        as calls,
        count(*) filter (where public.is_connected_outcome(s.outcome))  as connects
      from scoped s
      group by 1
    ) x
  ),
  notable as (
    -- Calls worth naming in a report: a real conversation, or a note the rep
    -- bothered to write.
    select coalesce(jsonb_agg(jsonb_build_object(
             'call_id', id, 'business_name', business_name, 'outcome', outcome,
             'duration_seconds', duration_seconds, 'called_at', called_at,
             'notes', notes) order by called_at), '[]'::jsonb) as v
    from (
      select * from scoped
      where outcome in ('appointment_set', 'callback_requested', 'connected_dm')
         or (notes is not null and length(btrim(notes)) > 0)
      order by called_at
      limit 40
    ) x
  )
  select jsonb_build_object(
    'period', jsonb_build_object(
      'start', start_date, 'end', end_date, 'timezone', tz,
      'days', (end_date - start_date)),
    'totals', to_jsonb(t) || jsonb_build_object(
      'connection_rate',
      case when t.dispositioned > 0
        then round(t.connected::numeric / t.dispositioned::numeric * 100, 1)
        else 0 end),
    'by_outcome',    o.v,
    'by_day',        d.v,
    'by_hour',       h.v,
    'notable_calls', n.v
  )
  into result
  from totals t, by_outcome o, by_day d, by_hour h, notable n;

  return result;
end;
$$;

-- EXECUTE is granted to PUBLIC by default, so revoking from anon alone is a
-- silent no-op. Revoke from PUBLIC, then grant back deliberately.
revoke execute on function public.workspace_period_summary(uuid, date, date, text)
  from public, anon;
grant execute on function public.workspace_period_summary(uuid, date, date, text)
  to authenticated, service_role;
