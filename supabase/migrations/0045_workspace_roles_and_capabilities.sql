create table workspace_roles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create unique index workspace_roles_workspace_lower_name_key
  on workspace_roles (workspace_id, lower(name));

create table workspace_role_capabilities (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role_id uuid not null,
  capability text not null check (capability in (
    'workspace.manage_members', 'workspace.manage_roles', 'workspace.manage_settings',
    'schema.manage', 'automation.manage', 'records.operate', 'processes.operate',
    'operations.view'
  )),
  primary key (workspace_id, role_id, capability),
  foreign key (workspace_id, role_id) references workspace_roles(workspace_id, id) on delete cascade
);

alter table workspace_memberships add column role_id uuid;
alter table workspace_memberships add constraint workspace_memberships_workspace_role_fkey
  foreign key (workspace_id, role_id) references workspace_roles(workspace_id, id) on delete restrict;

alter table workspace_roles enable row level security;
alter table workspace_role_capabilities enable row level security;

create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_memberships membership where membership.workspace_id = p_workspace_id and membership.user_id = (select auth.uid()))
$$;

create or replace function private.has_workspace_capability(p_workspace_id uuid, p_capability text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_memberships membership
    join public.workspace_role_capabilities capability
      on capability.workspace_id = membership.workspace_id and capability.role_id = membership.role_id
    where membership.workspace_id = p_workspace_id
      and membership.user_id = (select auth.uid())
      and capability.capability = p_capability
  )
$$;

create or replace function private.require_workspace_capability(p_workspace_id uuid, p_capability text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if not private.has_workspace_capability(p_workspace_id, p_capability) then raise exception 'Permission denied: %', p_capability; end if;
end;
$$;

-- Every existing member receives a same-workspace compatibility role with the
-- broad access that membership previously implied.
insert into workspace_roles (workspace_id, name, description, is_builtin)
select id, 'Workspace administrator', 'Compatibility role with full workspace access.', true
from workspaces;

insert into workspace_role_capabilities (workspace_id, role_id, capability)
select role.workspace_id, role.id, capability.capability
from workspace_roles role
cross join (values
  ('workspace.manage_members'), ('workspace.manage_roles'), ('workspace.manage_settings'),
  ('schema.manage'), ('automation.manage'), ('records.operate'), ('processes.operate'), ('operations.view')
) as capability(capability)
where role.name = 'Workspace administrator';

update workspace_memberships membership
set role_id = role.id
from workspace_roles role
where role.workspace_id = membership.workspace_id and role.name = 'Workspace administrator';

alter table workspace_memberships alter column role_id set not null;

create policy workspace_roles_select_member on workspace_roles for select to authenticated using ((select private.is_workspace_member(workspace_id)));
create policy workspace_role_capabilities_select_member on workspace_role_capabilities for select to authenticated using ((select private.is_workspace_member(workspace_id)));

revoke all on table workspace_roles, workspace_role_capabilities from public, anon, authenticated;
grant select on table workspace_roles, workspace_role_capabilities to authenticated;
revoke all on function private.has_workspace_capability(uuid, text), private.require_workspace_capability(uuid, text) from public;
grant usage on schema private to authenticated;
grant execute on function private.has_workspace_capability(uuid, text), private.require_workspace_capability(uuid, text) to authenticated;
