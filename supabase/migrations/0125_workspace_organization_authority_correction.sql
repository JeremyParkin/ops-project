-- 13.2B4b1: close the organization mutation impersonation boundary and
-- exclude deactivated members from new active relationships and operational
-- management scopes. Structural organization rows remain durable.

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
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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
  v_deactivated_at timestamptz;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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

  select deactivated_at into v_deactivated_at
  from workspace_memberships
  where workspace_id = p_workspace_id
    and user_id = p_user_id;

  if not found then
    raise exception 'Workspace member not found';
  end if;

  if p_is_member then
    if v_deactivated_at is not null then
      raise exception 'Deactivated members cannot be added to teams';
    end if;
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
  v_deactivated_at timestamptz;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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

    select deactivated_at into v_deactivated_at
    from workspace_memberships
    where workspace_id = p_workspace_id
      and user_id = p_user_id;

    if not found then
      raise exception 'Workspace member not found';
    end if;
    if v_deactivated_at is not null then
      raise exception 'Deactivated members cannot be team leads';
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
declare
  v_report_deactivated_at timestamptz;
  v_manager_deactivated_at timestamptz;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(
    p_workspace_id,
    'workspace.manage_organization'
  );
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  select deactivated_at into v_report_deactivated_at
  from workspace_memberships
  where workspace_id = p_workspace_id
    and user_id = p_report_user_id;

  if not found then
    raise exception 'Workspace member not found';
  end if;

  if p_manager_user_id is null then
    delete from workspace_reporting_relationships
    where workspace_id = p_workspace_id
      and report_user_id = p_report_user_id
      and relationship_kind = 'primary_manager';
    return;
  end if;

  if v_report_deactivated_at is not null then
    raise exception 'Deactivated members cannot receive a manager assignment';
  end if;

  if p_manager_user_id = p_report_user_id then
    raise exception 'A member cannot be their own manager';
  end if;

  select deactivated_at into v_manager_deactivated_at
  from workspace_memberships
  where workspace_id = p_workspace_id
    and user_id = p_manager_user_id;

  if not found then
    raise exception 'Manager must be a workspace member';
  end if;
  if v_manager_deactivated_at is not null then
    raise exception 'Deactivated members cannot be managers';
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

-- Administrative organization inventory intentionally remains inclusive of
-- deactivated members so stale relationships can be inspected and removed.
-- The shared helper below is exclusively for active operational scopes.
create or replace function private.managed_user_ids(p_workspace_id uuid)
returns table (
  user_id uuid,
  is_direct_report boolean,
  team_id uuid,
  team_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  with direct_reports as (
    select relationship.report_user_id as scoped_user_id,
           true as direct_report,
           null::uuid as team_id,
           null::text as team_name
    from public.workspace_reporting_relationships relationship
    join public.workspace_memberships report_membership
      on report_membership.workspace_id = relationship.workspace_id
     and report_membership.user_id = relationship.report_user_id
     and report_membership.deactivated_at is null
    join public.workspace_memberships manager_membership
      on manager_membership.workspace_id = relationship.workspace_id
     and manager_membership.user_id = relationship.manager_user_id
     and manager_membership.deactivated_at is null
    where relationship.workspace_id = p_workspace_id
      and relationship.manager_user_id = auth.uid()
      and relationship.relationship_kind = 'primary_manager'
  ),
  led_team_members as (
    select membership.user_id as scoped_user_id,
           false as direct_report,
           team.id as team_id,
           team.name as team_name
    from public.workspace_team_leads lead
    join public.workspace_memberships lead_membership
      on lead_membership.workspace_id = lead.workspace_id
     and lead_membership.user_id = lead.user_id
     and lead_membership.deactivated_at is null
    join public.workspace_teams team
      on team.workspace_id = lead.workspace_id
     and team.id = lead.team_id
     and team.archived_at is null
    join public.workspace_team_memberships membership
      on membership.workspace_id = team.workspace_id
     and membership.team_id = team.id
    join public.workspace_memberships member_membership
      on member_membership.workspace_id = membership.workspace_id
     and member_membership.user_id = membership.user_id
     and member_membership.deactivated_at is null
    where lead.workspace_id = p_workspace_id
      and lead.user_id = auth.uid()
  ),
  scoped_people as (
    select * from direct_reports
    union all
    select * from led_team_members
  )
  select scoped.scoped_user_id, scoped.direct_report, scoped.team_id, scoped.team_name
  from scoped_people scoped
  where scoped.scoped_user_id <> auth.uid();
$$;

revoke all on function private.managed_user_ids(uuid) from public, anon, authenticated, service_role;

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
  join public.workspace_memberships report_membership
    on report_membership.workspace_id = relationship.workspace_id
   and report_membership.user_id = relationship.report_user_id
   and report_membership.deactivated_at is null
  join public.workspace_memberships manager_membership
    on manager_membership.workspace_id = relationship.workspace_id
   and manager_membership.user_id = relationship.manager_user_id
   and manager_membership.deactivated_at is null
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
  join public.workspace_memberships manager_membership
    on manager_membership.workspace_id = relationship.workspace_id
   and manager_membership.user_id = relationship.manager_user_id
   and manager_membership.deactivated_at is null
  join public.workspace_memberships report_membership
    on report_membership.workspace_id = relationship.workspace_id
   and report_membership.user_id = relationship.report_user_id
   and report_membership.deactivated_at is null
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
  join public.workspace_memberships member_membership
    on member_membership.workspace_id = membership.workspace_id
   and member_membership.user_id = membership.user_id
   and member_membership.deactivated_at is null
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

create or replace function get_workload_by_team_authorized(
  p_workspace_id uuid,
  p_period_days integer
)
returns table (
  team_id uuid,
  team_name text,
  member_count integer,
  active_human_tasks integer,
  active_approvals integer,
  overdue_count integer,
  completed_in_period integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_start timestamptz;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if not private.has_workspace_capability(p_workspace_id, 'operations.view') then
    raise exception 'Permission denied: operations.view';
  end if;

  if p_period_days not in (7, 30, 90) then
    raise exception 'Unsupported analytics period';
  end if;

  v_period_start := now() - make_interval(days => p_period_days);

  return query
  with led_teams as (
    select team.id as team_id, team.name as team_name
    from public.workspace_team_leads lead
    join public.workspace_memberships lead_membership
      on lead_membership.workspace_id = lead.workspace_id
     and lead_membership.user_id = lead.user_id
     and lead_membership.deactivated_at is null
    join public.workspace_teams team
      on team.workspace_id = lead.workspace_id
     and team.id = lead.team_id
     and team.archived_at is null
    where lead.workspace_id = p_workspace_id
      and lead.user_id = auth.uid()
  ),
  team_members as (
    select led.team_id, led.team_name, membership.user_id
    from led_teams led
    join public.workspace_team_memberships membership
      on membership.workspace_id = p_workspace_id
     and membership.team_id = led.team_id
    join public.workspace_memberships member_membership
      on member_membership.workspace_id = membership.workspace_id
     and member_membership.user_id = membership.user_id
     and member_membership.deactivated_at is null
    where membership.user_id <> auth.uid()
  )
  select
    tm.team_id,
    tm.team_name,
    count(distinct tm.user_id)::integer,
    count(*) filter (where step.status = 'active' and step.node_type = 'human_task')::integer,
    count(*) filter (where step.status = 'active' and step.node_type = 'approval')::integer,
    count(*) filter (where step.status = 'active' and step.due_at is not null and step.due_at < now())::integer,
    count(*) filter (where step.status = 'completed' and step.completed_at >= v_period_start)::integer
  from team_members tm
  left join public.process_step_runs step
    on step.workspace_id = p_workspace_id
   and step.assignee_user_id = tm.user_id
   and step.node_type in ('human_task', 'approval')
  group by tm.team_id, tm.team_name
  order by tm.team_name;
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
  get_my_workspace_manager_authorized(uuid),
  list_my_direct_reports_authorized(uuid),
  list_my_team_members_authorized(uuid, uuid),
  get_workload_by_team_authorized(uuid, integer)
from public, anon;

grant execute on function
  create_workspace_team_authorized(uuid, text, text),
  update_workspace_team_authorized(uuid, uuid, text, text),
  set_workspace_team_archived_authorized(uuid, uuid, boolean),
  delete_workspace_team_if_empty_authorized(uuid, uuid),
  set_workspace_team_membership_authorized(uuid, uuid, uuid, boolean),
  set_workspace_team_lead_authorized(uuid, uuid, uuid, boolean),
  set_workspace_primary_manager_authorized(uuid, uuid, uuid),
  get_my_workspace_manager_authorized(uuid),
  list_my_direct_reports_authorized(uuid),
  list_my_team_members_authorized(uuid, uuid),
  get_workload_by_team_authorized(uuid, integer)
to authenticated, service_role;
