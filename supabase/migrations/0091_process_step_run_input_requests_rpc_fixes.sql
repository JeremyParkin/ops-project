-- Corrective migration for 0090 (Phase 10.5), found at the DB/RPC
-- verification gate after 0090 was applied.
--
-- list_process_step_run_input_request_recipient_candidates_authorized is 67
-- bytes, over PostgreSQL's 63-byte (NAMEDATALEN-1) identifier limit.
-- CREATE FUNCTION silently truncated it rather than erroring, so the
-- function that actually exists live does not match the name the app
-- layer calls -- PostgREST's schema cache correctly reports it as not
-- found. Renamed to a functionally-identical, shorter name
-- (..._recipients_authorized instead of ..._recipient_candidates_authorized,
-- 57 bytes) rather than shortening any other segment, to keep the
-- process_step_run/input_request naming consistent with this table's other
-- four RPCs.
--
-- The drop target below intentionally uses the original, too-long name --
-- PostgreSQL applies the identical truncation when parsing it here, so it
-- resolves to the same (already-truncated) object 0090 actually created.
drop function if exists list_process_step_run_input_request_recipient_candidates_authorized(uuid);

create function list_process_step_run_input_request_recipients_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  return query
  select membership.user_id, users.email::text
  from workspace_memberships membership
  join auth.users users on users.id = membership.user_id
  where membership.workspace_id = p_workspace_id
    and membership.deactivated_at is null
    and private.has_workspace_capability_as(p_workspace_id, 'processes.operate', membership.user_id)
  order by users.email, membership.user_id;
end;
$$;

revoke all on function list_process_step_run_input_request_recipients_authorized(uuid) from public, anon;
grant execute on function list_process_step_run_input_request_recipients_authorized(uuid) to authenticated, service_role;

comment on function list_process_step_run_input_request_recipients_authorized(uuid)
  is 'Active processes.operate workspace members eligible to receive a Process Step Run input request. Renamed from the original 0090 name, which exceeded PostgreSQL''s 63-byte identifier limit and was silently truncated.';
