-- Correct the explicit result type of the capability-gated Members read model.

create or replace function list_workspace_members_with_roles_authorized(p_workspace_id uuid)
returns table (user_id uuid, email text, role_id uuid, role_name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if not private.has_workspace_capability(p_workspace_id, 'workspace.manage_members') then raise exception 'Permission denied: workspace.manage_members'; end if;

  return query
  select membership.user_id, users.email::text, membership.role_id, role.name
  from public.workspace_memberships membership
  join auth.users users on users.id = membership.user_id
  join public.workspace_roles role
    on role.workspace_id = membership.workspace_id and role.id = membership.role_id
  where membership.workspace_id = p_workspace_id
  order by users.email, membership.user_id;
end;
$$;

revoke all on function list_workspace_members_with_roles_authorized(uuid) from public, anon;
grant execute on function list_workspace_members_with_roles_authorized(uuid) to authenticated, service_role;
