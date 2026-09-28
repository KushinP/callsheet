-- ============================================================================
-- Row Level Security isolation test.
--
-- Creates two unrelated users, seeds a lead and a call into each of their
-- workspaces, then becomes one of them and confirms the database refuses to
-- show or touch the other's data. Cleans up after itself.
--
-- Requires the service role (it inserts into auth.users).
-- ============================================================================

create or replace function public.__rls_test()
returns table (step text, result text)
language plpgsql
as $$
declare
  alice uuid := gen_random_uuid();
  bob uuid := gen_random_uuid();
  ws_a uuid; ws_b uuid;
  n int;
  leaked boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values
    (alice, '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
     'alice@example.com', crypt('x', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb,
     '{"workspace_name":"Alice Agency"}'::jsonb, now(), now()),
    (bob, '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
     'bob@example.com', crypt('x', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb,
     '{"workspace_name":"Bob Agency"}'::jsonb, now(), now());

  select id into ws_a from public.workspaces where created_by = alice;
  select id into ws_b from public.workspaces where created_by = bob;

  insert into public.leads (workspace_id, business_name, phone, phone_normalized)
  values (ws_a, 'Alice Roofing', '5551110001', '5551110001'),
         (ws_b, 'Bob Roofing',   '5552220001', '5552220001');
  insert into public.dial_call_logs (workspace_id, phone, phone_normalized, business_name)
  values (ws_a, '5551110001', '5551110001', 'Alice Roofing'),
         (ws_b, '5552220001', '5552220001', 'Bob Roofing');
  insert into public.workspace_twilio_secrets (workspace_id, auth_token)
  values (ws_a, 'alice-super-secret-token');

  -- Become Alice, under the `authenticated` role so RLS actually applies.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice, 'role','authenticated')::text, true);

  select count(*) into n from public.leads;
  step := '1. Alice sees only her own leads';
  result := case when n = 1 and (select business_name from public.leads) = 'Alice Roofing'
                 then 'PASS (1 of 2 visible)' else 'FAIL (' || n || ' visible)' end; return next;

  select count(*) into n from public.dial_call_logs;
  step := '2. Alice sees only her own call logs';
  result := case when n = 1 then 'PASS (1 of 2 visible)' else 'FAIL (' || n || ' visible)' end; return next;

  select count(*) into n from public.workspaces;
  step := '3. Alice sees only her own workspace';
  result := case when n = 1 then 'PASS' else 'FAIL (' || n || ' visible)' end; return next;

  -- The whole point of splitting secrets into their own policy-free table.
  begin
    select count(*) into n from public.workspace_twilio_secrets;
    leaked := n > 0;
  exception when insufficient_privilege then
    leaked := false; n := -1;
  end;
  step := '4. Twilio auth token is unreadable by any client role';
  result := case when not leaked then 'PASS (0 rows / denied)' else 'FAIL (leaked ' || n || ')' end; return next;

  begin
    insert into public.leads (workspace_id, business_name, phone, phone_normalized)
    values (ws_b, 'Injected', '5559990000', '5559990000');
    step := '5. Alice cannot insert into Bob''s workspace'; result := 'FAIL (insert allowed)';
  exception when insufficient_privilege then
    step := '5. Alice cannot insert into Bob''s workspace'; result := 'PASS (denied)';
  end;
  return next;

  update public.leads set business_name = 'Hijacked' where workspace_id = ws_b;
  get diagnostics n = row_count;
  step := '6. Alice cannot update Bob''s leads';
  result := case when n = 0 then 'PASS (0 rows matched)' else 'FAIL (' || n || ' updated)' end; return next;

  -- The RPCs gate on membership too, not just the tables underneath them.
  begin
    perform public.build_session(ws_b, 'Steal Bob''s list', '{}'::jsonb, 10);
    step := '7. Alice cannot build a session in Bob''s workspace'; result := 'FAIL (allowed)';
  exception when insufficient_privilege then
    step := '7. Alice cannot build a session in Bob''s workspace'; result := 'PASS (denied)';
  end;
  return next;

  reset role;
  delete from auth.users where id in (alice, bob);
  -- workspaces.created_by is ON DELETE SET NULL by design, so a deleted user
  -- does not take the team's call history with them. Clear the orphans here.
  delete from public.workspaces where not exists (
    select 1 from public.workspace_members m where m.workspace_id = workspaces.id);
end $$;

select * from public.__rls_test();

drop function public.__rls_test();
