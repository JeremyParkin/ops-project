-- Fix for 0056: get_workload_by_team_authorized joined every current
-- member of a led team, including the caller themselves when they are
-- also a member (not just lead) of their own team. Every other Phase
-- 7C/7D scope query (private.managed_user_ids, and by extension
-- get_workload_by_person_authorized) excludes the caller -- a team's
-- workload row should consistently mean "my team members' workload," not
-- incidentally include my own. Corrected 0056 already excludes self for
-- fresh bootstrap; this is corrective for an already-applied environment.

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

revoke all on function get_workload_by_team_authorized(uuid, integer) from public, anon;
grant execute on function get_workload_by_team_authorized(uuid, integer) to authenticated, service_role;
