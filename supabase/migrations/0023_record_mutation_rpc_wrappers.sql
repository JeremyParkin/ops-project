-- The original record RPCs are SECURITY INVOKER functions. Give normal users
-- membership-checked SECURITY DEFINER entry points so raw record and relation
-- mutations can be revoked without breaking the canonical record operations.
create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return create_entity_record_with_relations(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations
  );
end;
$$;

create or replace function update_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return update_entity_record_with_relations(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations
  );
end;
$$;

create or replace function delete_entity_record_if_unreferenced_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns table (deleted boolean, reference_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select * from delete_entity_record_if_unreferenced(
    p_workspace_id,
    p_entity_type_id,
    p_record_id
  );
end;
$$;

revoke all on function create_entity_record_with_relations(uuid, uuid, jsonb, jsonb) from authenticated;
revoke all on function update_entity_record_with_relations(uuid, uuid, uuid, jsonb, jsonb, jsonb) from authenticated;
revoke all on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) from authenticated;

grant execute on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) to authenticated, service_role;

-- Restore the invoker privileges still required by the existing entity/field
-- RPCs. Their raw paths remain an intentional v1 app-layer-validation caveat.
grant insert, delete on table entity_types to authenticated;
grant insert, update, delete on table field_definitions to authenticated;

revoke insert, update, delete on table entity_records from authenticated;
grant update (archived_at, updated_at) on table entity_records to authenticated;
revoke insert, update, delete on table entity_record_relation_values from authenticated;

comment on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb)
  is 'Membership-checked security-definer wrapper for canonical record creation.';
comment on function update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb)
  is 'Membership-checked security-definer wrapper for canonical record updates.';
