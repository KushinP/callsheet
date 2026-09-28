-- ============================================================================
-- Where a call went against its script.
--
-- advance_on and trigger have been inert since scripts were built. Matching
-- them against the transcript after the call turns "which script connected"
-- into "where calls fall off the script", which is the question actually worth
-- asking of an opener.
--
-- Inferred, not recorded: the rep does not tell the app which block they were
-- on, so this is a reading of the transcript and is stored as one. The phrase
-- that matched is kept on every step so a human can check the inference rather
-- than take it on faith.
-- ============================================================================

alter table public.dial_call_logs
  add column if not exists script_path jsonb;

comment on column public.dial_call_logs.script_path is
  'Where the call went against its script, inferred from the transcript after the fact. { steps[], ended_at, rep_label, unmatched_turns }.';

create index if not exists dial_call_logs_script_path_idx
  on public.dial_call_logs (workspace_id, script_id)
  where script_path is not null;

create or replace function public.workspace_script_block_performance(
  ws uuid, script uuid default null, days integer default 90
)
returns table (
  block_id text,
  reached bigint,
  advanced bigint,
  branched bigint,
  fell_off bigint,
  connects bigint,
  appointments bigint
)
language plpgsql security invoker stable set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  return query
  with walked as (
    select
      c.id as call_id,
      c.outcome,
      step ->> 'block_id' as block_id,
      step ->> 'via' as via
    from public.dial_call_logs c
    cross join lateral jsonb_array_elements(c.script_path -> 'steps') as step
    where c.workspace_id = ws
      and c.script_path is not null
      and (script is null or c.script_id = script)
      and c.called_at >= now() - make_interval(days => greatest(days, 1))
  )
  select
    w.block_id,
    count(*),
    count(*) filter (where w.via = 'advance_on'),
    count(*) filter (where w.via = 'branch'),
    -- Reaching a block and never leaving it is the number that matters: it is
    -- the point where the script stopped describing the conversation.
    count(*) filter (where w.via = 'end'),
    count(*) filter (where public.is_connected_outcome(w.outcome)),
    count(*) filter (where w.outcome = 'appointment_set')
  from walked w
  group by w.block_id
  order by count(*) desc;
end;
$$;

revoke execute on function public.workspace_script_block_performance(uuid, uuid, integer)
  from public, anon;
grant  execute on function public.workspace_script_block_performance(uuid, uuid, integer)
  to authenticated, service_role;
