-- Corrective migration for environments where 0045 has already created roles.
-- Reads remain membership-wide; these wrappers gate interactive mutation paths.

create or replace function private.require_interactive_workspace_capability(
  p_workspace_id uuid,
  p_capability text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' then return; end if;
  perform private.require_workspace_capability(p_workspace_id, p_capability);
end;
$$;

create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return create_entity_record_with_relations(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    p_originating_process_step_run_id
  );
end;
$$;

drop function update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb);

create function update_entity_record_with_relations_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid, p_values jsonb,
  p_relation_field_ids jsonb, p_relations jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return update_entity_record_with_relations(p_workspace_id, p_entity_type_id, p_record_id, p_values, p_relation_field_ids, p_relations);
end;
$$;

create or replace function delete_entity_record_if_unreferenced_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid
)
returns table (deleted boolean, reference_count integer, process_run_count integer)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return query select * from delete_entity_record_if_unreferenced(p_workspace_id, p_entity_type_id, p_record_id);
end;
$$;

create or replace function set_workspace_member_role_authorized(
  p_workspace_id uuid, p_user_id uuid, p_role_id uuid
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  if not exists (select 1 from workspace_roles where workspace_id = p_workspace_id and id = p_role_id) then
    raise exception 'Role not found';
  end if;
  if p_user_id = auth.uid() and exists (
    select 1 from workspace_role_capabilities proposed
    where proposed.workspace_id = p_workspace_id and proposed.role_id = p_role_id
      and not exists (
        select 1 from workspace_memberships membership join workspace_role_capabilities current
          on current.workspace_id = membership.workspace_id and current.role_id = membership.role_id
        where membership.workspace_id = p_workspace_id and membership.user_id = auth.uid()
          and current.capability = proposed.capability
      )
  ) then raise exception 'You cannot grant yourself additional capabilities'; end if;
  update workspace_memberships set role_id = p_role_id
  where workspace_id = p_workspace_id and user_id = p_user_id;
  if not found then raise exception 'Workspace member not found'; end if;
  perform private.assert_workspace_administrator(p_workspace_id);
end;
$$;

create or replace function create_workspace_role_authorized(
  p_workspace_id uuid, p_name text, p_description text, p_capabilities jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role_id uuid := gen_random_uuid(); v_capability text;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then raise exception 'Role name and capabilities are required'; end if;
  insert into workspace_roles (id, workspace_id, name, description) values (v_role_id, p_workspace_id, trim(p_name), nullif(trim(p_description), ''));
  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in ('workspace.manage_members','workspace.manage_roles','workspace.manage_settings','schema.manage','automation.manage','records.operate','processes.operate','operations.view') then raise exception 'Invalid capability'; end if;
    insert into workspace_role_capabilities (workspace_id, role_id, capability) values (p_workspace_id, v_role_id, v_capability);
  end loop;
  return v_role_id;
end;
$$;

revoke all on function private.require_interactive_workspace_capability(uuid, text) from public, anon, authenticated;
revoke all on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, uuid) from public, anon;
revoke all on function update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb) from public, anon;
revoke all on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
grant execute on function update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function set_workspace_member_role_authorized(uuid, uuid, uuid), create_workspace_role_authorized(uuid, text, text, jsonb) from public, anon;
grant execute on function set_workspace_member_role_authorized(uuid, uuid, uuid), create_workspace_role_authorized(uuid, text, text, jsonb) to authenticated, service_role;
