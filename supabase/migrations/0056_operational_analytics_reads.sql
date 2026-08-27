-- Phase 7D: Operational Analytics. Reuses Phase 7C's exact management-scope
-- derivation (extracted here into a shared private helper so Team Work and
-- analytics can never drift apart) and existing process semantics
-- (active/overdue/completed, derived-not-stored overdue) with no new
-- definitions. No new tables; five capability-gated read RPCs aggregate
-- directly from process_step_runs/process_runs.
--
-- Throughput/timeliness/workload deliberately count only completed
-- human_task/approval steps as "completed work" -- system routing
-- (parallel_split/parallel_join), automated action nodes, and timer/
-- condition waits never inflate throughput just because a template
-- contains more of them. Bottleneck/dwell-time analysis separately
-- includes wait and condition_wait alongside human_task/approval, since
-- time spent there is genuinely useful process information -- but not
-- parallel_split/parallel_join (near-instant system routing) or action
-- (near-instant on success; a stuck failed action never reaches
-- completed_at, so it cannot appear in a completed-duration query at all).
--
-- Overdue rate excludes undated work from its denominator entirely, per
-- the same principle: only human_task/approval steps that actually carry a
-- due_at are eligible to be "on time" or "overdue" at all.
--
-- Team-level workload rows are limited to teams the caller currently
-- leads and may overlap with each other or with per-person rows when one
-- managed person belongs to multiple led teams -- that overlap is
-- intentional and acceptable for each team's own contextual row. Overall
-- portfolio totals (get_operational_summary_authorized,
-- get_throughput_trend_authorized) are computed independently from the
-- deduplicated managed-person set, never by summing team rows.

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
  select scoped.scoped_user_id, scoped.direct_report, scoped.team_id, scoped.team_name
  from scoped_people scoped
  join public.workspace_memberships membership
    on membership.workspace_id = p_workspace_id
   and membership.user_id = scoped.scoped_user_id
  where scoped.scoped_user_id <> auth.uid();
$$;

revoke all on function private.managed_user_ids(uuid) from public, anon, authenticated, service_role;

comment on function private.managed_user_ids(uuid)
  is 'Single authoritative Phase 7C/7D management-scope derivation: direct reports plus active led-team members for auth.uid(), with provenance, self excluded, membership-checked. Callers dedupe/aggregate for their own shape.';

-- Refactored to delegate scope derivation to the shared helper above.
-- External signature and output shape are unchanged from Phase 7C.
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
  select scoped.user_id,
         member.email::text,
         bool_or(scoped.is_direct_report),
         coalesce(
           jsonb_agg(distinct jsonb_build_object('teamId', scoped.team_id, 'teamName', scoped.team_name))
             filter (where scoped.team_id is not null),
           '[]'::jsonb
         )
  from private.managed_user_ids(p_workspace_id) scoped
  join auth.users member on member.id = scoped.user_id
  group by scoped.user_id, member.email
  order by member.email, scoped.user_id;
end;
$$;

create or replace function get_operational_summary_authorized(
  p_workspace_id uuid,
  p_period_days integer
)
returns table (
  active_human_tasks integer,
  active_approvals integer,
  overdue_count integer,
  overdue_rate double precision,
  completed_human_work_steps integer,
  completed_runs integer,
  median_step_duration_seconds double precision,
  median_approval_turnaround_seconds double precision,
  median_cycle_time_seconds double precision
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
    select distinct user_id from private.managed_user_ids(p_workspace_id)
  ),
  active_steps as (
    select step.node_type, step.due_at
    from public.process_step_runs step
    where step.workspace_id = p_workspace_id
      and step.status = 'active'
      and step.node_type in ('human_task', 'approval')
      and step.assignee_user_id in (select user_id from scoped)
  ),
  completed_human_work as (
    select step.node_type, step.started_at, step.completed_at
    from public.process_step_runs step
    where step.workspace_id = p_workspace_id
      and step.status = 'completed'
      and step.node_type in ('human_task', 'approval')
      and step.assignee_user_id in (select user_id from scoped)
      and step.completed_at >= v_period_start
  ),
  completed_runs_in_period as (
    select run.started_at, run.completed_at
    from public.process_runs run
    where run.workspace_id = p_workspace_id
      and run.status = 'completed'
      and run.completed_at >= v_period_start
      and exists (
        select 1 from public.process_step_runs sr
        where sr.workspace_id = p_workspace_id
          and sr.process_run_id = run.id
          and sr.assignee_user_id in (select user_id from scoped)
      )
  )
  select
    (select count(*) from active_steps where node_type = 'human_task')::integer,
    (select count(*) from active_steps where node_type = 'approval')::integer,
    (select count(*) from active_steps where due_at is not null and due_at < now())::integer,
    (select case when count(*) filter (where due_at is not null) = 0 then null
       else (count(*) filter (where due_at is not null and due_at < now()))::double precision
            / (count(*) filter (where due_at is not null))::double precision
       end
     from active_steps),
    (select count(*) from completed_human_work)::integer,
    (select count(*) from completed_runs_in_period)::integer,
    (select percentile_cont(0.5) within group (order by extract(epoch from (completed_at - started_at)))
     from completed_human_work),
    (select percentile_cont(0.5) within group (order by extract(epoch from (completed_at - started_at)))
     from completed_human_work where node_type = 'approval'),
    (select percentile_cont(0.5) within group (order by extract(epoch from (completed_at - started_at)))
     from completed_runs_in_period);
end;
$$;

create or replace function get_throughput_trend_authorized(
  p_workspace_id uuid,
  p_period_days integer
)
returns table (
  bucket_start date,
  completed_human_work_steps integer,
  completed_runs integer,
  on_time_completions integer,
  late_completions integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_start timestamptz;
  v_bucket_unit text;
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
  v_bucket_unit := case when p_period_days <= 7 then 'day' else 'week' end;

  return query
  with scoped as (
    select distinct user_id from private.managed_user_ids(p_workspace_id)
  ),
  buckets as (
    select generate_series(
      date_trunc(v_bucket_unit, v_period_start),
      date_trunc(v_bucket_unit, now()),
      ('1 ' || v_bucket_unit)::interval
    ) as bucket_start
  ),
  completed_human_work as (
    select step.completed_at, step.due_at
    from public.process_step_runs step
    where step.workspace_id = p_workspace_id
      and step.status = 'completed'
      and step.node_type in ('human_task', 'approval')
      and step.assignee_user_id in (select user_id from scoped)
      and step.completed_at >= v_period_start
  ),
  completed_runs as (
    select run.completed_at
    from public.process_runs run
    where run.workspace_id = p_workspace_id
      and run.status = 'completed'
      and run.completed_at >= v_period_start
      and exists (
        select 1 from public.process_step_runs sr
        where sr.workspace_id = p_workspace_id
          and sr.process_run_id = run.id
          and sr.assignee_user_id in (select user_id from scoped)
      )
  ),
  work_by_bucket as (
    select date_trunc(v_bucket_unit, completed_at) as bucket_start,
           count(*) as completed_count,
           count(*) filter (where due_at is not null and completed_at <= due_at) as on_time_count,
           count(*) filter (where due_at is not null and completed_at > due_at) as late_count
    from completed_human_work
    group by 1
  ),
  runs_by_bucket as (
    select date_trunc(v_bucket_unit, completed_at) as bucket_start,
           count(*) as completed_count
    from completed_runs
    group by 1
  )
  select
    b.bucket_start::date,
    coalesce(w.completed_count, 0)::integer,
    coalesce(r.completed_count, 0)::integer,
    coalesce(w.on_time_count, 0)::integer,
    coalesce(w.late_count, 0)::integer
  from buckets b
  left join work_by_bucket w on w.bucket_start = b.bucket_start
  left join runs_by_bucket r on r.bucket_start = b.bucket_start
  order by b.bucket_start;
end;
$$;

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
  -- relevant_steps' own column names collide with several of this
  -- function's own OUT parameters (process_template_id, source_node_id,
  -- node_type); every reference below is explicitly qualified with the rs
  -- alias to avoid Postgres treating a bare name as ambiguous between the
  -- CTE column and the PL/pgSQL return-table variable of the same name.
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

revoke all on function list_managed_people_context_authorized(uuid) from public, anon;
revoke all on function get_operational_summary_authorized(uuid, integer) from public, anon;
revoke all on function get_throughput_trend_authorized(uuid, integer) from public, anon;
revoke all on function get_bottleneck_metrics_authorized(uuid, integer) from public, anon;
revoke all on function get_workload_by_person_authorized(uuid, integer) from public, anon;
revoke all on function get_workload_by_team_authorized(uuid, integer) from public, anon;

grant execute on function list_managed_people_context_authorized(uuid) to authenticated, service_role;
grant execute on function get_operational_summary_authorized(uuid, integer) to authenticated, service_role;
grant execute on function get_throughput_trend_authorized(uuid, integer) to authenticated, service_role;
grant execute on function get_bottleneck_metrics_authorized(uuid, integer) to authenticated, service_role;
grant execute on function get_workload_by_person_authorized(uuid, integer) to authenticated, service_role;
grant execute on function get_workload_by_team_authorized(uuid, integer) to authenticated, service_role;

comment on function get_operational_summary_authorized(uuid, integer)
  is 'Phase 7D portfolio-level workload/timeliness snapshot for the current management scope. Overdue rate excludes undated work from its denominator.';
comment on function get_throughput_trend_authorized(uuid, integer)
  is 'Phase 7D bucketed throughput/timeliness trend (completed human_task/approval steps and runs, on-time vs late) for the current management scope.';
comment on function get_bottleneck_metrics_authorized(uuid, integer)
  is 'Phase 7D dwell-time/bottleneck breakdown by process template and node, scoped to runs the caller''s managed people are assigned work in. Includes wait/condition_wait dwell time; excludes system routing and automated actions.';
comment on function get_workload_by_person_authorized(uuid, integer)
  is 'Phase 7D per-person workload row for the current management scope. Deduplicated by person; use for portfolio totals.';
comment on function get_workload_by_team_authorized(uuid, integer)
  is 'Phase 7D per-team workload row, limited to teams the caller currently leads. Rows may overlap a person across multiple teams; never sum these rows into a portfolio total.';

-- New index coverage: neither table previously had an index supporting a
-- period-scoped completed_at range scan, and process_runs had no index at
-- all beyond its implicit primary key / (workspace_id, id) uniqueness.
create index if not exists process_step_runs_completed_period_idx
  on process_step_runs (workspace_id, status, completed_at)
  where completed_at is not null;

create index if not exists process_runs_completed_period_idx
  on process_runs (workspace_id, status, completed_at)
  where completed_at is not null;

-- Supports the assignee+status+type lookups every new analytics query
-- performs (active/completed human_task and approval steps for one or many
-- assignees); the existing due-date index only covers the active+dated
-- subset already used by My Work/Team Work.
create index if not exists process_step_runs_assignee_status_type_idx
  on process_step_runs (workspace_id, assignee_user_id, status, node_type)
  where assignee_user_id is not null;
