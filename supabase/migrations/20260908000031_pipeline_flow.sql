-- ============================================================================
-- Where leads actually went, as flows rather than a row of counts.
--
-- workspace_funnel answers "how many are sitting here". A Sankey answers a
-- different and better question — of everything that came in, how far did it
-- get and where did it leave — and that needs each lead placed at the furthest
-- point it can be PROVEN to have reached, not merely where it sits now.
--
-- For the forward chain those are the same thing: progression is monotonic, so
-- a lead in 'pilot' passed through everything before it.
--
-- The exits are the hard part, because nothing records stage history. A lead
-- marked lost keeps no memory of whether it died on the first dial or after a
-- demo. So rather than guess, use the evidence that is actually on the row: a
-- scheduled_at proves a demo was booked, a call_count proves it was called.
-- That UNDERSTATES how far a lost lead got — it cannot see a completed demo —
-- and the chart says so on its face rather than pretending otherwise.
--
-- The three non-chain stages are named here and grouped in src/lib/types.ts.
-- Adding a fourth means touching both.
--
-- SUPERSEDED by 20260908000032_stage_history.sql, which records transitions
-- as they happen and no longer has to infer any of this. Kept because it ran.
-- ============================================================================
create or replace function public.workspace_pipeline_flow(ws uuid)
returns table (
  reached public.pipeline_stage,
  exited_as public.pipeline_stage,
  leads bigint
)
language plpgsql
security invoker
stable
set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  with resolved as (
    select
      case
        -- A no-show is a demo that was booked. That is what the word means.
        when l.pipeline_stage = 'demo_no_show' then 'demo_booked'::public.pipeline_stage
        when l.pipeline_stage in ('lost', 'not_a_fit') then
          case
            when l.scheduled_at is not null then 'demo_booked'::public.pipeline_stage
            when l.call_count > 0 then 'called'::public.pipeline_stage
            else 'new'::public.pipeline_stage
          end
        else l.pipeline_stage
      end as reached,
      case
        when l.pipeline_stage in ('demo_no_show', 'lost', 'not_a_fit')
          then l.pipeline_stage
        else null::public.pipeline_stage
      end as exited_as
    from public.leads l
    where l.workspace_id = ws
  )
  select r.reached, r.exited_as, count(*)
  from resolved r
  group by r.reached, r.exited_as
  order by array_position(enum_range(null::public.pipeline_stage), r.reached);
end;
$$;

revoke execute on function public.workspace_pipeline_flow(uuid) from public, anon;
grant  execute on function public.workspace_pipeline_flow(uuid) to authenticated, service_role;
