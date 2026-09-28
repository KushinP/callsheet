-- ============================================================================
-- Schema behaviour test.
--
-- Walks one workspace through signup, CSV import, session building, dialing,
-- and disposition, asserting the triggers and RPCs behave. Cleans up after
-- itself.
--
-- Requires the service role (it inserts into auth.users).
-- ============================================================================

create or replace function public.__schema_test()
returns table (step text, result text)
language plpgsql
as $$
declare
  uid uuid := gen_random_uuid();
  ws uuid;
  sess uuid;
  r jsonb;
  dnc_blocked boolean := false;
  test_lead uuid;
  n int;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'smoketest@example.com', crypt('x', gen_salt('bf')), now(),
          '{"provider":"email"}'::jsonb,
          '{"full_name":"Smoke Test","workspace_name":"Smoke Workspace"}'::jsonb,
          now(), now());

  select w.id into ws from public.workspaces w where w.created_by = uid;

  step := 'A. signup auto-creates workspace';
  result := case when ws is not null then 'PASS' else 'FAIL' end; return next;

  step := 'B. signup grants owner membership';
  result := case when (select count(*) from public.workspace_members m
                       where m.workspace_id = ws and m.user_id = uid and m.role = 'owner') = 1
                 then 'PASS' else 'FAIL' end; return next;

  step := 'C. signup creates profile + twilio settings row';
  result := case when (select count(*) from public.profiles where id = uid) = 1
                  and (select count(*) from public.workspace_twilio_settings
                       where workspace_id = ws) = 1
                 then 'PASS' else 'FAIL' end; return next;

  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- Five rows: one duplicate in a different format, one with no usable phone.
  select public.import_leads(ws, '[
    {"business_name":"Ace Plumbing","phone":"(555) 010-0001","city":"Austin","state":"TX"},
    {"business_name":"Ace Plumbing LLC","phone":"+1 555-010-0001","city":"Austin","state":"TX"},
    {"business_name":"Bright Electric","phone":"5550100002","city":"Austin","state":"TX"},
    {"business_name":"Cool HVAC","phone":"15550100003","city":"Dallas","state":"TX"},
    {"business_name":"No Phone Co","phone":"abc"}
  ]'::jsonb) into r;

  step := 'D. import: 5 rows -> 3 leads (dup collapsed, bad phone skipped)';
  result := case when (r->>'inserted')::int = 3 and (r->>'skipped')::int = 2
                 then 'PASS ' || r::text else 'FAIL ' || r::text end; return next;

  select public.import_leads(ws,
    '[{"business_name":"Ace Plumbing","phone":"555-010-0001","city":"Austin"}]'::jsonb) into r;

  step := 'E. re-import is idempotent (0 new)';
  result := case when (r->>'inserted')::int = 0 and (r->>'updated')::int = 1
                 then 'PASS ' || r::text else 'FAIL ' || r::text end; return next;

  select public.build_session(ws, 'Austin sweep', '{"city":"Austin"}'::jsonb, 100) into sess;
  select total_leads into n from public.calling_sessions where id = sess;

  step := 'F. build_session honours the city filter';
  result := case when n = 2 then 'PASS (2 queued)' else 'FAIL (' || n || ' queued)' end; return next;

  select id into test_lead from public.leads
    where workspace_id = ws and city = 'Austin' order by business_name limit 1;
  update public.leads set do_not_call = true where id = test_lead;

  begin
    insert into public.dial_call_logs (workspace_id, lead_id, phone, phone_normalized)
    values (ws, test_lead, '5550100001', '5550100001');
  exception when check_violation then
    dnc_blocked := true;
  end;
  step := 'G. do_not_call lead is blocked at the database';
  result := case when dnc_blocked then 'PASS' else 'FAIL (insert succeeded)' end; return next;

  select public.build_session(ws, 'Post-DNC', '{"city":"Austin"}'::jsonb, 100) into sess;
  select total_leads into n from public.calling_sessions where id = sess;
  step := 'H. do_not_call lead excluded from new queues';
  result := case when n = 1 then 'PASS (1 queued)' else 'FAIL (' || n || ' queued)' end; return next;

  select id into test_lead from public.leads
    where workspace_id = ws and not do_not_call and city = 'Austin' limit 1;
  insert into public.dial_call_logs (workspace_id, lead_id, phone, phone_normalized, outcome)
  values (ws, test_lead, '5550100002', '5550100002', 'connected_dm');
  step := 'I. placing a call touches the lead';
  result := case when (select call_count = 1 and status = 'in_progress'
                       from public.leads where id = test_lead)
                 then 'PASS' else 'FAIL' end; return next;

  select id into test_lead from public.leads where workspace_id = ws and city = 'Dallas' limit 1;
  insert into public.dial_call_logs (workspace_id, lead_id, phone, phone_normalized, outcome)
  values (ws, test_lead, '5550100003', '5550100003', 'do_not_call');
  step := 'J. logging a do_not_call outcome raises the standing flag';
  result := case when (select do_not_call and status = 'disqualified'
                       from public.leads where id = test_lead)
                 then 'PASS' else 'FAIL' end; return next;

  step := 'K. dashboard stats aggregate in Postgres';
  result := public.workspace_call_stats(ws, 'America/Chicago')::text; return next;

  delete from auth.users where id = uid;
  delete from public.workspaces where not exists (
    select 1 from public.workspace_members m where m.workspace_id = workspaces.id);
end $$;

select * from public.__schema_test();

drop function public.__schema_test();
