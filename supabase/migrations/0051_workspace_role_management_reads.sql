-- Narrow read model for Members / Roles. Raw membership RLS remains self-only.

create or replace function list_workspace_members_with_roles_authorized(p_workspace_id uuid)
returns table (user_id uuid, email text, role_id uuid, role_name text)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if not private.has_workspace_capability(p_workspace_id, 'workspace.manage_members') then raise exception 'Permission denied: workspace.manage_members'; end if;
  return query
  select membership.user_id, users.email::text, membership.role_id, role.name
  from public.workspace_memberships membership
  join auth.users users on users.id = membership.user_id
  join public.workspace_roles role on role.workspace_id = membership.workspace_id and role.id = membership.role_id
  where membership.workspace_id = p_workspace_id
  order by users.email, membership.user_id;
end;
$$;

create or replace function list_workspace_roles_authorized(p_workspace_id uuid)
returns table (role_id uuid, name text, description text, is_builtin boolean, capabilities jsonb, member_count bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if not (private.has_workspace_capability(p_workspace_id, 'workspace.manage_roles') or private.has_workspace_capability(p_workspace_id, 'workspace.manage_members')) then raise exception 'Permission denied: workspace role management'; end if;
  return query
  select role.id, role.name, role.description, role.is_builtin,
    coalesce(jsonb_agg(capability.capability order by capability.capability) filter (where capability.capability is not null), '[]'::jsonb),
    count(distinct membership.user_id)
  from public.workspace_roles role
  left join public.workspace_role_capabilities capability on capability.workspace_id = role.workspace_id and capability.role_id = role.id
  left join public.workspace_memberships membership on membership.workspace_id = role.workspace_id and membership.role_id = role.id
  where role.workspace_id = p_workspace_id
  group by role.id, role.name, role.description, role.is_builtin
  order by lower(role.name), role.id;
end;
$$;

revoke all on function list_workspace_members_with_roles_authorized(uuid), list_workspace_roles_authorized(uuid) from public, anon;
grant execute on function list_workspace_members_with_roles_authorized(uuid), list_workspace_roles_authorized(uuid) to authenticated, service_role;

comment on function list_workspace_members_with_roles_authorized(uuid)
  is 'Capability-gated Members UI read model. Enumerates only user ID, email, and assigned role for members in the requested workspace.';

comment on function list_workspace_roles_authorized(uuid)
  is 'Capability-gated Roles UI read model. Exposes role metadata, capabilities, and membership count for the requested workspace.';
