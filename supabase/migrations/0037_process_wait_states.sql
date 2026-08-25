-- Process Graph 5C.2: durable timer-based waits. A wait remains an active
-- StepRun with a persisted UTC resume_at; it is never a user-completable task.

alter table process_nodes
  drop constraint if exists process_nodes_node_type_check,
  drop constraint if exists process_nodes_parallel_group_shape_check,
  drop constraint if exists process_nodes_system_metadata_check;

alter table process_nodes
  add constraint process_nodes_node_type_check
    check (node_type in ('human_task', 'approval', 'wait', 'parallel_split', 'parallel_join')),
  add constraint process_nodes_parallel_group_shape_check
    check (
      (node_type in ('human_task', 'approval', 'wait') and parallel_group_id is null)
      or (node_type in ('parallel_split', 'parallel_join') and parallel_group_id is not null)
    ),
  add constraint process_nodes_system_metadata_check
    check (
      node_type in ('human_task', 'approval', 'wait')
      or (assignee_user_id is null and config = '{}'::jsonb)
    );

alter table process_step_runs
  add column if not exists resume_at timestamptz;

alter table process_step_runs
  drop constraint if exists process_step_runs_node_type_check,
  drop constraint if exists process_step_runs_system_metadata_check,
  drop constraint if exists process_step_runs_wait_shape_check;

alter table process_step_runs
  add constraint process_step_runs_node_type_check
    check (node_type in ('human_task', 'approval', 'wait', 'parallel_split', 'parallel_join')),
  add constraint process_step_runs_system_metadata_check
    check (
      node_type in ('human_task', 'approval', 'wait')
      or (assignee_user_id is null and due_at is null and config = '{}'::jsonb and resume_at is null)
    ),
  add constraint process_step_runs_wait_shape_check
    check (
      (node_type <> 'wait' and resume_at is null)
      or (node_type = 'wait' and assignee_user_id is null and due_at is null
        and (
          (status in ('pending', 'skipped') and resume_at is null)
          or (status in ('active', 'completed') and resume_at is not null)
        ))
    );

create index if not exists process_step_runs_due_wait_idx
  on process_step_runs (resume_at, id)
  where node_type = 'wait' and status = 'active';

create or replace function private.validate_process_wait_rule(p_config jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule jsonb := p_config->'wait_rule';
  v_kind text;
  v_target text;
  v_amount integer;
  v_timezone text;
  v_time text;
  v_date text;
  v_ordinal integer;
  v_weekday integer;
begin
  if jsonb_typeof(v_rule) <> 'object' then raise exception 'Wait configuration is invalid'; end if;
  v_kind := v_rule->>'kind';
  v_timezone := nullif(trim(coalesce(v_rule->>'time_zone', '')), '');

  if v_kind = 'duration' then
    if v_rule - 'kind' - 'amount' - 'unit' - 'time_zone' <> '{}'::jsonb then raise exception 'Wait configuration is invalid'; end if;
    v_amount := nullif(v_rule->>'amount', '')::integer;
    if v_amount is null or v_amount < 1 or v_amount > 8760 then raise exception 'Wait duration must be between 1 and 8760'; end if;
    if v_rule->>'unit' = 'hours' then
      if v_timezone is not null then raise exception 'Elapsed-hour waits cannot specify a timezone'; end if;
      return;
    end if;
    if v_rule->>'unit' <> 'calendar_days' then raise exception 'Wait duration unit is invalid'; end if;
  elsif v_kind = 'weekdays' then
    if v_rule - 'kind' - 'amount' - 'time_zone' <> '{}'::jsonb then raise exception 'Wait configuration is invalid'; end if;
    v_amount := nullif(v_rule->>'amount', '')::integer;
    if v_amount is null or v_amount < 1 or v_amount > 8760 then raise exception 'Weekday wait must be between 1 and 8760'; end if;
  elsif v_kind = 'calendar_target' then
    if v_rule - 'kind' - 'target' - 'ordinal' - 'weekday' - 'date' - 'time' - 'time_zone' <> '{}'::jsonb then raise exception 'Wait configuration is invalid'; end if;
    v_target := v_rule->>'target';
    v_time := v_rule->>'time';
    if v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Wait target time is invalid'; end if;
    if v_target = 'nth_weekday_next_month' then
      v_ordinal := nullif(v_rule->>'ordinal', '')::integer;
      if v_ordinal is null or v_ordinal < 1 or v_ordinal > 20 then raise exception 'Wait weekday ordinal must be between 1 and 20'; end if;
    elsif v_target = 'first_day_of_week_next_month' then
      v_weekday := nullif(v_rule->>'weekday', '')::integer;
      if v_weekday is null or v_weekday < 0 or v_weekday > 6 then raise exception 'Wait weekday is invalid'; end if;
    elsif v_target = 'specific_datetime' then
      v_date := v_rule->>'date';
      if v_date !~ '^\\d{4}-\\d{2}-\\d{2}$' or to_char(to_date(v_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> v_date then raise exception 'Wait target date is invalid'; end if;
    else
      raise exception 'Wait calendar target is invalid';
    end if;
  else
    raise exception 'Wait mode is invalid';
  end if;

  if v_timezone is null or not exists (select 1 from pg_timezone_names where name = v_timezone) then
    raise exception 'Wait timezone is invalid';
  end if;
end;
$$;

create or replace function private.process_wait_resume_at_from_config(
  p_config jsonb,
  p_activation_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule jsonb := p_config->'wait_rule';
  v_local timestamp;
  v_local_date date;
  v_target_date date;
  v_timezone text;
  v_amount integer;
  v_count integer := 0;
  v_weekday integer;
begin
  perform private.validate_process_wait_rule(p_config);
  if v_rule->>'kind' = 'duration' and v_rule->>'unit' = 'hours' then
    return p_activation_at + make_interval(hours => (v_rule->>'amount')::integer);
  end if;

  v_timezone := v_rule->>'time_zone';
  v_local := p_activation_at at time zone v_timezone;
  v_local_date := v_local::date;
  v_amount := nullif(v_rule->>'amount', '')::integer;

  if v_rule->>'kind' = 'duration' then
    return ((v_local_date + v_amount)::timestamp + v_local::time) at time zone v_timezone;
  end if;

  if v_rule->>'kind' = 'weekdays' then
    v_target_date := v_local_date;
    while v_count < v_amount loop
      v_target_date := v_target_date + 1;
      if extract(dow from v_target_date) between 1 and 5 then v_count := v_count + 1; end if;
    end loop;
    return (v_target_date::timestamp + v_local::time) at time zone v_timezone;
  end if;

  if v_rule->>'target' = 'specific_datetime' then
    return ((v_rule->>'date')::date::timestamp + (v_rule->>'time')::time) at time zone v_timezone;
  end if;

  v_target_date := (date_trunc('month', v_local_date)::date + interval '1 month')::date;
  if v_rule->>'target' = 'nth_weekday_next_month' then
    while v_count < (v_rule->>'ordinal')::integer loop
      if extract(dow from v_target_date) between 1 and 5 then v_count := v_count + 1; end if;
      if v_count < (v_rule->>'ordinal')::integer then v_target_date := v_target_date + 1; end if;
    end loop;
  else
    v_weekday := (v_rule->>'weekday')::integer;
    while extract(dow from v_target_date) <> v_weekday loop v_target_date := v_target_date + 1; end loop;
  end if;
  return (v_target_date::timestamp + (v_rule->>'time')::time) at time zone v_timezone;
end;
$$;

-- Preserve the prior, fully validated editor transaction as an internal
-- implementation. The new wrapper validates/normalizes wait nodes around it.
alter function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb)
  rename to save_process_template_authorized_pre_wait;
alter function save_process_template_authorized_pre_wait(uuid, uuid, text, text, uuid, jsonb)
  set schema private;

create function save_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_name text,
  p_description text,
  p_applies_to_entity_type_id uuid,
  p_steps jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_wait_steps jsonb := '[]'::jsonb;
  v_index integer;
  v_template_id uuid;
  v_node_id uuid;
  v_node_type text;
  v_wait_rule jsonb;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then raise exception 'A process template requires valid steps'; end if;

  for v_index in 1 .. jsonb_array_length(p_steps) loop
    v_step := p_steps->(v_index - 1);
    if jsonb_typeof(v_step) <> 'object' or v_step - 'client_key' - 'node_id' - 'node_type' - 'parallel_group_id' - 'name' - 'assignee_user_id' - 'due_rule' - 'wait_rule' - 'routes' <> '{}'::jsonb then raise exception 'Process step configuration is invalid'; end if;
    v_node_type := coalesce(nullif(v_step->>'node_type', ''), 'human_task');
    v_wait_rule := v_step->'wait_rule';
    if v_node_type = 'wait' then
      if nullif(trim(coalesce(v_step->>'name', '')), '') is null then raise exception 'Every process node requires a name'; end if;
      if nullif(v_step->>'assignee_user_id', '') is not null or (v_step->'due_rule' is not null and v_step->'due_rule' <> 'null'::jsonb) then raise exception 'Wait nodes cannot have an assignee or due rule'; end if;
      perform private.validate_process_wait_rule(jsonb_build_object('wait_rule', v_wait_rule));
      v_wait_steps := v_wait_steps || jsonb_build_array(jsonb_build_object('position', v_index, 'wait_rule', v_wait_rule));
      v_normalized := v_normalized || jsonb_build_array((v_step - 'wait_rule' - 'due_rule') || jsonb_build_object('node_type', 'human_task', 'due_rule', null));
    else
      if v_wait_rule is not null and v_wait_rule <> 'null'::jsonb then raise exception 'Only wait nodes can configure a wait rule'; end if;
      v_normalized := v_normalized || jsonb_build_array(v_step - 'wait_rule');
    end if;
  end loop;

  v_template_id := private.save_process_template_authorized_pre_wait(
    p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, v_normalized
  );

  for v_step in select * from jsonb_array_elements(v_wait_steps) loop
    select id into v_node_id from process_nodes
    where workspace_id = p_workspace_id and process_template_id = v_template_id and position = (v_step->>'position')::integer
    for update;
    if not found then raise exception 'Wait node was not saved'; end if;
    update process_nodes
    set node_type = 'wait', assignee_user_id = null, config = jsonb_build_object('wait_rule', v_step->'wait_rule'), updated_at = now()
    where workspace_id = p_workspace_id and id = v_node_id;
  end loop;

  perform private.validate_process_parallel_template(p_workspace_id, v_template_id);
  perform private.validate_process_approval_template(p_workspace_id, v_template_id);
  return v_template_id;
end;
$$;

create or replace function private.activate_process_step_run(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_activation_at timestamptz,
  p_parallel_branch_token uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_step process_step_runs%rowtype;
begin
  select * into v_step from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.status <> 'pending' then raise exception 'Process route target is not available'; end if;
  if v_step.parallel_branch_token is not null and p_parallel_branch_token is not null and v_step.parallel_branch_token <> p_parallel_branch_token then raise exception 'Process branch token does not match its target'; end if;
  update process_step_runs
  set status = 'active', started_at = p_activation_at,
    due_at = case when v_step.node_type in ('human_task', 'approval') then private.process_due_at_from_config(v_step.config, p_activation_at) else null end,
    resume_at = case when v_step.node_type = 'wait' then private.process_wait_resume_at_from_config(v_step.config, p_activation_at) else null end,
    parallel_branch_token = coalesce(v_step.parallel_branch_token, p_parallel_branch_token)
  where workspace_id = p_workspace_id and id = p_step_run_id;
  if v_step.node_type not in ('human_task', 'approval', 'wait') then
    perform private.advance_process_system_step(p_workspace_id, p_process_run_id, p_step_run_id, p_activation_at);
  end if;
end;
$$;

create or replace function private.resume_process_wait_step(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_resumed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step process_step_runs%rowtype;
  v_run process_runs%rowtype;
  v_route process_step_run_routes%rowtype;
  v_target process_step_runs%rowtype;
  v_default process_step_run_routes%rowtype;
  v_route_count integer;
  v_default_count integer;
  v_evaluation jsonb;
  v_conditions jsonb := '[]'::jsonb;
  v_outcome text;
  v_arrived integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));
  select * into v_run from process_runs where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active' for update;
  if not found then return false; end if;
  select * into v_step from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.node_type <> 'wait' or v_step.status <> 'active' or v_step.resume_at is null or v_step.resume_at > p_resumed_at then return false; end if;
  perform 1 from entity_records where workspace_id = p_workspace_id and entity_type_id = v_run.origin_entity_type_id and id = v_run.origin_record_id and archived_at is null for share;
  if not found then raise exception 'Origin record not found or archived'; end if;
  select count(*), count(*) filter (where is_default) into v_route_count, v_default_count from process_step_run_routes where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = v_step.id;
  if v_route_count = 0 then
    update process_step_runs set status = 'completed', completed_at = p_resumed_at, routing_result = jsonb_build_object('outcome', 'unconditional', 'evaluatedAt', p_resumed_at) where workspace_id = p_workspace_id and id = v_step.id;
    perform private.try_complete_process_run(p_workspace_id, p_process_run_id, p_resumed_at);
    return true;
  end if;
  if v_default_count <> 1 then raise exception 'Process route configuration has no unambiguous default'; end if;
  select * into v_default from process_step_run_routes where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = v_step.id and is_default;
  if v_route_count = 1 then
    v_route := v_default; v_outcome := 'unconditional';
  else
    for v_route in select * from process_step_run_routes where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = v_step.id and not is_default order by priority loop
      v_evaluation := private.evaluate_process_branch_conditions(p_workspace_id, v_run.origin_entity_type_id, v_run.origin_record_id, v_route.condition_config);
      v_conditions := v_conditions || coalesce(v_evaluation->'conditions', '[]'::jsonb);
      if coalesce((v_evaluation->>'matched')::boolean, false) then v_outcome := 'matched_condition'; exit; end if;
    end loop;
    if v_outcome is null then v_route := v_default; v_outcome := 'default_fallback'; end if;
  end if;
  select * into v_target from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_route.target_step_run_id for update;
  if not found or v_target.status <> 'pending' then raise exception 'Process route target is not available'; end if;
  update process_step_runs set status = 'completed', completed_at = p_resumed_at, routing_result = jsonb_build_object('selectedRouteId', v_route.id, 'targetStepRunId', v_target.id, 'outcome', v_outcome, 'evaluatedAt', p_resumed_at, 'evaluatedConditions', v_conditions) where workspace_id = p_workspace_id and id = v_step.id;
  if v_step.parallel_branch_token is null then
    with recursive reachable(step_run_id) as (select v_target.id union select route.target_step_run_id from process_step_run_routes route join reachable on reachable.step_run_id = route.source_step_run_id where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id)
    update process_step_runs step_run set status = 'skipped', due_at = null, resume_at = null where step_run.workspace_id = p_workspace_id and step_run.process_run_id = p_process_run_id and step_run.status = 'pending' and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  else
    with recursive reachable(step_run_id) as (select v_target.id union select route.target_step_run_id from process_step_run_routes route join reachable on reachable.step_run_id = route.source_step_run_id where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id and route.target_step_run_id <> v_target.id)
    update process_step_runs step_run set status = 'skipped', due_at = null, resume_at = null where step_run.workspace_id = p_workspace_id and step_run.process_run_id = p_process_run_id and step_run.status = 'pending' and step_run.parallel_branch_token = v_step.parallel_branch_token and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  end if;
  if v_target.node_type = 'parallel_join' then
    if v_step.parallel_branch_token is null then raise exception 'Only a parallel branch may arrive at a parallel join'; end if;
    update process_parallel_join_obligations set arrived_at = p_resumed_at, arrival_source_step_run_id = v_step.id where workspace_id = p_workspace_id and process_run_id = p_process_run_id and join_step_run_id = v_target.id and branch_token = v_step.parallel_branch_token and arrived_at is null;
    get diagnostics v_arrived = row_count;
    if v_arrived <> 1 then raise exception 'Parallel join obligation is not available'; end if;
    if not exists (select 1 from process_parallel_join_obligations where workspace_id = p_workspace_id and process_run_id = p_process_run_id and join_step_run_id = v_target.id and arrived_at is null) then perform private.activate_process_step_run(p_workspace_id, p_process_run_id, v_target.id, p_resumed_at, null); end if;
  else
    perform private.activate_process_step_run(p_workspace_id, p_process_run_id, v_target.id, p_resumed_at, v_step.parallel_branch_token);
  end if;
  return true;
end;
$$;

create function resume_due_process_waits_system(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step record;
  v_now timestamptz := clock_timestamp();
  v_resumed integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'Wait batch limit must be between 1 and 500'; end if;
  for v_step in
    select workspace_id, process_run_id, id
    from process_step_runs
    where node_type = 'wait' and status = 'active' and resume_at <= v_now
    order by resume_at, id
    limit p_limit
    for update skip locked
  loop
    begin
      if private.resume_process_wait_step(v_step.workspace_id, v_step.process_run_id, v_step.id, v_now) then v_resumed := v_resumed + 1; else v_skipped := v_skipped + 1; end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('resumed', v_resumed, 'skipped', v_skipped, 'failed', v_failed);
end;
$$;

revoke all on function private.validate_process_wait_rule(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.process_wait_resume_at_from_config(jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.save_process_template_authorized_pre_wait(uuid, uuid, text, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.activate_process_step_run(uuid, uuid, uuid, timestamptz, uuid) from public, anon, authenticated, service_role;
revoke all on function private.resume_process_wait_step(uuid, uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public, anon;
revoke all on function resume_due_process_waits_system(integer) from public, anon, authenticated;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function resume_due_process_waits_system(integer) to service_role;

comment on column process_step_runs.resume_at is
  'UTC timestamp resolved once when a wait StepRun becomes active; scheduler discovery never reads live template configuration.';
