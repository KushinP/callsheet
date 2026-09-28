-- ============================================================================
-- Steps waiting on a date the lead does not have yet.
--
-- A 'scheduled'-anchored step with no scheduled_at is correctly deferred — a
-- reminder counting back from a date nobody has set cannot be given a due date
-- without inventing one. But it is deferred SILENTLY: the playbook shows four
-- steps, the lead shows two tasks, and nothing anywhere connects the two.
--
-- Both demo leads sat like that: on demo_booked, no date, half a playbook
-- quietly not running.
-- ============================================================================

create or replace function public.lead_pending_steps(lead_id uuid)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::int
  from public.leads l
  join public.playbooks p
    on p.workspace_id = l.workspace_id
   and p.trigger_stage = l.pipeline_stage
   and p.is_active
  cross join lateral jsonb_array_elements(p.steps) as s
  where l.id = lead_pending_steps.lead_id
    and l.scheduled_at is null
    and coalesce(s ->> 'anchor', 'stage') = 'scheduled'
    -- A step already created is not pending, which matters after a date is
    -- set and then cleared again.
    and not exists (
      select 1 from public.tasks t
      where t.lead_id = l.id
        and t.playbook_id = p.id
        and t.playbook_step_id = s ->> 'id'
    );
$$;

revoke execute on function public.lead_pending_steps(uuid) from public, anon;
grant  execute on function public.lead_pending_steps(uuid) to authenticated, service_role;
