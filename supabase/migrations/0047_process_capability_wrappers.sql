-- Capability gates for interactive Process operations. The renamed functions
-- retain the canonical graph implementation; service_role remains trusted for
-- schedulers and deterministic system-owned automation.

alter function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) rename to save_process_template_authorized_member;
alter function archive_process_template_authorized(uuid, uuid) rename to archive_process_template_authorized_member;
alter function restore_process_template_authorized(uuid, uuid) rename to restore_process_template_authorized_member;
alter function start_process_run_authorized(uuid, uuid, uuid, uuid, uuid) rename to start_process_run_authorized_member;
alter function complete_process_step_run_authorized(uuid, uuid, uuid) rename to complete_process_step_run_authorized_member;
alter function decide_process_approval_authorized(uuid, uuid, uuid, uuid) rename to decide_process_approval_authorized_member;
alter function complete_process_action_step_authorized(uuid, uuid, uuid, jsonb) rename to complete_process_action_step_authorized_member;
alter function fail_process_action_step_authorized(uuid, uuid, uuid, jsonb) rename to fail_process_action_step_authorized_member;

create function save_process_template_authorized(p_workspace_id uuid, p_process_template_id uuid, p_name text, p_description text, p_applies_to_entity_type_id uuid, p_steps jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');
  return save_process_template_authorized_member(p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, p_steps);
end; $$;

create function archive_process_template_authorized(p_workspace_id uuid, p_process_template_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');
  perform archive_process_template_authorized_member(p_workspace_id, p_process_template_id);
end; $$;

create function restore_process_template_authorized(p_workspace_id uuid, p_process_template_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');
  perform restore_process_template_authorized_member(p_workspace_id, p_process_template_id);
end; $$;

create function start_process_run_authorized(p_workspace_id uuid, p_process_template_id uuid, p_origin_entity_type_id uuid, p_origin_record_id uuid, p_originating_process_step_run_id uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return start_process_run_authorized_member(p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id, p_originating_process_step_run_id);
end; $$;

create function complete_process_step_run_authorized(p_workspace_id uuid, p_process_run_id uuid, p_step_run_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  perform complete_process_step_run_authorized_member(p_workspace_id, p_process_run_id, p_step_run_id);
end; $$;

create function decide_process_approval_authorized(p_workspace_id uuid, p_process_run_id uuid, p_step_run_id uuid, p_outcome_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  perform decide_process_approval_authorized_member(p_workspace_id, p_process_run_id, p_step_run_id, p_outcome_id);
end; $$;

create function complete_process_action_step_authorized(p_workspace_id uuid, p_process_run_id uuid, p_step_run_id uuid, p_action_result jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return complete_process_action_step_authorized_member(p_workspace_id, p_process_run_id, p_step_run_id, p_action_result);
end; $$;

create function fail_process_action_step_authorized(p_workspace_id uuid, p_process_run_id uuid, p_step_run_id uuid, p_action_result jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return fail_process_action_step_authorized_member(p_workspace_id, p_process_run_id, p_step_run_id, p_action_result);
end; $$;

revoke all on function save_process_template_authorized_member(uuid, uuid, text, text, uuid, jsonb), archive_process_template_authorized_member(uuid, uuid), restore_process_template_authorized_member(uuid, uuid), start_process_run_authorized_member(uuid, uuid, uuid, uuid, uuid), complete_process_step_run_authorized_member(uuid, uuid, uuid), decide_process_approval_authorized_member(uuid, uuid, uuid, uuid), complete_process_action_step_authorized_member(uuid, uuid, uuid, jsonb), fail_process_action_step_authorized_member(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb), archive_process_template_authorized(uuid, uuid), restore_process_template_authorized(uuid, uuid), start_process_run_authorized(uuid, uuid, uuid, uuid, uuid), complete_process_step_run_authorized(uuid, uuid, uuid), decide_process_approval_authorized(uuid, uuid, uuid, uuid), complete_process_action_step_authorized(uuid, uuid, uuid, jsonb), fail_process_action_step_authorized(uuid, uuid, uuid, jsonb) to authenticated, service_role;
