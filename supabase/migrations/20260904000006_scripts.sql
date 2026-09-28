-- ============================================================================
-- Call scripts.
--
-- A script is one row holding an ordered graph of blocks. Stored as jsonb, not
-- normalized tables, because:
--   - It must be writable in ONE shot. PostgREST has no multi-statement
--     transaction, so a normalized script means N+1 inserts per MCP tool call
--     with no rollback. One row = one whole script = an atomic write.
--   - There is no relational access pattern. A script is always read whole, at
--     session start; nothing ever queries across blocks.
--   - Branches are graph edges, awkward as self-referencing foreign keys.
--   - Versioning becomes a row copy instead of a subtree copy.
--
-- What jsonb gives up is referential integrity, so validate_script_blocks()
-- below recovers most of it in a CHECK: bad scripts are rejected at write time,
-- including writes coming from the MCP connector.
-- ============================================================================

create or replace function public.validate_script_blocks(blocks jsonb, entry text)
returns text                          -- null when valid, else the first problem
language plpgsql
immutable
set search_path = public
as $$
declare
  ids text[];
  blk jsonb;
  target text;
begin
  if blocks is null or jsonb_typeof(blocks) <> 'array' then
    return 'blocks must be a JSON array';
  end if;
  if jsonb_array_length(blocks) = 0 then
    return 'a script needs at least one block';
  end if;
  if jsonb_array_length(blocks) > 100 then
    return 'a script cannot exceed 100 blocks';
  end if;

  select array_agg(b ->> 'id') into ids from jsonb_array_elements(blocks) b;

  for blk in select * from jsonb_array_elements(blocks) loop
    if nullif(blk ->> 'id', '') is null then
      return 'every block needs a non-empty id';
    end if;
    if nullif(blk ->> 'text', '') is null then
      return format('block "%s" has no text', blk ->> 'id');
    end if;
    if coalesce(blk ->> 'kind', '') not in
       ('opening', 'question', 'pitch', 'objection', 'close', 'voicemail', 'note') then
      return format('block "%s" has an unknown kind "%s"', blk ->> 'id', blk ->> 'kind');
    end if;
  end loop;

  if (select count(distinct x) from unnest(ids) x) <> array_length(ids, 1) then
    return 'block ids must be unique within a script';
  end if;
  if entry is null or not (entry = any (ids)) then
    return 'entry_block_id does not match any block id';
  end if;

  -- Every `next` and every branch `goto` must land on a real block, or the
  -- prompter dead-ends mid-call.
  for blk in select * from jsonb_array_elements(blocks) loop
    target := blk ->> 'next';
    if target is not null and not (target = any (ids)) then
      return format('block "%s".next points at a missing block "%s"', blk ->> 'id', target);
    end if;
    for target in
      select b ->> 'goto' from jsonb_array_elements(coalesce(blk -> 'branches', '[]'::jsonb)) b
    loop
      if target is not null and not (target = any (ids)) then
        return format('a branch on block "%s" points at a missing block "%s"',
                      blk ->> 'id', target);
      end if;
    end loop;
  end loop;

  return null;
end;
$$;

create table public.call_scripts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces on delete cascade,
  name text not null,
  description text,
  -- [{ id, kind, label, text, advance_on[], branches[{trigger[], goto, label}], next }]
  blocks jsonb not null default '[]'::jsonb,
  entry_block_id text not null,
  -- Placeholders the prompter interpolates from the lead row: {{business_name}}.
  variables text[] not null default array['business_name', 'city', 'state', 'phone'],
  is_default boolean not null default false,
  version integer not null default 1,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint call_scripts_blocks_valid
    check (public.validate_script_blocks(blocks, entry_block_id) is null)
);

-- Exactly one default per workspace, enforced by the database rather than by
-- remembering to clear the old one.
create unique index call_scripts_one_default_idx
  on public.call_scripts (workspace_id) where is_default;
create unique index call_scripts_workspace_name_idx
  on public.call_scripts (workspace_id, lower(name));
create index call_scripts_workspace_idx
  on public.call_scripts (workspace_id, updated_at desc);

create trigger call_scripts_touch before update on public.call_scripts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Attachment points.
--
-- transcription_enabled is unused in this phase but lands now so the column is
-- already in place when the live prompter arrives — it is the switch that
-- decides whether twilio-voice emits <Start><Transcription>, which is the
-- difference between a fraction of a cent and eight cents a call.
-- ---------------------------------------------------------------------------
alter table public.calling_sessions
  add column script_id uuid references public.call_scripts on delete set null,
  add column transcription_enabled boolean not null default false;

alter table public.dial_call_logs
  add column script_id uuid references public.call_scripts on delete set null,
  add column transcribe boolean not null default false;

-- ---------------------------------------------------------------------------
-- RLS — full CRUD for workspace members, matching the leads pattern.
-- ---------------------------------------------------------------------------
alter table public.call_scripts enable row level security;

create policy "scripts readable by members" on public.call_scripts
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "scripts insertable by members" on public.call_scripts
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "scripts updatable by members" on public.call_scripts
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy "scripts deletable by members" on public.call_scripts
  for delete to authenticated using (public.is_workspace_member(workspace_id));

-- Postgres grants EXECUTE to PUBLIC on every new function; revoke from PUBLIC
-- (not just anon) or the revoke is a no-op. See the hardening migration.
revoke execute on function public.validate_script_blocks(jsonb, text) from public, anon;
grant  execute on function public.validate_script_blocks(jsonb, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Set one script as the workspace default.
--
-- An RPC because the partial unique index means "clear the old default, set the
-- new one" must happen in one statement or it transiently violates.
-- ---------------------------------------------------------------------------
create or replace function public.set_default_script(ws uuid, script uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a member of workspace %', ws using errcode = '42501';
  end if;

  update public.call_scripts
     set is_default = (id = script)
   where workspace_id = ws
     and (is_default or id = script);
end;
$$;

revoke execute on function public.set_default_script(uuid, uuid) from public, anon;
grant  execute on function public.set_default_script(uuid, uuid) to authenticated, service_role;
