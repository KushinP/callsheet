-- ============================================================================
-- record_stage_event is SECURITY DEFINER so it can write lead_stage_events,
-- which nobody else may write. It is a trigger function and nothing should call
-- it directly, but 20260908000032 left it executable by anon and authenticated
-- over /rest/v1/rpc — flagged by the security advisor. A trigger firing does
-- not need the caller to hold EXECUTE, so revoking it changes nothing that
-- should happen and closes the path that should not.
-- ============================================================================
revoke execute on function public.record_stage_event() from public, anon, authenticated;
