-- ============================================================================
-- One definition of what snoozing means.
--
-- The rule — at most three, and always with a reason — lived only inside the
-- MCP tool, so Claude was held to it and a human was not. That asymmetry is
-- how a task list rots: the moment one party can push work forward for ever
-- without saying why, nobody trusts what is left on it.
--
-- Moving it into the database means the app can grow a snooze button without
-- becoming a second, laxer copy of the policy.
-- ============================================================================

create or replace function public.snooze_task(
  task uuid, new_due timestamptz, reason text
)
returns public.tasks
language plpgsql
security invoker
set search_path = public
as $$
declare t public.tasks;
begin
  -- Already under RLS, so a foreign task is simply invisible. Saying so beats
  -- silently changing nothing.
  select * into t from public.tasks where id = task;
  if t.id is null then
    raise exception 'task % is not visible to this account', task using errcode = '42501';
  end if;

  if t.status <> 'open' then
    raise exception 'task % is already %', task, t.status using errcode = '22023';
  end if;

  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'a snooze needs a reason — that is the whole point of the trail'
      using errcode = '22023';
  end if;

  if t.snooze_count >= 3 then
    raise exception
      'task % has been snoozed three times; finish it or say a human must', task
      using errcode = '22023';
  end if;

  if new_due <= now() then
    raise exception 'a snooze has to move the task forward' using errcode = '22023';
  end if;

  update public.tasks
     set due_at       = new_due,
         snooze_count = t.snooze_count + 1,
         -- The trail is the record of why this keeps not happening, which is
         -- the only thing that makes a third snooze arguable.
         body_md      = left(btrim(coalesce(t.body_md, '') || E'\n\nSnoozed: ' || btrim(reason)), 4000)
   where id = task
  returning * into t;

  return t;
end;
$$;

revoke execute on function public.snooze_task(uuid, timestamptz, text) from public, anon;
grant  execute on function public.snooze_task(uuid, timestamptz, text) to authenticated, service_role;
