-- SECURITY DEFINER functions must never rely on PostgreSQL's default PUBLIC
-- EXECUTE privilege. The record wrappers are member-only entry points.
revoke all on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb) from public;
revoke all on function update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb) from public;
revoke all on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) from public;
grant execute on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) to authenticated, service_role;

create or replace function delete_entity_type_if_safe_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns table (
  deleted boolean,
  record_count integer,
  relation_field_count integer,
  workflow_target_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select * from delete_entity_type_if_safe(p_workspace_id, p_entity_type_id);
end;
$$;

create or replace function delete_field_definition_if_safe_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns table (
  deleted boolean,
  record_value_count bigint,
  relation_value_count bigint,
  workflow_reference_count bigint,
  display_field_reference_count bigint,
  view_reference_count bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select * from delete_field_definition_if_safe(
    p_workspace_id,
    p_entity_type_id,
    p_field_definition_id
  );
end;
$$;

revoke all on function delete_entity_type_if_safe(uuid, uuid) from public, authenticated;
revoke all on function delete_field_definition_if_safe(uuid, uuid, uuid) from public, authenticated;
grant execute on function delete_entity_type_if_safe(uuid, uuid) to service_role;
grant execute on function delete_field_definition_if_safe(uuid, uuid, uuid) to service_role;

revoke all on function delete_entity_type_if_safe_authorized(uuid, uuid) from public;
revoke all on function delete_field_definition_if_safe_authorized(uuid, uuid, uuid) from public;
grant execute on function delete_entity_type_if_safe_authorized(uuid, uuid) to authenticated, service_role;
grant execute on function delete_field_definition_if_safe_authorized(uuid, uuid, uuid) to authenticated, service_role;

revoke delete on table entity_types from authenticated;
revoke delete on table field_definitions from authenticated;

comment on function delete_entity_type_if_safe_authorized(uuid, uuid)
  is 'Membership-checked security-definer wrapper for safe entity deletion.';
comment on function delete_field_definition_if_safe_authorized(uuid, uuid, uuid)
  is 'Membership-checked security-definer wrapper for safe field deletion.';
