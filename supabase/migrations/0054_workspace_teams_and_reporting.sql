-- Phase 7B keeps organizational facts separate from workspace roles. Teams,
-- team leadership, and reporting relationships never grant capabilities.

alter table workspace_role_capabilities
  drop constraint if exists workspace_role_capabilities_capability_check;

alter table workspace_role_capabilities
  add constraint workspace_role_capabilities_capability_check
  check (capability in (
    'workspace.manage_members',
    'workspace.manage_roles',
    'workspace.manage_organization',
    'workspace.manage_settings',
    'schema.manage',
    'automation.manage',
    'records.operate',
    'processes.operate',
    'operations.view'
  ));

-- Existing roles with both administrative capabilities already represent
-- workspace authority, so they retain the ability to manage this new layer.
insert into workspace_role_capabilities (workspace_id, role_id, capability)
select role.workspace_id, role.id, 'workspace.manage_organization'
from workspace_roles role
where exists (
  select 1
  from workspace_role_capabilities capability
  where capability.workspace_id = role.workspace_id
    and capability.role_id = role.id
    and capability.capability = 'workspace.manage_members'
)
and exists (
  select 1
  from workspace_role_capabilities capability
  where capability.workspace_id = role.workspace_id
    and capability.role_id = role.id
    and capability.capability = 'workspace.manage_roles'
)
on conflict do nothing;

create or replace function create_workspace_role_authorized(
  p_workspace_id uuid,
  p_name text,
  p_description text,
  p_capabilities jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role_id uuid := gen_random_uuid();
  v_capability text;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');

  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;

  insert into workspace_roles (id, workspace_id, name, description)
  values (v_role_id, p_workspace_id, trim(p_name), nullif(trim(p_description), ''));

  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members',
      'workspace.manage_roles',
      'workspace.manage_organization',
      'workspace.manage_settings',
      'schema.manage',
      'automation.manage',
      'records.operate',
      'processes.operate',
      'operations.view'
    ) then
      raise exception 'Invalid capability';
    end if;

    insert into workspace_role_capabilities (workspace_id, role_id, capability)
    values (p_workspace_id, v_role_id, v_capability);
  end loop;

  return v_role_id;
end;
$$;

create or replace function update_workspace_role_authorized(
  p_workspace_id uuid,
  p_role_id uuid,
  p_name text,
  p_description text,
  p_capabilities jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_capability text;
  v_caller_role uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  select role_id into v_caller_role
  from workspace_memberships
  where workspace_id = p_workspace_id
    and user_id = auth.uid()
  for update;

  if v_caller_role = p_role_id then
    raise exception 'You cannot edit the capabilities of your own role';
  end if;
  if not exists (
    select 1
    from workspace_roles
    where workspace_id = p_workspace_id
      and id = p_role_id
  ) then
    raise exception 'Role not found';
  end if;
  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;

  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members',
      'workspace.manage_roles',
      'workspace.manage_organization',
      'workspace.manage_settings',
      'schema.manage',
      'automation.manage',
      'records.operate',
      'processes.operate',
      'operations.view'
    ) then
      raise exception 'Invalid capability';
    end if;
  end loop;

  update workspace_roles
  set name = trim(p_name),
      description = nullif(trim(p_description), ''),
      updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_role_id;

  delete from workspace_role_capabilities
  where workspace_id = p_workspace_id
    and role_id = p_role_id;

  insert into workspace_role_capabilities (workspace_id, role_id, capability)
  select p_workspace_id, p_role_id, value
  from jsonb_array_elements_text(p_capabilities) value;

  perform private.assert_workspace_administrator(p_workspace_id);
end;
$$;

create table workspace_teams (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (nullif(trim(name), '') is not null),
  description text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create unique index workspace_teams_active_lower_name_key
  on workspace_teams (workspace_id, lower(trim(name)))
  where archived_at is null;

create table workspace_team_memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  team_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, team_id, user_id),
  foreign key (workspace_id, team_id)
    references workspace_teams(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id)
    references workspace_memberships(workspace_id, user_id) on delete cascade
);

create table workspace_team_leads (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  team_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, team_id, user_id),
  foreign key (workspace_id, team_id, user_id)
    references workspace_team_memberships(workspace_id, team_id, user_id)
    on delete cascade
);

create table workspace_reporting_relationships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  manager_user_id uuid not null,
  report_user_id uuid not null,
  relationship_kind text not null default 'primary_manager'
    check (relationship_kind = 'primary_manager'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (manager_user_id <> report_user_id),
  unique (workspace_id, id),
  unique (workspace_id, report_user_id, relationship_kind),
  foreign key (workspace_id, manager_user_id)
    references workspace_memberships(workspace_id, user_id) on delete cascade,
  foreign key (workspace_id, report_user_id)
    references workspace_memberships(workspace_id, user_id) on delete cascade
);

create trigger workspace_teams_workspace_id_immutable
  before update on workspace_teams
  for each row execute function private.reject_workspace_id_change();

create trigger workspace_team_memberships_workspace_id_immutable
  before update on workspace_team_memberships
  for each row execute function private.reject_workspace_id_change();

create trigger workspace_team_leads_workspace_id_immutable
  before update on workspace_team_leads
  for each row execute function private.reject_workspace_id_change();

create trigger workspace_reporting_relationships_workspace_id_immutable
  before update on workspace_reporting_relationships
  for each row execute function private.reject_workspace_id_change();

alter table workspace_teams enable row level security;
alter table workspace_team_memberships enable row level security;
alter table workspace_team_leads enable row level security;
alter table workspace_reporting_relationships enable row level security;

revoke all on table workspace_teams, workspace_team_memberships,
  workspace_team_leads, workspace_reporting_relationships
  from public, anon, authenticated;
grant select, insert, update, delete on table workspace_teams,
  workspace_team_memberships, workspace_team_leads,
  workspace_reporting_relationships to service_role;

create or replace function create_workspace_team_authorized(
  p_workspace_id uuid,
  p_name text,
  p_description text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id uuid := gen_random_uuid();
begin
  perform private.require_interactive_workspace_capability(
    p_workspace_id,
    'workspace.manage_organization'
  );

  if nullif(trim(p_name), '') is null then
    raise exception 'Team name is required';
  end if;

  insert into workspace_teams (id, workspace_id, name, description)
  values (v_team_id, p_workspace_id, trim(p_name), nullif(trim(p_description), ''));

  return v_team_id;
end;
$$;

create or replace function update_workspace_team_authorized(
  p_workspace_id uuid,
  p_team_id uuid,
  p_name text,
  p_description text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(
    p_workspace_id,
    'workspace.manage_organization'
  );

  if nullif(trim(p_name), '') is null then
    raise exception 'Team name is required';
  end if;

  update workspace_teams
  set name = trim(p_name),
      description = nullif(trim(p_description), ''),
      updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_team_id;

  if not found then
    raise exception 'Team not found';
  end if;
end;
$$;

create or replace function set_workspace_team_archived_authorized(
  p_workspace_id uuid,
  p_team_id uuid,
  p_archived boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(
    p_workspace_id,
    'workspace.manage_organization'
  );

  update workspace_teams
  set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
      updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_team_id;

  if not found then
    raise exception 'Team not found';
  end if;
end;
$$;

create or replace function delete_workspace_team_if_empty_authorized(
  p_workspace_id uuid,
  p_team_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(
    p_workspace_id,
    'workspace.manage_organization'
  );

  perform 1
  from workspace_teams
  where workspace_id = p_workspace_id
    and id = p_team_id
  for update;

  if not found then
    raise exception 'Team not found';
  end if;

  if exists (
    select 1
    from workspace_team_memberships
    where workspace_id = p_workspace_id
      and team_id = p_team_id
  ) then
    raise exception 'Remove team members before deleting this team';
  end if;

  delete from workspace_teams
  where workspace_id = p_workspace_id
    and id = p_team_id;
end;
$$;

create or replace function set_workspace_team_membership_authorized(
  p_workspace_id uuid,
  p_team_id uuid,
  p_user_id uuid,
  p_is_member boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_archived_at timestamptz;
begin
  perform private.require_interactive_workspace_capability(
    p_workspace_id,
    'workspace.manage_organization'
  );

  select archived_at into v_archived_at
  from workspace_teams
  where workspace_id = p_workspace_id
    and id = p_team_id
  for update;

  if not found then
    raise exception 'Team not found';
  end if;

  if not exists (
    select 1
    from workspace_memberships
    where workspace_id = p_workspace_id
      and user_id = p_user_id
  ) then
    raise exception 'Workspace member not found';
  end if;

  if p_is_member then
    if v_archived_at is not null then
      raise exception 'Archived teams cannot accept new members';
    end if;

    insert into workspace_team_memberships (workspace_id, team_id, user_id)
    values (p_workspace_id, p_team_id, p_user_id)
    on conflict do nothing;
  else
    delete from workspace_team_memberships
    where workspace_id = p_workspace_id
      and team_id = p_team_id
      and user_id = p_user_id;
  end if;
end;
$$;

create or replace function set_workspace_team_lead_authorized(
  p_workspace_id uuid,
  p_team_id uuid,
  p_user_id uuid,
  p_is_lead boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_archived_at timestamptz;
begin
  perform private.require_interactive_workspace_capability(
    p_workspace_id,
    'workspace.manage_organization'
  );

  select archived_at into v_archived_at
  from workspace_teams
  where workspace_id = p_workspace_id
    and id = p_team_id
  for update;

  if not found then
    raise exception 'Team not found';
  end if;

  if p_is_lead then
    if v_archived_at is not null then
      raise exception 'Archived teams cannot accept new leads';
    end if;

    if not exists (
      select 1
      from workspace_team_memberships
      where workspace_id = p_workspace_id
        and team_id = p_team_id
        and user_id = p_user_id
    ) then
      raise exception 'Team leads must be team members';
    end if;

    insert into workspace_team_leads (workspace_id, team_id, user_id)
    values (p_workspace_id, p_team_id, p_user_id)
    on conflict do nothing;
  else
    delete from workspace_team_leads
    where workspace_id = p_workspace_id
      and team_id = p_team_id
      and user_id = p_user_id;
  end if;
end;
$$;

create or replace function set_workspace_primary_manager_authorized(
  p_workspace_id uuid,
  p_report_user_id uuid,
  p_manager_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(
    p_workspace_id,
    'workspace.manage_organization'
  );
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  if not exists (
    select 1
    from workspace_memberships
    where workspace_id = p_workspace_id
      and user_id = p_report_user_id
  ) then
    raise exception 'Workspace member not found';
  end if;

  if p_manager_user_id is null then
    delete from workspace_reporting_relationships
    where workspace_id = p_workspace_id
      and report_user_id = p_report_user_id
      and relationship_kind = 'primary_manager';
    return;
  end if;

  if p_manager_user_id = p_report_user_id then
    raise exception 'A member cannot be their own manager';
  end if;

  if not exists (
    select 1
    from workspace_memberships
    where workspace_id = p_workspace_id
      and user_id = p_manager_user_id
  ) then
    raise exception 'Manager must be a workspace member';
  end if;

  if exists (
    with recursive manager_chain(user_id) as (
      select p_manager_user_id
      union
      select relationship.manager_user_id
      from workspace_reporting_relationships relationship
      join manager_chain chain
        on relationship.report_user_id = chain.user_id
      where relationship.workspace_id = p_workspace_id
        and relationship.relationship_kind = 'primary_manager'
    )
    select 1
    from manager_chain
    where user_id = p_report_user_id
  ) then
    raise exception 'Manager assignment would create a reporting cycle';
  end if;

  insert into workspace_reporting_relationships (
    workspace_id,
    manager_user_id,
    report_user_id,
    relationship_kind
  )
  values (
    p_workspace_id,
    p_manager_user_id,
    p_report_user_id,
    'primary_manager'
  )
  on conflict (workspace_id, report_user_id, relationship_kind)
  do update set manager_user_id = excluded.manager_user_id,
                updated_at = now();
end;
$$;

create or replace function list_workspace_teams_authorized(
  p_workspace_id uuid
)
returns table (
  team_id uuid,
  name text,
  description text,
  archived_at timestamptz,
  member_count bigint,
  lead_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if not private.has_workspace_capability(p_workspace_id, 'workspace.manage_organization') then
    raise exception 'Permission denied: workspace.manage_organization';
  end if;

  return query
  select team.id,
         team.name,
         team.description,
         team.archived_at,
         count(distinct membership.user_id),
         count(distinct lead.user_id)
  from public.workspace_teams team
  left join public.workspace_team_memberships membership
    on membership.workspace_id = team.workspace_id
   and membership.team_id = team.id
  left join public.workspace_team_leads lead
    on lead.workspace_id = team.workspace_id
   and lead.team_id = team.id
  where team.workspace_id = p_workspace_id
  group by team.id, team.name, team.description, team.archived_at
  order by team.archived_at nulls first, lower(team.name), team.id;
end;
$$;

create or replace function list_workspace_organization_members_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text,
  manager_user_id uuid,
  manager_email text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if not private.has_workspace_capability(p_workspace_id, 'workspace.manage_organization') then
    raise exception 'Permission denied: workspace.manage_organization';
  end if;

  return query
  select membership.user_id,
         member.email::text,
         relationship.manager_user_id,
         manager.email::text
  from public.workspace_memberships membership
  join auth.users member on member.id = membership.user_id
  left join public.workspace_reporting_relationships relationship
    on relationship.workspace_id = membership.workspace_id
   and relationship.report_user_id = membership.user_id
   and relationship.relationship_kind = 'primary_manager'
  left join auth.users manager on manager.id = relationship.manager_user_id
  where membership.workspace_id = p_workspace_id
  order by member.email, membership.user_id;
end;
$$;

create or replace function list_workspace_team_memberships_authorized(
  p_workspace_id uuid
)
returns table (
  team_id uuid,
  user_id uuid,
  is_lead boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if not private.has_workspace_capability(p_workspace_id, 'workspace.manage_organization') then
    raise exception 'Permission denied: workspace.manage_organization';
  end if;

  return query
  select membership.team_id,
         membership.user_id,
         (lead.user_id is not null)
  from public.workspace_team_memberships membership
  left join public.workspace_team_leads lead
    on lead.workspace_id = membership.workspace_id
   and lead.team_id = membership.team_id
   and lead.user_id = membership.user_id
  where membership.workspace_id = p_workspace_id
  order by membership.team_id, membership.user_id;
end;
$$;

create or replace function list_my_workspace_teams_authorized(
  p_workspace_id uuid
)
returns table (
  team_id uuid,
  name text,
  description text,
  is_lead boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select team.id,
         team.name,
         team.description,
         (lead.user_id is not null)
  from public.workspace_team_memberships membership
  join public.workspace_teams team
    on team.workspace_id = membership.workspace_id
   and team.id = membership.team_id
  left join public.workspace_team_leads lead
    on lead.workspace_id = membership.workspace_id
   and lead.team_id = membership.team_id
   and lead.user_id = membership.user_id
  where membership.workspace_id = p_workspace_id
    and membership.user_id = auth.uid()
    and team.archived_at is null
  order by lower(team.name), team.id;
end;
$$;

create or replace function get_my_workspace_manager_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select relationship.manager_user_id,
         manager.email::text
  from public.workspace_reporting_relationships relationship
  join auth.users manager on manager.id = relationship.manager_user_id
  where relationship.workspace_id = p_workspace_id
    and relationship.report_user_id = auth.uid()
    and relationship.relationship_kind = 'primary_manager';
end;
$$;

create or replace function list_my_direct_reports_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select relationship.report_user_id,
         report.email::text
  from public.workspace_reporting_relationships relationship
  join auth.users report on report.id = relationship.report_user_id
  where relationship.workspace_id = p_workspace_id
    and relationship.manager_user_id = auth.uid()
    and relationship.relationship_kind = 'primary_manager'
  order by report.email, relationship.report_user_id;
end;
$$;

create or replace function list_my_team_members_authorized(
  p_workspace_id uuid,
  p_team_id uuid
)
returns table (
  user_id uuid,
  email text,
  is_lead boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if not exists (
    select 1
    from public.workspace_team_memberships own_membership
    where own_membership.workspace_id = p_workspace_id
      and own_membership.team_id = p_team_id
      and own_membership.user_id = auth.uid()
  ) then
    raise exception 'Team access denied';
  end if;

  return query
  select membership.user_id,
         member.email::text,
         (lead.user_id is not null)
  from public.workspace_team_memberships membership
  join auth.users member on member.id = membership.user_id
  left join public.workspace_team_leads lead
    on lead.workspace_id = membership.workspace_id
   and lead.team_id = membership.team_id
   and lead.user_id = membership.user_id
  where membership.workspace_id = p_workspace_id
    and membership.team_id = p_team_id
  order by member.email, membership.user_id;
end;
$$;

revoke all on function
  create_workspace_team_authorized(uuid, text, text),
  update_workspace_team_authorized(uuid, uuid, text, text),
  set_workspace_team_archived_authorized(uuid, uuid, boolean),
  delete_workspace_team_if_empty_authorized(uuid, uuid),
  set_workspace_team_membership_authorized(uuid, uuid, uuid, boolean),
  set_workspace_team_lead_authorized(uuid, uuid, uuid, boolean),
  set_workspace_primary_manager_authorized(uuid, uuid, uuid),
  list_workspace_teams_authorized(uuid),
  list_workspace_organization_members_authorized(uuid),
  list_workspace_team_memberships_authorized(uuid),
  list_my_workspace_teams_authorized(uuid),
  get_my_workspace_manager_authorized(uuid),
  list_my_direct_reports_authorized(uuid),
  list_my_team_members_authorized(uuid, uuid)
from public, anon;

grant execute on function
  create_workspace_team_authorized(uuid, text, text),
  update_workspace_team_authorized(uuid, uuid, text, text),
  set_workspace_team_archived_authorized(uuid, uuid, boolean),
  delete_workspace_team_if_empty_authorized(uuid, uuid),
  set_workspace_team_membership_authorized(uuid, uuid, uuid, boolean),
  set_workspace_team_lead_authorized(uuid, uuid, uuid, boolean),
  set_workspace_primary_manager_authorized(uuid, uuid, uuid),
  list_workspace_teams_authorized(uuid),
  list_workspace_organization_members_authorized(uuid),
  list_workspace_team_memberships_authorized(uuid),
  list_my_workspace_teams_authorized(uuid),
  get_my_workspace_manager_authorized(uuid),
  list_my_direct_reports_authorized(uuid),
  list_my_team_members_authorized(uuid, uuid)
to authenticated, service_role;

comment on table workspace_teams
  is 'Flat workspace-scoped organizational teams. Team membership and leadership remain separate from roles and reporting relationships.';
comment on table workspace_reporting_relationships
  is 'Workspace-scoped organizational reporting relationships. Phase 7B supports zero or one primary manager per report.';
