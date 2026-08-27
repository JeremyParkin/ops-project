-- Fix for 0056: two functions read a bare column name that collides with
-- one of their own "returns table (...)" output columns. In PL/pgSQL, a
-- RETURNS TABLE clause implicitly declares a variable per output column
-- for the whole function body, so an unqualified column reference of the
-- same name is ambiguous between that variable and the actual table/CTE
-- column (error 42702). get_workload_by_person_authorized's "user_id" and
-- get_bottleneck_metrics_authorized's "process_template_id"/
-- "source_node_id"/"node_type" all hit this. Corrected 0056 already
-- qualifies every such reference for fresh bootstrap; this is corrective
-- for an already-applied environment.

create or replace function get_workload_by_person_authorized(
  p_workspace_id uuid,
  p_period_days integer
)
returns table (
  user_id uuid,
  email text,
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
  with scoped as (
    select distinct scope_source.user_id from private.managed_user_ids(p_workspace_id) scope_source
  )
  select
    scoped.user_id,
    member.email::text,
    count(*) filter (where step.status = 'active' and step.node_type = 'human_task')::integer,
    count(*) filter (where step.status = 'active' and step.node_type = 'approval')::integer,
    count(*) filter (where step.status = 'active' and step.due_at is not null and step.due_at < now())::integer,
    count(*) filter (where step.status = 'completed' and step.completed_at >= v_period_start)::integer
  from scoped
  join auth.users member on member.id = scoped.user_id
  left join public.process_step_runs step
    on step.workspace_id = p_workspace_id
   and step.assignee_user_id = scoped.user_id
   and step.node_type in ('human_task', 'approval')
  group by scoped.user_id, member.email
  order by member.email;
end;
$$;

revoke all on function get_workload_by_person_authorized(uuid, integer) from public, anon;
grant execute on function get_workload_by_person_authorized(uuid, integer) to authenticated, service_role;

create or replace function get_bottleneck_metrics_authorized(
  p_workspace_id uuid,
  p_period_days integer
)
returns table (
  process_template_id uuid,
  process_template_name text,
  source_node_id uuid,
  node_name text,
  node_type text,
  median_duration_seconds double precision,
  historical_count integer,
  current_active_count integer,
  current_overdue_count integer
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
  with scoped as (
    select distinct scope_source.user_id from private.managed_user_ids(p_workspace_id) scope_source
  ),
  touched_run_ids as (
    select distinct sr.process_run_id
    from public.process_step_runs sr
    where sr.workspace_id = p_workspace_id
      and sr.assignee_user_id in (select scoped.user_id from scoped)
  ),
  relevant_steps as (
    select step.status, step.started_at, step.completed_at, step.due_at,
           step.name, step.node_type, step.source_node_id,
           run.process_template_id, run.process_template_name
    from public.process_step_runs step
    join public.process_runs run
      on run.workspace_id = p_workspace_id and run.id = step.process_run_id
    where step.workspace_id = p_workspace_id
      and step.process_run_id in (select touched_run_ids.process_run_id from touched_run_ids)
      and step.node_type in ('human_task', 'approval', 'wait', 'condition_wait')
      and step.source_node_id is not null
  ),
  node_identity as (
    select rs.process_template_id, rs.source_node_id,
           (array_agg(rs.process_template_name order by rs.started_at desc nulls last))[1] as process_template_name,
           (array_agg(rs.name order by rs.started_at desc nulls last))[1] as node_name,
           (array_agg(rs.node_type order by rs.started_at desc nulls last))[1] as node_type
    from relevant_steps rs
    group by rs.process_template_id, rs.source_node_id
  ),
  historical as (
    select rs.process_template_id, rs.source_node_id,
           percentile_cont(0.5) within group (order by extract(epoch from (rs.completed_at - rs.started_at))) as median_duration_seconds,
           count(*) as historical_count
    from relevant_steps rs
    where rs.status = 'completed' and rs.completed_at >= v_period_start
    group by rs.process_template_id, rs.source_node_id
  ),
  current_state as (
    select rs.process_template_id, rs.source_node_id,
           count(*) as active_count,
           count(*) filter (where rs.due_at is not null and rs.due_at < now()) as overdue_count
    from relevant_steps rs
    where rs.status = 'active'
    group by rs.process_template_id, rs.source_node_id
  )
  select
    ni.process_template_id, ni.process_template_name, ni.source_node_id, ni.node_name, ni.node_type,
    h.median_duration_seconds, coalesce(h.historical_count, 0)::integer,
    coalesce(c.active_count, 0)::integer, coalesce(c.overdue_count, 0)::integer
  from node_identity ni
  left join historical h
    on h.process_template_id = ni.process_template_id and h.source_node_id = ni.source_node_id
  left join current_state c
    on c.process_template_id = ni.process_template_id and c.source_node_id = ni.source_node_id
  where coalesce(h.historical_count, 0) > 0 or coalesce(c.active_count, 0) > 0
  order by h.median_duration_seconds desc nulls last;
end;
$$;

revoke all on function get_bottleneck_metrics_authorized(uuid, integer) from public, anon;
grant execute on function get_bottleneck_metrics_authorized(uuid, integer) to authenticated, service_role;
