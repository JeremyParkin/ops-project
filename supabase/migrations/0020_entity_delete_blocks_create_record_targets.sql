-- Migration 0019 dropped action_target_entity_type_id (and its composite FK),
-- which used to structurally prevent hard-deleting an entity still targeted
-- by a create_record workflow action. That invariant now needs an explicit
-- application-level check inside delete_entity_type_if_safe, scanning
-- workflows.actions[] the same way delete_field_definition_if_safe already
-- scans it for field references. This does not restore cascade behavior —
-- deletion is blocked, dependent workflows are left untouched.
--
-- The return shape gains a column, which CREATE OR REPLACE cannot do for a
-- function with an OUT/TABLE signature, so this drops and recreates it.
drop function delete_entity_type_if_safe(uuid, uuid);

create function delete_entity_type_if_safe(
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
set search_path = public
as $$
declare
  v_record_count integer := 0;
  v_relation_field_count integer := 0;
  v_workflow_target_count integer := 0;
begin
  if not exists (
    select 1
    from entity_types
    where workspace_id = p_workspace_id
      and id = p_entity_type_id
  ) then
    raise exception 'Entity type not found';
  end if;

  select count(*)
    into v_record_count
  from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id;

  select count(*)
    into v_relation_field_count
  from field_definitions
  where workspace_id = p_workspace_id
    and related_entity_type_id = p_entity_type_id;

  select count(*)
    into v_workflow_target_count
  from workflows workflow
  where workflow.workspace_id = p_workspace_id
    and exists (
      select 1
      from jsonb_array_elements(workflow.actions) action
      where action ->> 'actionType' = 'create_record'
        and action ->> 'actionTargetEntityTypeId' = p_entity_type_id::text
    );

  if v_record_count > 0
    or v_relation_field_count > 0
    or v_workflow_target_count > 0 then
    return query select false, v_record_count, v_relation_field_count, v_workflow_target_count;
    return;
  end if;

  delete from entity_types
  where workspace_id = p_workspace_id
    and id = p_entity_type_id;

  return query select true, 0, 0, 0;
end;
$$;

comment on function delete_entity_type_if_safe(uuid, uuid)
  is 'Safely hard-deletes an entity type. Blocks deletion when the entity has records, when another field declares a relation to it, or when any workflow action creates records in it (actions[].actionType = create_record with a matching actionTargetEntityTypeId). Never modifies or deletes the dependent workflow.';
