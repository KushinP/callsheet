-- ============================================================================
-- create or replace with a different argument list ADDS an overload; it does
-- not replace the old one.
--
-- So the 3-argument playbook_step_due survived beside the 4-argument one added
-- for the callback anchor, every 3-argument call became ambiguous, and Postgres
-- refused them with 42725 "is not unique". reanchor_scheduled_tasks makes
-- exactly that call, and it is an AFTER trigger, so the error rolled back the
-- whole update: setting, moving or clearing a demo date failed from the moment
-- 20260909000037 applied.
--
-- The 4-argument form's default covers every 3-argument call once its twin is
-- gone. The 4-argument spawn_playbook_tasks is dead for the same reason and
-- goes too, before something calls it and inherits the same ambiguity.
-- ============================================================================
drop function if exists public.playbook_step_due(jsonb, text, timestamptz);
drop function if exists public.spawn_playbook_tasks(uuid, uuid, timestamptz, uuid);
