-- Capability-aware mutation policies; membership-based reads remain unchanged.

drop policy entity_types_member_access on entity_types;
drop policy field_definitions_member_access on field_definitions;
drop policy entity_records_member_access on entity_records;
drop policy entity_record_relation_values_member_access on entity_record_relation_values;
drop policy entity_views_member_access on entity_views;
drop policy workflows_member_access on workflows;

create policy entity_types_member_read on entity_types for select to authenticated using ((select private.is_workspace_member(workspace_id)));
create policy entity_types_schema_write on entity_types for all to authenticated using ((select private.has_workspace_capability(workspace_id, 'schema.manage'))) with check ((select private.has_workspace_capability(workspace_id, 'schema.manage')));
create policy field_definitions_member_read on field_definitions for select to authenticated using ((select private.is_workspace_member(workspace_id)));
create policy field_definitions_schema_write on field_definitions for all to authenticated using ((select private.has_workspace_capability(workspace_id, 'schema.manage'))) with check ((select private.has_workspace_capability(workspace_id, 'schema.manage')));
create policy entity_records_member_read on entity_records for select to authenticated using ((select private.is_workspace_member(workspace_id)));
create policy entity_records_operate_write on entity_records for all to authenticated using ((select private.has_workspace_capability(workspace_id, 'records.operate'))) with check ((select private.has_workspace_capability(workspace_id, 'records.operate')));
create policy relation_values_member_read on entity_record_relation_values for select to authenticated using ((select private.is_workspace_member(workspace_id)));
create policy relation_values_operate_write on entity_record_relation_values for all to authenticated using ((select private.has_workspace_capability(workspace_id, 'records.operate'))) with check ((select private.has_workspace_capability(workspace_id, 'records.operate')));
create policy entity_views_member_read on entity_views for select to authenticated using ((select private.is_workspace_member(workspace_id)));
create policy entity_views_operate_write on entity_views for all to authenticated using ((select private.has_workspace_capability(workspace_id, 'records.operate'))) with check ((select private.has_workspace_capability(workspace_id, 'records.operate')));
create policy workflows_member_read on workflows for select to authenticated using ((select private.is_workspace_member(workspace_id)));
create policy workflows_automation_write on workflows for all to authenticated using ((select private.has_workspace_capability(workspace_id, 'automation.manage'))) with check ((select private.has_workspace_capability(workspace_id, 'automation.manage')));

create or replace function delete_entity_type_if_safe_authorized(p_workspace_id uuid, p_entity_type_id uuid)
returns table (deleted boolean, record_count integer, relation_field_count integer, workflow_target_count integer, process_template_count integer)
language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  return query select * from delete_entity_type_if_safe(p_workspace_id, p_entity_type_id);
end; $$;

create or replace function delete_field_definition_if_safe_authorized(p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid)
returns table (deleted boolean, record_value_count bigint, relation_value_count bigint, workflow_reference_count bigint, display_field_reference_count bigint, view_reference_count bigint, process_branch_reference_count bigint)
language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  return query select * from delete_field_definition_if_safe(p_workspace_id, p_entity_type_id, p_field_definition_id);
end; $$;

revoke all on function delete_entity_type_if_safe_authorized(uuid, uuid), delete_field_definition_if_safe_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function delete_entity_type_if_safe_authorized(uuid, uuid), delete_field_definition_if_safe_authorized(uuid, uuid, uuid) to authenticated, service_role;
