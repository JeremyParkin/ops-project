-- Phase 7C exposes a capability-gated operational portfolio. Organization
-- facts define scope only; this does not change the workspace-wide process
-- read baseline established in Phase 7A.

create or replace function list_managed_people_context_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text,
  is_direct_report boolean,
  team_sources jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if not private.has_workspace_capability(p_workspace_id, 'operations.view') then
    raise exception 'Permission denied: operations.view';
  end if;

  return query
  with direct_reports as (
    select relationship.report_user_id as scoped_user_id,
           true as direct_report,
           null::uuid as team_id,
           null::text as team_name
    from public.workspace_reporting_relationships relationship
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
    join public.workspace_teams team
      on team.workspace_id = lead.workspace_id
     and team.id = lead.team_id
     and team.archived_at is null
    join public.workspace_team_memberships membership
      on membership.workspace_id = team.workspace_id
     and membership.team_id = team.id
    where lead.workspace_id = p_workspace_id
      and lead.user_id = auth.uid()
  ),
  scoped_people as (
    select * from direct_reports
    union all
    select * from led_team_members
  )
  select scoped.scoped_user_id,
         member.email::text,
         bool_or(scoped.direct_report),
         coalesce(
           jsonb_agg(distinct jsonb_build_object('teamId', scoped.team_id, 'teamName', scoped.team_name))
             filter (where scoped.team_id is not null),
           '[]'::jsonb
         )
  from scoped_people scoped
  join public.workspace_memberships membership
    on membership.workspace_id = p_workspace_id
   and membership.user_id = scoped.scoped_user_id
  join auth.users member on member.id = scoped.scoped_user_id
  where scoped.scoped_user_id <> auth.uid()
  group by scoped.scoped_user_id, member.email
  order by member.email, scoped.scoped_user_id;
end;
$$;

revoke all on function list_managed_people_context_authorized(uuid) from public, anon;
grant execute on function list_managed_people_context_authorized(uuid) to authenticated, service_role;

comment on function list_managed_people_context_authorized(uuid)
  is 'Capability-gated Phase 7C management scope: direct reports plus active led-team members, deduplicated with provenance. It does not grant any new workspace permissions.';
