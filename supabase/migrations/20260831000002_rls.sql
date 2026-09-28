-- ============================================================================
-- Row Level Security
--
-- Enabled on every table. Workspace-scoped tables gate on is_workspace_member,
-- which is what actually keeps two tenants apart — not a filtered query in the
-- client.
-- ============================================================================

alter table public.profiles                  enable row level security;
alter table public.workspaces                enable row level security;
alter table public.workspace_members         enable row level security;
alter table public.leads                     enable row level security;
alter table public.calling_sessions          enable row level security;
alter table public.session_leads             enable row level security;
alter table public.dial_call_logs            enable row level security;
alter table public.call_transcripts          enable row level security;
alter table public.saved_filters             enable row level security;
alter table public.workspace_twilio_settings enable row level security;
alter table public.workspace_twilio_secrets  enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create or replace function public.shares_workspace_with(other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid() and theirs.user_id = other_user
  );
$$;

create policy "profiles readable by self and workspace peers"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_workspace_with(id));

create policy "profiles updatable by self"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------------
create policy "workspaces readable by members"
  on public.workspaces for select to authenticated
  using (public.is_workspace_member(id));

create policy "workspaces creatable by authenticated users"
  on public.workspaces for insert to authenticated
  with check (created_by = auth.uid());

create policy "workspaces updatable by admins"
  on public.workspaces for update to authenticated
  using (public.is_workspace_admin(id)) with check (public.is_workspace_admin(id));

-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------
create policy "members readable by workspace members"
  on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members writable by workspace admins"
  on public.workspace_members for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));

create policy "members updatable by workspace admins"
  on public.workspace_members for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy "members removable by workspace admins"
  on public.workspace_members for delete to authenticated
  using (public.is_workspace_admin(workspace_id));

-- ---------------------------------------------------------------------------
-- Workspace-scoped operational tables: full CRUD for any member.
-- ---------------------------------------------------------------------------
create policy "leads readable by members" on public.leads
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "leads insertable by members" on public.leads
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "leads updatable by members" on public.leads
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy "leads deletable by members" on public.leads
  for delete to authenticated using (public.is_workspace_member(workspace_id));

create policy "sessions readable by members" on public.calling_sessions
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "sessions insertable by members" on public.calling_sessions
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "sessions updatable by members" on public.calling_sessions
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy "sessions deletable by members" on public.calling_sessions
  for delete to authenticated using (public.is_workspace_member(workspace_id));

create policy "session leads readable by members" on public.session_leads
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "session leads insertable by members" on public.session_leads
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "session leads updatable by members" on public.session_leads
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy "session leads deletable by members" on public.session_leads
  for delete to authenticated using (public.is_workspace_member(workspace_id));

create policy "call logs readable by members" on public.dial_call_logs
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "call logs insertable by members" on public.dial_call_logs
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "call logs updatable by members" on public.dial_call_logs
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "transcripts readable by members" on public.call_transcripts
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "transcripts insertable by members" on public.call_transcripts
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "transcripts updatable by members" on public.call_transcripts
  for update to authenticated using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- saved_filters — a member's own presets only
-- ---------------------------------------------------------------------------
create policy "saved filters owned by user" on public.saved_filters
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Twilio config
-- ---------------------------------------------------------------------------
create policy "twilio settings readable by members" on public.workspace_twilio_settings
  for select to authenticated using (public.is_workspace_member(workspace_id));

-- Writes go through the twilio-provision edge function (service role), which
-- validates the credentials against Twilio before anything is stored.
create policy "twilio settings updatable by admins" on public.workspace_twilio_settings
  for update to authenticated using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- workspace_twilio_secrets intentionally has NO policies. RLS is on, so with
-- zero policies every client role is denied and only the service role (which
-- bypasses RLS) can read the auth token or API key secret.
revoke all on public.workspace_twilio_secrets from anon, authenticated;
