-- Corrective replacement for 0045's row-level lockout guards. Each role
-- mutation serializes one workspace and validates the committed final state.

drop trigger if exists workspace_memberships_last_admin_guard on workspace_memberships;
drop trigger if exists workspace_role_capabilities_last_admin_guard on workspace_role_capabilities;

create or replace function private.assert_workspace_administrator(p_workspace_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin
  if not exists (
    select 1 from workspace_memberships membership
    where membership.workspace_id = p_workspace_id
      and exists (select 1 from workspace_role_capabilities c where c.workspace_id = p_workspace_id and c.role_id = membership.role_id and c.capability = 'workspace.manage_members')
      and exists (select 1 from workspace_role_capabilities c where c.workspace_id = p_workspace_id and c.role_id = membership.role_id and c.capability = 'workspace.manage_roles')
  ) then raise exception 'A workspace must retain a member able to manage members and roles'; end if;
end; $$;

create or replace function update_workspace_role_authorized(p_workspace_id uuid, p_role_id uuid, p_name text, p_description text, p_capabilities jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_capability text; v_caller_role uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  select role_id into v_caller_role from workspace_memberships where workspace_id = p_workspace_id and user_id = auth.uid() for update;
  if v_caller_role = p_role_id then raise exception 'You cannot edit the capabilities of your own role'; end if;
  if not exists (select 1 from workspace_roles where workspace_id = p_workspace_id and id = p_role_id) then raise exception 'Role not found'; end if;
  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then raise exception 'Role name and capabilities are required'; end if;
  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in ('workspace.manage_members','workspace.manage_roles','workspace.manage_settings','schema.manage','automation.manage','records.operate','processes.operate','operations.view') then raise exception 'Invalid capability'; end if;
  end loop;
  update workspace_roles set name = trim(p_name), description = nullif(trim(p_description), ''), updated_at = now() where workspace_id = p_workspace_id and id = p_role_id;
  delete from workspace_role_capabilities where workspace_id = p_workspace_id and role_id = p_role_id;
  insert into workspace_role_capabilities (workspace_id, role_id, capability) select p_workspace_id, p_role_id, value from jsonb_array_elements_text(p_capabilities) value;
  perform private.assert_workspace_administrator(p_workspace_id);
end; $$;

create or replace function delete_workspace_role_with_reassignment_authorized(p_workspace_id uuid, p_role_id uuid, p_replacement_role_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  if p_role_id = p_replacement_role_id then raise exception 'Choose a different replacement role'; end if;
  if not exists (select 1 from workspace_roles where workspace_id = p_workspace_id and id = p_role_id) or not exists (select 1 from workspace_roles where workspace_id = p_workspace_id and id = p_replacement_role_id) then raise exception 'Role not found'; end if;
  if exists (select 1 from workspace_memberships where workspace_id = p_workspace_id and user_id = auth.uid() and role_id = p_role_id) then raise exception 'You cannot delete your own assigned role'; end if;
  update workspace_memberships set role_id = p_replacement_role_id where workspace_id = p_workspace_id and role_id = p_role_id;
  delete from workspace_roles where workspace_id = p_workspace_id and id = p_role_id;
  perform private.assert_workspace_administrator(p_workspace_id);
end; $$;

revoke all on function private.assert_workspace_administrator(uuid), update_workspace_role_authorized(uuid, uuid, text, text, jsonb), delete_workspace_role_with_reassignment_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function update_workspace_role_authorized(uuid, uuid, text, text, jsonb), delete_workspace_role_with_reassignment_authorized(uuid, uuid, uuid) to authenticated, service_role;
