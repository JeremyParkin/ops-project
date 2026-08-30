-- Phase 8D.3: record-context Activity, built on the workspace_events
-- foundation approved and shipped (unused for reads) in 0064.
--
-- Adds three event types -- process_started, process_completed,
-- approval_decided -- to the existing bounded vocabulary, emitted from the
-- three canonical transitions every trigger path (manual, workflow,
-- recurrence, retry) already funnels through. step_assigned (0064) is
-- reused as-is; step_due_soon/step_overdue/recurrence_started_process stay
-- in workspace_events but are excluded from the Activity projection by the
-- new read RPC's own event_type filter, not by any schema change here.
--
-- Actor semantics, the important part of this migration: the canonical
-- start_process_run_authorized_member gains a required p_actor_user_id
-- parameter with NO default, so a caller can never silently inherit
-- auth.uid() by forgetting to pass it -- every one of its three callers
-- must say explicitly what they mean:
--   - start_process_run_authorized (existing public signature, UNCHANGED)
--     passes auth.uid() -- a human directly clicked Start Process.
--   - start_process_run_via_workflow_authorized (new) passes a hard-coded
--     null -- workflow automation is deterministic system behavior, even
--     though it happens to run under the triggering editor's own session;
--     attributing it to "whoever's edit happened to fire the workflow"
--     is exactly the "last editor" misattribution the product spec called
--     out to avoid. Same processes.operate capability check as the public
--     wrapper -- this does not weaken or bypass authorization, it only
--     changes what gets written to actor_user_id.
--   - start_process_run_system (0063, service_role-only) passes null --
--     recurrence has no human in the loop at invocation time.
-- process_completed (private.try_complete_process_run) and step_assigned
-- (0064, unchanged) always get actor_user_id = null: run completion is a
-- derived system transition with no single acting user, and no reassignment
-- path exists today to give assignment a human actor. approval_decided
-- always gets auth.uid(), since decide_process_approval_authorized_member
-- already requires a non-null authenticated user to reach that point.

-- 1. Event taxonomy: three additions to the existing bounded CHECK.
alter table workspace_events drop constraint workspace_events_event_type_check;
alter table workspace_events add constraint workspace_events_event_type_check
  check (event_type in (
    'step_assigned', 'step_due_soon', 'step_overdue', 'recurrence_started_process',
    'process_started', 'process_completed', 'approval_decided'
  ));

-- 2. Index for the record-scoped Activity query -- the existing
-- (workspace_id, created_at desc) index serves a general feed this project
-- deliberately isn't building; this one serves "events for one record",
-- the only access pattern 8D.3 actually needs.
create index workspace_events_record_created_idx
  on workspace_events (workspace_id, entity_record_id, created_at desc)
  where entity_record_id is not null;

-- 3. Canonical process-start implementation. Signature changes (a new
-- required parameter inserted before the existing trailing default), so
-- this is a genuine drop-and-recreate, not an in-place CREATE OR REPLACE --
-- Postgres would otherwise leave the old 5-arg overload orphaned alongside
-- the new one rather than replacing it.
drop function if exists start_process_run_authorized_member(uuid, uuid, uuid, uuid, uuid);

create function start_process_run_authorized_member(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_actor_user_id uuid,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template process_templates%rowtype;
  v_existing_run_id uuid;
  v_run_id uuid := gen_random_uuid();
  v_start_node_id uuid;
  v_start_step_run_id uuid;
  v_activation_at timestamptz := now();
  v_node process_nodes%rowtype;
  v_assignee_label text;
  v_node_count integer;
  v_start_count integer;
  v_edge process_edges%rowtype;
begin
  if auth.role() <> 'service_role' and not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if p_originating_process_step_run_id is not null then
    select id into v_existing_run_id from process_runs
    where workspace_id = p_workspace_id and originating_process_step_run_id = p_originating_process_step_run_id;
    if found then
      return v_existing_run_id;
    end if;
  end if;

  select * into v_template from process_templates where workspace_id = p_workspace_id and id = p_process_template_id and archived_at is null;
  if not found then raise exception 'Process template not found or archived'; end if;
  if v_template.applies_to_entity_type_id <> p_origin_entity_type_id then raise exception 'Process template does not apply to this record''s entity type'; end if;
  if not exists (select 1 from entity_records where workspace_id = p_workspace_id and entity_type_id = p_origin_entity_type_id and id = p_origin_record_id and archived_at is null) then raise exception 'Origin record not found or archived'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_origin_record_id::text, 0));
  if exists (select 1 from process_runs where workspace_id = p_workspace_id and process_template_id = p_process_template_id and origin_record_id = p_origin_record_id and status = 'active') then raise exception 'This process is already running for this record'; end if;
  select count(*) into v_node_count from process_nodes where workspace_id = p_workspace_id and process_template_id = p_process_template_id;
  if v_node_count = 0 then raise exception 'Process template has no steps'; end if;
  perform private.validate_process_parallel_template(p_workspace_id, p_process_template_id);
  perform private.validate_process_approval_template(p_workspace_id, p_process_template_id);
  select count(*), (array_agg(node.id order by node.position))[1] into v_start_count, v_start_node_id
  from process_nodes node
  where node.workspace_id = p_workspace_id and node.process_template_id = p_process_template_id
    and not exists (select 1 from process_edges edge where edge.workspace_id = p_workspace_id and edge.process_template_id = p_process_template_id and edge.target_node_id = node.id);
  if v_start_count <> 1 then raise exception 'Process template must have exactly one start step'; end if;
  for v_edge in select * from process_edges where workspace_id = p_workspace_id and process_template_id = p_process_template_id and not is_default and not is_parallel and approval_outcome_id is null loop
    perform private.validate_process_branch_conditions(p_workspace_id, p_origin_entity_type_id, v_edge.condition_config);
  end loop;
  insert into process_runs (id, workspace_id, process_template_id, process_template_name, process_template_description, origin_entity_type_id, origin_record_id, status, originating_process_step_run_id)
  values (v_run_id, p_workspace_id, p_process_template_id, v_template.name, v_template.description, p_origin_entity_type_id, p_origin_record_id, 'active', p_originating_process_step_run_id);

  begin
    insert into workspace_events (
      id, workspace_id, actor_user_id, event_type, entity_type_id, entity_record_id,
      process_template_id, process_run_id
    )
    values (
      gen_random_uuid(), p_workspace_id, p_actor_user_id, 'process_started', p_origin_entity_type_id, p_origin_record_id,
      p_process_template_id, v_run_id
    );
  exception when others then
    null;
  end;

  for v_node in select * from process_nodes where workspace_id = p_workspace_id and process_template_id = p_process_template_id order by position loop
    v_assignee_label := null;
    if v_node.node_type in ('human_task', 'approval') and v_node.assignee_user_id is not null then select email into v_assignee_label from auth.users where id = v_node.assignee_user_id; end if;
    insert into process_step_runs (id, workspace_id, process_run_id, source_node_id, step_index, node_type, parallel_group_id, name, config, status, assignee_user_id, assignee_label)
    values (gen_random_uuid(), p_workspace_id, v_run_id, v_node.id, v_node.position, v_node.node_type, v_node.parallel_group_id, v_node.name, v_node.config, 'pending', case when v_node.node_type in ('human_task', 'approval') then v_node.assignee_user_id else null end, v_assignee_label);
  end loop;
  insert into process_step_run_routes (workspace_id, process_run_id, source_step_run_id, target_step_run_id, source_node_id, target_node_id, priority, condition_config, condition_summary, is_default, is_parallel, approval_outcome_id, approval_outcome_label)
  select edge.workspace_id, v_run_id, source_step.id, target_step.id, edge.source_node_id, edge.target_node_id, edge.priority, edge.condition_config,
    case when edge.is_default or edge.is_parallel or edge.approval_outcome_id is not null then null else private.process_branch_condition_summary(p_workspace_id, p_origin_entity_type_id, edge.condition_config) end,
    edge.is_default, edge.is_parallel, edge.approval_outcome_id, edge.approval_outcome_label
  from process_edges edge
  join process_step_runs source_step on source_step.workspace_id = edge.workspace_id and source_step.process_run_id = v_run_id and source_step.source_node_id = edge.source_node_id
  join process_step_runs target_step on target_step.workspace_id = edge.workspace_id and target_step.process_run_id = v_run_id and target_step.source_node_id = edge.target_node_id
  where edge.workspace_id = p_workspace_id and edge.process_template_id = p_process_template_id;
  select id into v_start_step_run_id from process_step_runs where workspace_id = p_workspace_id and process_run_id = v_run_id and source_node_id = v_start_node_id;
  perform private.activate_process_step_run(p_workspace_id, v_run_id, v_start_step_run_id, v_activation_at, null);
  return v_run_id;
end;
$$;

revoke all on function start_process_run_authorized_member(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function start_process_run_authorized_member(uuid, uuid, uuid, uuid, uuid, uuid) to service_role;

-- 4. The public interactive wrapper -- signature UNCHANGED so every
-- existing caller (the manual "Start Process" button) keeps working
-- untouched. Now explicitly supplies auth.uid() rather than relying on any
-- default inside the canonical function.
create or replace function start_process_run_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return start_process_run_authorized_member(
    p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id,
    auth.uid(), p_originating_process_step_run_id
  );
end;
$$;

-- 5. A second, workflow-only interactive door into the same canonical
-- function -- identical capability check to the wrapper above (workflow
-- automation runs under the triggering user's own session and must clear
-- the same processes.operate bar it always has; this does not loosen
-- authorization), differing only in what it tells the canonical function
-- about actor attribution. Hard-coded null, not a parameter the caller can
-- override -- there is no way to accidentally pass a human actor through
-- this door.
create function start_process_run_via_workflow_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return start_process_run_authorized_member(
    p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id,
    null, p_originating_process_step_run_id
  );
end;
$$;

revoke all on function start_process_run_authorized(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function start_process_run_authorized(uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;
revoke all on function start_process_run_via_workflow_authorized(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function start_process_run_via_workflow_authorized(uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

-- 6. Recurrence's system door -- explicit null actor, same as before, now
-- passed explicitly into the canonical function's new required parameter
-- instead of an implicit default. recurrence_started_process keeps being
-- recorded exactly as in 0064 -- process_started (from the canonical
-- function above) now also fires for every recurrence-triggered run, but
-- that is deliberately not a duplicate *visible* Activity line: only
-- process_started is projected into Activity (see the RPC below),
-- recurrence_started_process stays as internal/future bookkeeping.
create or replace function start_process_run_system(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_originating_recurrence_occurrence_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
begin
  v_run_id := start_process_run_authorized_member(
    p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id, null
  );

  update process_runs
  set originating_recurrence_occurrence_id = p_originating_recurrence_occurrence_id
  where workspace_id = p_workspace_id and id = v_run_id;

  begin
    insert into workspace_events (
      id, workspace_id, event_type, entity_type_id, entity_record_id,
      process_template_id, process_run_id, metadata
    )
    values (
      gen_random_uuid(), p_workspace_id, 'recurrence_started_process', p_origin_entity_type_id, p_origin_record_id,
      p_process_template_id, v_run_id,
      jsonb_build_object('originating_recurrence_occurrence_id', p_originating_recurrence_occurrence_id)
    );
  exception when others then
    null;
  end;

  return v_run_id;
end;
$$;

revoke all on function start_process_run_system(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function start_process_run_system(uuid, uuid, uuid, uuid, uuid) to service_role;

-- 7. Run completion. private.try_complete_process_run (0033) is the sole
-- place process_runs.status ever transitions to 'completed' -- every other
-- completion-adjacent update site (0037/0038's wait/condition-wait resume
-- paths) already calls this function rather than reimplementing it. The
-- second UPDATE's own `and status = 'active'` guard makes it naturally
-- idempotent; `returning ... into` plus `if found` reuses that same guard
-- to decide whether this specific call is the one that actually completed
-- the run, so the event can never double-fire from an overlapping call.
-- actor_user_id is always null: no single human "completes a process," a
-- human completes a step or decides an approval, and the run transition
-- itself falls out mechanically from whichever call happened to be the
-- last one in.
create or replace function private.try_complete_process_run(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_completed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run process_runs%rowtype;
begin
  if exists (
    select 1 from process_step_runs
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id and status = 'active'
  ) or exists (
    select 1 from process_parallel_join_obligations
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id and arrived_at is null
  ) then
    return;
  end if;

  update process_step_runs
  set status = 'skipped', due_at = null
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and status = 'pending';

  update process_runs
  set status = 'completed', completed_at = p_completed_at
  where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active'
  returning * into v_run;

  if found then
    begin
      insert into workspace_events (
        id, workspace_id, actor_user_id, event_type, entity_type_id, entity_record_id,
        process_template_id, process_run_id
      )
      values (
        gen_random_uuid(), p_workspace_id, null, 'process_completed', v_run.origin_entity_type_id, v_run.origin_record_id,
        v_run.process_template_id, p_process_run_id
      );
    exception when others then
      null;
    end;
  end if;
end;
$$;

-- 8. Approval decisions. decide_process_approval_authorized_member (0035,
-- unchanged since) already requires and durably snapshots the decision --
-- approval_outcome_label and decided_by_label live on the step run itself,
-- so the event needs no metadata copy of either; the Activity read path
-- joins process_step_runs directly. actor_user_id = auth.uid(), which this
-- function already guarantees is non-null before this point is reached.
create or replace function decide_process_approval_authorized_member(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_outcome_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_run process_step_runs%rowtype;
  v_run process_runs%rowtype;
  v_target_step_run process_step_runs%rowtype;
  v_route process_step_run_routes%rowtype;
  v_activation_at timestamptz := now();
  v_arrived_count integer := 0;
  v_decided_by_label text;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if auth.uid() is null then raise exception 'Approval decisions require an authenticated user'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));
  select * into v_run from process_runs where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active' for update;
  if not found then raise exception 'Process run is not active'; end if;
  select * into v_step_run from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found then raise exception 'Step not found'; end if;
  if v_step_run.node_type <> 'approval' then raise exception 'This step is not an approval'; end if;
  if v_step_run.status <> 'active' then raise exception 'This approval is not active'; end if;
  if v_step_run.assignee_user_id is not null and v_step_run.assignee_user_id <> auth.uid() then raise exception 'This approval is assigned to another member'; end if;
  perform 1 from entity_records where workspace_id = p_workspace_id and entity_type_id = v_run.origin_entity_type_id and id = v_run.origin_record_id and archived_at is null for share;
  if not found then raise exception 'Origin record not found or archived'; end if;
  select * into v_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = p_step_run_id and approval_outcome_id = p_outcome_id
  for update;
  if not found then raise exception 'Approval outcome is not available for this step'; end if;
  select * into v_target_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_route.target_step_run_id for update;
  if not found or v_target_step_run.status <> 'pending' then raise exception 'Process route target is not available'; end if;
  select email into v_decided_by_label from auth.users where id = auth.uid();
  if v_decided_by_label is null then raise exception 'Approval decision user was not found'; end if;

  update process_step_runs
  set status = 'completed', completed_at = v_activation_at,
    approval_outcome_id = v_route.approval_outcome_id,
    approval_outcome_label = v_route.approval_outcome_label,
    decided_at = v_activation_at,
    decided_by_user_id = auth.uid(),
    decided_by_label = v_decided_by_label,
    routing_result = jsonb_build_object(
      'selectedRouteId', v_route.id,
      'targetStepRunId', v_target_step_run.id,
      'outcome', 'approval_outcome',
      'approvalOutcomeId', v_route.approval_outcome_id,
      'approvalOutcomeLabel', v_route.approval_outcome_label,
      'evaluatedAt', v_activation_at
    )
  where workspace_id = p_workspace_id and id = p_step_run_id;

  begin
    insert into workspace_events (
      id, workspace_id, actor_user_id, event_type, entity_type_id, entity_record_id,
      process_template_id, process_run_id, process_step_run_id
    )
    values (
      gen_random_uuid(), p_workspace_id, auth.uid(), 'approval_decided', v_run.origin_entity_type_id, v_run.origin_record_id,
      v_run.process_template_id, p_process_run_id, p_step_run_id
    );
  exception when others then
    null;
  end;

  if v_step_run.parallel_branch_token is null then
    with recursive reachable(step_run_id) as (
      select v_target_step_run.id
      union
      select route.target_step_run_id
      from process_step_run_routes route
      join reachable on reachable.step_run_id = route.source_step_run_id
      where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id
    )
    update process_step_runs step_run
    set status = 'skipped', due_at = null
    where step_run.workspace_id = p_workspace_id and step_run.process_run_id = p_process_run_id
      and step_run.status = 'pending'
      and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  else
    with recursive reachable(step_run_id) as (
      select v_target_step_run.id
      union
      select route.target_step_run_id
      from process_step_run_routes route
      join reachable on reachable.step_run_id = route.source_step_run_id
      where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id
        and route.target_step_run_id <> v_target_step_run.id
    )
    update process_step_runs step_run
    set status = 'skipped', due_at = null
    where step_run.workspace_id = p_workspace_id and step_run.process_run_id = p_process_run_id
      and step_run.status = 'pending' and step_run.parallel_branch_token = v_step_run.parallel_branch_token
      and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  end if;

  if v_target_step_run.node_type = 'parallel_join' then
    if v_step_run.parallel_branch_token is null then raise exception 'Only a parallel branch may arrive at a parallel join'; end if;
    update process_parallel_join_obligations
    set arrived_at = v_activation_at, arrival_source_step_run_id = p_step_run_id
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id
      and join_step_run_id = v_target_step_run.id and branch_token = v_step_run.parallel_branch_token and arrived_at is null;
    get diagnostics v_arrived_count = row_count;
    if v_arrived_count <> 1 then raise exception 'Parallel join obligation is not available'; end if;
    if not exists (select 1 from process_parallel_join_obligations where workspace_id = p_workspace_id and process_run_id = p_process_run_id and join_step_run_id = v_target_step_run.id and arrived_at is null) then
      perform private.activate_process_step_run(p_workspace_id, p_process_run_id, v_target_step_run.id, v_activation_at, null);
    end if;
  else
    perform private.activate_process_step_run(p_workspace_id, p_process_run_id, v_target_step_run.id, v_activation_at, v_step_run.parallel_branch_token);
  end if;
end;
$$;

-- 9. Record Activity read path. workspace_events stays exactly as closed
-- as 0064 left it -- no SELECT policy, no grant to authenticated -- this
-- SECURITY DEFINER RPC is the only way to read it, matching the notification
-- RPCs' own posture and deliberately not opening a general events explorer.
-- Authorization bar is identical to an ordinary record read today
-- (workspace membership only -- Kinema has no finer-grained record
-- visibility yet), never broader. Joins process_runs/process_step_runs for
-- their durable snapshot columns (process_template_name, step name,
-- assignee_label, approval_outcome_label, decided_by_label) rather than
-- duplicating any of them into event metadata -- see migration comment
-- above. actor_label prefers the durable decided_by_label snapshot
-- (approval_decided) and falls back to a live auth.users lookup (manual
-- process_started) -- both are null exactly when actor_user_id is null.
create function list_record_activity_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_record_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  event_type text,
  created_at timestamptz,
  actor_user_id uuid,
  actor_label text,
  process_run_id uuid,
  process_run_name text,
  process_step_run_id uuid,
  step_name text,
  assignee_label text,
  approval_outcome_label text,
  is_recurrence_started boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Activity limit must be between 1 and 100';
  end if;

  return query
  select
    e.id, e.event_type, e.created_at, e.actor_user_id,
    coalesce(step.decided_by_label, actor_user.email) as actor_label,
    e.process_run_id, run.process_template_name as process_run_name,
    e.process_step_run_id, step.name as step_name, step.assignee_label,
    step.approval_outcome_label,
    (run.originating_recurrence_occurrence_id is not null) as is_recurrence_started
  from workspace_events e
  left join process_runs run on run.workspace_id = e.workspace_id and run.id = e.process_run_id
  left join process_step_runs step on step.workspace_id = e.workspace_id and step.id = e.process_step_run_id
  left join auth.users actor_user on actor_user.id = e.actor_user_id
  where e.workspace_id = p_workspace_id
    and e.entity_type_id = p_entity_type_id
    and e.entity_record_id = p_entity_record_id
    and e.event_type in ('process_started', 'process_completed', 'step_assigned', 'approval_decided')
  order by e.created_at desc
  limit p_limit;
end;
$$;

revoke all on function list_record_activity_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_record_activity_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;
