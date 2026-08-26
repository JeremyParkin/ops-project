-- Corrective migration for the assignment RPC defined before 0049's final-state guard.

create or replace function set_workspace_member_role_authorized(p_workspace_id uuid, p_user_id uuid, p_role_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  if not exists (select 1 from workspace_roles where workspace_id = p_workspace_id and id = p_role_id) then raise exception 'Role not found'; end if;
  if p_user_id = auth.uid() and exists (
    select 1 from workspace_role_capabilities proposed where proposed.workspace_id = p_workspace_id and proposed.role_id = p_role_id
      and not exists (select 1 from workspace_memberships membership join workspace_role_capabilities current on current.workspace_id = membership.workspace_id and current.role_id = membership.role_id where membership.workspace_id = p_workspace_id and membership.user_id = auth.uid() and current.capability = proposed.capability)
  ) then raise exception 'You cannot grant yourself additional capabilities'; end if;
  update workspace_memberships set role_id = p_role_id where workspace_id = p_workspace_id and user_id = p_user_id;
  if not found then raise exception 'Workspace member not found'; end if;
  perform private.assert_workspace_administrator(p_workspace_id);
end; $$;

revoke all on function set_workspace_member_role_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function set_workspace_member_role_authorized(uuid, uuid, uuid) to authenticated, service_role;
