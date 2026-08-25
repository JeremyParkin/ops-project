-- Process Graph 5C.3: durable condition/event waits. Dependencies describe
-- what an active StepRun watches; wakeups are a separate transactional outbox.
-- Record triggers only enqueue changes. The service-only dispatcher evaluates
-- current values and reuses the shared process continuation below.

alter table process_nodes
  drop constraint if exists process_nodes_node_type_check,
  drop constraint if exists process_nodes_parallel_group_shape_check,
  drop constraint if exists process_nodes_system_metadata_check;

alter table process_nodes
  add constraint process_nodes_node_type_check
    check (node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'parallel_split', 'parallel_join')),
  add constraint process_nodes_parallel_group_shape_check
    check (
      (node_type in ('human_task', 'approval', 'wait', 'condition_wait') and parallel_group_id is null)
      or (node_type in ('parallel_split', 'parallel_join') and parallel_group_id is not null)
    ),
  add constraint process_nodes_system_metadata_check
    check (
      node_type in ('human_task', 'approval', 'wait', 'condition_wait')
      or (assignee_user_id is null and config = '{}'::jsonb)
    );

alter table process_step_runs
  add column if not exists condition_wait_result jsonb;

alter table process_step_runs
  drop constraint if exists process_step_runs_node_type_check,
  drop constraint if exists process_step_runs_system_metadata_check,
  drop constraint if exists process_step_runs_wait_shape_check,
  drop constraint if exists process_step_runs_condition_wait_shape_check;

alter table process_step_runs
  add constraint process_step_runs_node_type_check
    check (node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'parallel_split', 'parallel_join')),
  add constraint process_step_runs_system_metadata_check
    check (
      node_type in ('human_task', 'approval', 'wait', 'condition_wait')
      or (assignee_user_id is null and due_at is null and config = '{}'::jsonb and resume_at is null)
    ),
  add constraint process_step_runs_wait_shape_check
    check (
      (node_type <> 'wait' and resume_at is null)
      or (node_type = 'wait' and assignee_user_id is null and due_at is null
        and ((status in ('pending', 'skipped') and resume_at is null) or (status in ('active', 'completed') and resume_at is not null)))
    ),
  add constraint process_step_runs_condition_wait_shape_check
    check (
      (node_type <> 'condition_wait' and condition_wait_result is null)
      or (node_type = 'condition_wait' and assignee_user_id is null and due_at is null and resume_at is null
        and ((status in ('pending', 'skipped') and condition_wait_result is null) or status in ('active', 'completed')))
    );

create table process_condition_wait_dependencies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_run_id uuid not null,
  step_run_id uuid not null,
  dependency_kind text not null check (dependency_kind in ('target_field', 'relation_binding')),
  watched_entity_type_id uuid not null,
  watched_record_id uuid not null,
  field_definition_id uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, step_run_id, dependency_kind, watched_record_id, field_definition_id),
  foreign key (workspace_id, process_run_id, step_run_id)
    references process_step_runs(workspace_id, process_run_id, id) on delete cascade,
  foreign key (workspace_id, watched_entity_type_id, watched_record_id)
    references entity_records(workspace_id, entity_type_id, id) on delete cascade,
  foreign key (workspace_id, field_definition_id)
    references field_definitions(workspace_id, id) on delete restrict
);

create index process_condition_wait_dependencies_watched_record_idx
  on process_condition_wait_dependencies (workspace_id, watched_entity_type_id, watched_record_id, field_definition_id);

create table process_condition_wait_wakeups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type_id uuid not null,
  record_id uuid not null,
  field_definition_id uuid,
  reason text not null check (reason in ('record_changed', 'relation_changed', 'field_lifecycle')),
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  foreign key (workspace_id, entity_type_id, record_id)
    references entity_records(workspace_id, entity_type_id, id) on delete cascade,
  foreign key (workspace_id, field_definition_id)
    references field_definitions(workspace_id, id) on delete cascade
);

create index process_condition_wait_wakeups_dispatch_idx
  on process_condition_wait_wakeups (created_at, id);

create or replace function private.validate_process_condition_wait_rule(
  p_workspace_id uuid,
  p_origin_entity_type_id uuid,
  p_config jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule jsonb := p_config->'condition_wait_rule';
  v_target jsonb;
  v_target_entity_type_id uuid;
  v_relation_field_id uuid;
  v_related_entity_type_id uuid;
begin
  if p_config - 'condition_wait_rule' <> '{}'::jsonb or jsonb_typeof(v_rule) <> 'object'
    or v_rule - 'target' - 'conditions' <> '{}'::jsonb
    or jsonb_typeof(v_rule->'target') <> 'object' or jsonb_typeof(v_rule->'conditions') <> 'array'
    or jsonb_array_length(v_rule->'conditions') = 0 then
    raise exception 'Condition wait configuration is invalid';
  end if;

  v_target := v_rule->'target';
  if v_target->>'kind' = 'origin' and v_target - 'kind' = '{}'::jsonb then
    v_target_entity_type_id := p_origin_entity_type_id;
  elsif v_target->>'kind' = 'related'
    and v_target - 'kind' - 'relation_field_definition_id' - 'target_entity_type_id' = '{}'::jsonb then
    v_relation_field_id := nullif(v_target->>'relation_field_definition_id', '')::uuid;
    v_target_entity_type_id := nullif(v_target->>'target_entity_type_id', '')::uuid;
    select related_entity_type_id into v_related_entity_type_id
    from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_origin_entity_type_id and id = v_relation_field_id
      and type = 'relation' and archived_at is null;
    if not found or v_related_entity_type_id <> v_target_entity_type_id then
      raise exception 'Condition wait relation target is invalid';
    end if;
  else
    raise exception 'Condition wait target is invalid';
  end if;

  if not exists (select 1 from entity_types where workspace_id = p_workspace_id and id = v_target_entity_type_id and archived_at is null) then
    raise exception 'Condition wait target entity is not active';
  end if;
  perform private.validate_process_branch_conditions(p_workspace_id, v_target_entity_type_id, v_rule->'conditions');
end;
$$;

alter function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb)
  rename to save_process_template_authorized_pre_condition_wait;

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
  v_condition_steps jsonb := '[]'::jsonb;
  v_template_id uuid;
  v_node_id uuid;
  v_index integer := 0;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Process steps must be an array'; end if;
  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_index := v_index + 1;
    if v_step->>'node_type' = 'condition_wait' then
      perform private.validate_process_condition_wait_rule(
        p_workspace_id,
        p_applies_to_entity_type_id,
        jsonb_build_object('condition_wait_rule', v_step->'condition_wait_rule')
      );
      if coalesce(nullif(trim(v_step->>'assignee_user_id'), ''), '') <> ''
        or coalesce(v_step->'due_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'wait_rule', 'null'::jsonb) <> 'null'::jsonb then
        raise exception 'Condition waits cannot have an assignee, due rule, or timer rule';
      end if;
      v_condition_steps := v_condition_steps || jsonb_build_array(jsonb_build_object('position', v_index, 'config', jsonb_build_object('condition_wait_rule', v_step->'condition_wait_rule')));
      v_normalized := v_normalized || jsonb_build_array((v_step - 'condition_wait_rule') || jsonb_build_object('node_type', 'human_task'));
    else
      v_normalized := v_normalized || jsonb_build_array(v_step - 'condition_wait_rule');
    end if;
  end loop;

  v_template_id := save_process_template_authorized_pre_condition_wait(
    p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, v_normalized
  );
  for v_step in select * from jsonb_array_elements(v_condition_steps) loop
    select id into v_node_id from process_nodes
    where workspace_id = p_workspace_id and process_template_id = v_template_id and position = (v_step->>'position')::integer for update;
    if not found then raise exception 'Condition wait node was not saved'; end if;
    update process_nodes
    set node_type = 'condition_wait', assignee_user_id = null, config = v_step->'config', updated_at = now()
    where workspace_id = p_workspace_id and id = v_node_id;
  end loop;
  return v_template_id;
end;
$$;

create or replace function private.enqueue_process_condition_wait_wakeup(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_field_definition_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into process_condition_wait_wakeups (
    workspace_id, entity_type_id, record_id, field_definition_id, reason
  ) values (
    p_workspace_id, p_entity_type_id, p_record_id, p_field_definition_id, p_reason
  );
end;
$$;

create or replace function private.enqueue_process_condition_wait_record_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.enqueue_process_condition_wait_wakeup(NEW.workspace_id, NEW.entity_type_id, NEW.id, null, 'record_changed');
  return NEW;
end;
$$;

create or replace function private.enqueue_process_condition_wait_relation_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row entity_record_relation_values%rowtype;
begin
  v_row := case when TG_OP = 'DELETE' then OLD else NEW end;
  -- Workspace cascades can delete relation rows after the parent workspace
  -- is gone. Normal relation replacement/clearing still needs a wakeup.
  if not exists (select 1 from workspaces where id = v_row.workspace_id) then
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
  end if;
  perform private.enqueue_process_condition_wait_wakeup(v_row.workspace_id, v_row.source_entity_type_id, v_row.source_record_id, v_row.field_definition_id, 'relation_changed');
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

create or replace function private.enqueue_process_condition_wait_field_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into process_condition_wait_wakeups (workspace_id, entity_type_id, record_id, field_definition_id, reason)
  select distinct dependency.workspace_id, dependency.watched_entity_type_id, dependency.watched_record_id, NEW.id, 'field_lifecycle'
  from process_condition_wait_dependencies dependency
  where dependency.workspace_id = NEW.workspace_id and dependency.field_definition_id = NEW.id;
  return NEW;
end;
$$;

drop trigger if exists entity_records_process_condition_wait_wakeup on entity_records;
create trigger entity_records_process_condition_wait_wakeup
after insert or update of values, archived_at on entity_records
for each row execute function private.enqueue_process_condition_wait_record_change();

drop trigger if exists entity_record_relation_values_process_condition_wait_wakeup on entity_record_relation_values;
create trigger entity_record_relation_values_process_condition_wait_wakeup
after insert or update or delete on entity_record_relation_values
for each row execute function private.enqueue_process_condition_wait_relation_change();

drop trigger if exists field_definitions_process_condition_wait_wakeup on field_definitions;
create trigger field_definitions_process_condition_wait_wakeup
after update of archived_at on field_definitions
for each row when (OLD.archived_at is distinct from NEW.archived_at)
execute function private.enqueue_process_condition_wait_field_change();

create or replace function private.clear_process_condition_wait_dependencies()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if OLD.status = 'active' and NEW.status <> 'active' then
    delete from process_condition_wait_dependencies
    where workspace_id = OLD.workspace_id and step_run_id = OLD.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists process_step_runs_clear_condition_wait_dependencies on process_step_runs;
create trigger process_step_runs_clear_condition_wait_dependencies
after update of status on process_step_runs
for each row execute function private.clear_process_condition_wait_dependencies();

-- One canonical continuation for automatic waits. It selects the run-scoped
-- route snapshot, skips only unreachable pending work, preserves branch tokens,
-- and satisfies a join obligation exactly once when appropriate.
create or replace function private.complete_process_step_and_advance(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_completed_at timestamptz,
  p_outcome text,
  p_evaluated_conditions jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run process_runs%rowtype;
  v_step process_step_runs%rowtype;
  v_route process_step_run_routes%rowtype;
  v_default process_step_run_routes%rowtype;
  v_target process_step_runs%rowtype;
  v_route_count integer;
  v_default_count integer;
  v_evaluation jsonb;
  v_conditions jsonb := coalesce(p_evaluated_conditions, '[]'::jsonb);
  v_outcome text := p_outcome;
  v_arrived integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));
  select * into v_run from process_runs where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active' for update;
  if not found then return false; end if;
  select * into v_step from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.status <> 'active' then return false; end if;
  perform 1 from entity_records where workspace_id = p_workspace_id and entity_type_id = v_run.origin_entity_type_id and id = v_run.origin_record_id and archived_at is null for share;
  if not found then raise exception 'Origin record not found or archived'; end if;

  select count(*), count(*) filter (where is_default) into v_route_count, v_default_count
  from process_step_run_routes where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = v_step.id;
  if v_route_count = 0 then
    update process_step_runs set status = 'completed', completed_at = p_completed_at,
      routing_result = jsonb_build_object('outcome', v_outcome, 'evaluatedAt', p_completed_at, 'evaluatedConditions', v_conditions)
    where workspace_id = p_workspace_id and id = v_step.id;
    perform private.try_complete_process_run(p_workspace_id, p_process_run_id, p_completed_at);
    return true;
  end if;
  if v_default_count <> 1 then raise exception 'Process route configuration has no unambiguous default'; end if;
  select * into v_default from process_step_run_routes where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = v_step.id and is_default;
  if v_route_count = 1 then
    v_route := v_default;
    if v_outcome is null then v_outcome := 'unconditional'; end if;
  else
    for v_route in select * from process_step_run_routes where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = v_step.id and not is_default order by priority loop
      v_evaluation := private.evaluate_process_branch_conditions(p_workspace_id, v_run.origin_entity_type_id, v_run.origin_record_id, v_route.condition_config);
      v_conditions := v_conditions || coalesce(v_evaluation->'conditions', '[]'::jsonb);
      if coalesce((v_evaluation->>'matched')::boolean, false) then
        if v_outcome is null then v_outcome := 'matched_condition'; end if;
        exit;
      end if;
    end loop;
    if v_route.id is null or not coalesce((v_evaluation->>'matched')::boolean, false) then
      v_route := v_default;
      if v_outcome is null then v_outcome := 'default_fallback'; end if;
    end if;
  end if;
  select * into v_target from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_route.target_step_run_id for update;
  if not found or v_target.status <> 'pending' then raise exception 'Process route target is not available'; end if;
  update process_step_runs set status = 'completed', completed_at = p_completed_at,
    routing_result = jsonb_build_object('selectedRouteId', v_route.id, 'targetStepRunId', v_target.id, 'outcome', coalesce(v_outcome, 'unconditional'), 'evaluatedAt', p_completed_at, 'evaluatedConditions', v_conditions)
  where workspace_id = p_workspace_id and id = v_step.id;
  if v_step.parallel_branch_token is null then
    with recursive reachable(step_run_id) as (select v_target.id union select route.target_step_run_id from process_step_run_routes route join reachable on reachable.step_run_id = route.source_step_run_id where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id)
    update process_step_runs step_run set status = 'skipped', due_at = null, resume_at = null, condition_wait_result = null
    where step_run.workspace_id = p_workspace_id and step_run.process_run_id = p_process_run_id and step_run.status = 'pending' and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  else
    with recursive reachable(step_run_id) as (select v_target.id union select route.target_step_run_id from process_step_run_routes route join reachable on reachable.step_run_id = route.source_step_run_id where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id and route.target_step_run_id <> v_target.id)
    update process_step_runs step_run set status = 'skipped', due_at = null, resume_at = null, condition_wait_result = null
    where step_run.workspace_id = p_workspace_id and step_run.process_run_id = p_process_run_id and step_run.status = 'pending' and step_run.parallel_branch_token = v_step.parallel_branch_token and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  end if;
  if v_target.node_type = 'parallel_join' then
    if v_step.parallel_branch_token is null then raise exception 'Only a parallel branch may arrive at a parallel join'; end if;
    update process_parallel_join_obligations set arrived_at = p_completed_at, arrival_source_step_run_id = v_step.id
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id and join_step_run_id = v_target.id and branch_token = v_step.parallel_branch_token and arrived_at is null;
    get diagnostics v_arrived = row_count;
    if v_arrived <> 1 then raise exception 'Parallel join obligation is not available'; end if;
    if not exists (select 1 from process_parallel_join_obligations where workspace_id = p_workspace_id and process_run_id = p_process_run_id and join_step_run_id = v_target.id and arrived_at is null) then
      perform private.activate_process_step_run(p_workspace_id, p_process_run_id, v_target.id, p_completed_at, null);
    end if;
  else
    perform private.activate_process_step_run(p_workspace_id, p_process_run_id, v_target.id, p_completed_at, v_step.parallel_branch_token);
  end if;
  return true;
end;
$$;

create or replace function private.evaluate_process_condition_wait(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_evaluated_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run process_runs%rowtype;
  v_step process_step_runs%rowtype;
  v_rule jsonb;
  v_target jsonb;
  v_target_entity_type_id uuid;
  v_target_record_id uuid;
  v_relation_field_id uuid;
  v_related_entity_type_id uuid;
  v_evaluation jsonb;
  v_message text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));
  select * into v_run from process_runs where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active' for update;
  if not found then return false; end if;
  select * into v_step from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.status <> 'active' or v_step.node_type <> 'condition_wait' then return false; end if;
  perform 1 from entity_records where workspace_id = p_workspace_id and entity_type_id = v_run.origin_entity_type_id and id = v_run.origin_record_id and archived_at is null for share;
  if not found then raise exception 'Origin record not found or archived'; end if;
  v_rule := v_step.config->'condition_wait_rule';
  begin
    perform private.validate_process_condition_wait_rule(p_workspace_id, v_run.origin_entity_type_id, jsonb_build_object('condition_wait_rule', v_rule));
  exception when others then
    update process_step_runs
    set condition_wait_result = jsonb_build_object('status', 'blocked', 'evaluatedAt', p_evaluated_at, 'message', SQLERRM)
    where workspace_id = p_workspace_id and id = v_step.id;
    return false;
  end;
  v_target := v_rule->'target';

  -- Hold the origin/relation/target row locks before replacing dependencies and
  -- evaluating. A competing canonical write waits, then emits a wakeup after
  -- the rows are registered; a prior writer is visible to this evaluation.
  if v_target->>'kind' = 'origin' then
    v_target_entity_type_id := v_run.origin_entity_type_id;
    v_target_record_id := v_run.origin_record_id;
  else
    v_relation_field_id := (v_target->>'relation_field_definition_id')::uuid;
    v_target_entity_type_id := (v_target->>'target_entity_type_id')::uuid;
    select related_entity_type_id into v_related_entity_type_id from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = v_run.origin_entity_type_id and id = v_relation_field_id and type = 'relation' and archived_at is null;
    if not found or v_related_entity_type_id <> v_target_entity_type_id then
      v_message := 'The configured relation field is archived or invalid.';
    else
      select target_record_id into v_target_record_id from entity_record_relation_values
      where workspace_id = p_workspace_id and source_entity_type_id = v_run.origin_entity_type_id and source_record_id = v_run.origin_record_id and field_definition_id = v_relation_field_id for share;
      if not found then v_message := 'Waiting for the related record to be selected.'; end if;
    end if;
  end if;

  if v_target_record_id is not null then
    perform 1 from entity_records where workspace_id = p_workspace_id and entity_type_id = v_target_entity_type_id and id = v_target_record_id and archived_at is null for share;
    if not found then v_message := 'The related record is archived or unavailable.'; end if;
  end if;

  delete from process_condition_wait_dependencies where workspace_id = p_workspace_id and step_run_id = v_step.id;
  if v_target->>'kind' = 'related' then
    insert into process_condition_wait_dependencies (workspace_id, process_run_id, step_run_id, dependency_kind, watched_entity_type_id, watched_record_id, field_definition_id)
    values (p_workspace_id, p_process_run_id, v_step.id, 'relation_binding', v_run.origin_entity_type_id, v_run.origin_record_id, v_relation_field_id);
  end if;
  if v_target_record_id is not null then
    insert into process_condition_wait_dependencies (workspace_id, process_run_id, step_run_id, dependency_kind, watched_entity_type_id, watched_record_id, field_definition_id)
    select p_workspace_id, p_process_run_id, v_step.id, 'target_field', v_target_entity_type_id, v_target_record_id, (condition->>'sourceFieldDefinitionId')::uuid
    from jsonb_array_elements(v_rule->'conditions') condition;
  end if;

  if v_message is not null then
    update process_step_runs set condition_wait_result = jsonb_build_object('status', 'blocked', 'evaluatedAt', p_evaluated_at, 'message', v_message)
    where workspace_id = p_workspace_id and id = v_step.id;
    return false;
  end if;

  v_evaluation := private.evaluate_process_branch_conditions(p_workspace_id, v_target_entity_type_id, v_target_record_id, v_rule->'conditions');
  if coalesce((v_evaluation->>'matched')::boolean, false) then
    delete from process_condition_wait_dependencies where workspace_id = p_workspace_id and step_run_id = v_step.id;
    perform private.complete_process_step_and_advance(p_workspace_id, p_process_run_id, v_step.id, p_evaluated_at, 'condition_satisfied', coalesce(v_evaluation->'conditions', '[]'::jsonb));
    return true;
  end if;
  update process_step_runs set condition_wait_result = jsonb_build_object('status', 'waiting', 'evaluatedAt', p_evaluated_at, 'targetRecordId', v_target_record_id)
  where workspace_id = p_workspace_id and id = v_step.id;
  return false;
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
  update process_step_runs set status = 'active', started_at = p_activation_at,
    due_at = case when v_step.node_type in ('human_task', 'approval') then private.process_due_at_from_config(v_step.config, p_activation_at) else null end,
    resume_at = case when v_step.node_type = 'wait' then private.process_wait_resume_at_from_config(v_step.config, p_activation_at) else null end,
    parallel_branch_token = coalesce(v_step.parallel_branch_token, p_parallel_branch_token)
  where workspace_id = p_workspace_id and id = p_step_run_id;
  if v_step.node_type = 'condition_wait' then
    perform private.evaluate_process_condition_wait(p_workspace_id, p_process_run_id, p_step_run_id, p_activation_at);
  elsif v_step.node_type not in ('human_task', 'approval', 'wait') then
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
declare v_step process_step_runs%rowtype;
begin
  select * into v_step from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.node_type <> 'wait' or v_step.status <> 'active' or v_step.resume_at is null or v_step.resume_at > p_resumed_at then return false; end if;
  return private.complete_process_step_and_advance(p_workspace_id, p_process_run_id, p_step_run_id, p_resumed_at, null, '[]'::jsonb);
end;
$$;

create function dispatch_process_condition_wait_wakeups_system(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wakeup process_condition_wait_wakeups%rowtype;
  v_dependency record;
  v_processed integer := 0;
  v_resolved integer := 0;
  v_failed integer := 0;
  v_has_failure boolean;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'Wakeup batch limit must be between 1 and 500'; end if;
  for v_wakeup in select * from process_condition_wait_wakeups order by created_at, id limit p_limit for update skip locked loop
    v_has_failure := false;
    for v_dependency in
      select distinct dependency.workspace_id, dependency.process_run_id, dependency.step_run_id
      from process_condition_wait_dependencies dependency
      join process_step_runs step on step.workspace_id = dependency.workspace_id and step.id = dependency.step_run_id
      where dependency.workspace_id = v_wakeup.workspace_id and dependency.watched_entity_type_id = v_wakeup.entity_type_id and dependency.watched_record_id = v_wakeup.record_id
        and (v_wakeup.field_definition_id is null or dependency.field_definition_id = v_wakeup.field_definition_id)
        and step.status = 'active' and step.node_type = 'condition_wait'
    loop
      begin
        if private.evaluate_process_condition_wait(v_dependency.workspace_id, v_dependency.process_run_id, v_dependency.step_run_id, clock_timestamp()) then v_resolved := v_resolved + 1; end if;
      exception when others then
        v_has_failure := true;
      end;
    end loop;
    if v_has_failure then
      update process_condition_wait_wakeups set attempts = attempts + 1, last_error = 'Condition wait evaluation failed' where id = v_wakeup.id;
      v_failed := v_failed + 1;
    else
      delete from process_condition_wait_wakeups where id = v_wakeup.id;
      v_processed := v_processed + 1;
    end if;
  end loop;
  return jsonb_build_object('processed', v_processed, 'resolved', v_resolved, 'failed', v_failed);
end;
$$;

-- Extend the 5A safe-delete count with template and unresolved run snapshots
-- for condition-wait target fields and related-field bindings.
drop function if exists delete_field_definition_if_safe_authorized(uuid, uuid, uuid);
drop function if exists delete_field_definition_if_safe(uuid, uuid, uuid);
create function delete_field_definition_if_safe(
  p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid
)
returns table (
  deleted boolean, record_value_count bigint, relation_value_count bigint,
  workflow_reference_count bigint, display_field_reference_count bigint,
  view_reference_count bigint, process_branch_reference_count bigint
)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_field field_definitions%rowtype;
  v_template_token text;
  v_process_branch_reference_count bigint := 0;
begin
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found.'; end if;

  select count(*) into record_value_count from entity_records
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and values ? v_field.key;
  select count(*) into relation_value_count from entity_record_relation_values
  where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and field_definition_id = p_field_definition_id;
  select count(*) into display_field_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id and display_field_definition_id = p_field_definition_id;
  v_template_token := '{{field:' || p_field_definition_id::text || '}}';
  select count(*) into workflow_reference_count from workflows workflow
  where workflow.workspace_id = p_workspace_id and (
    exists (select 1 from jsonb_array_elements_text(coalesce(workflow.action_config #> '{triggerConfig,watchedFieldDefinitionIds}', '[]'::jsonb)) watched(field_definition_id) where watched.field_definition_id = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(coalesce(workflow.action_config -> 'conditions', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(workflow.actions) action where action ->> 'relatedFieldDefinitionId' = p_field_definition_id::text or exists (
      select 1 from jsonb_array_elements(coalesce(action -> 'fieldMappings', '[]'::jsonb)) mapping
      where mapping ->> 'targetFieldDefinitionId' = p_field_definition_id::text
        or mapping #>> '{source,sourceFieldDefinitionId}' = p_field_definition_id::text
        or coalesce(mapping #>> '{source,template}', '') like '%' || v_template_token || '%'
    ))
  );
  select count(*) into view_reference_count from entity_views view
  where view.workspace_id = p_workspace_id and view.entity_type_id = p_entity_type_id and (
    exists (select 1 from jsonb_array_elements(coalesce(view.filters, '[]'::jsonb)) filter where filter ->> 'fieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(coalesce(view.sorts, '[]'::jsonb)) sort where sort ->> 'fieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements_text(coalesce(view.column_field_definition_ids, '[]'::jsonb)) column_field_definition_id where column_field_definition_id = p_field_definition_id::text)
  );
  select count(*) into v_process_branch_reference_count
  from process_edges edge join process_templates template on template.workspace_id = edge.workspace_id and template.id = edge.process_template_id
  where edge.workspace_id = p_workspace_id and template.applies_to_entity_type_id = p_entity_type_id
    and exists (select 1 from jsonb_array_elements(coalesce(edge.condition_config, '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text);
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_step_run_routes route
  join process_step_runs source_step on source_step.workspace_id = route.workspace_id and source_step.id = route.source_step_run_id
  join process_runs run on run.workspace_id = route.workspace_id and run.id = route.process_run_id
  where route.workspace_id = p_workspace_id and run.origin_entity_type_id = p_entity_type_id and run.status = 'active' and source_step.status in ('pending', 'active')
    and exists (select 1 from jsonb_array_elements(coalesce(route.condition_config, '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text);
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_nodes node join process_templates template on template.workspace_id = node.workspace_id and template.id = node.process_template_id
  where node.workspace_id = p_workspace_id and node.node_type = 'condition_wait' and (
    (template.applies_to_entity_type_id = p_entity_type_id and exists (select 1 from jsonb_array_elements(coalesce(node.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or (node.config #>> '{condition_wait_rule,target,target_entity_type_id}' = p_entity_type_id::text and exists (select 1 from jsonb_array_elements(coalesce(node.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or node.config #>> '{condition_wait_rule,target,relation_field_definition_id}' = p_field_definition_id::text
  );
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_step_runs step join process_runs run on run.workspace_id = step.workspace_id and run.id = step.process_run_id
  where step.workspace_id = p_workspace_id and step.node_type = 'condition_wait' and step.status in ('pending', 'active') and run.status = 'active' and (
    (run.origin_entity_type_id = p_entity_type_id and exists (select 1 from jsonb_array_elements(coalesce(step.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or (step.config #>> '{condition_wait_rule,target,target_entity_type_id}' = p_entity_type_id::text and exists (select 1 from jsonb_array_elements(coalesce(step.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or step.config #>> '{condition_wait_rule,target,relation_field_definition_id}' = p_field_definition_id::text
  );
  process_branch_reference_count := v_process_branch_reference_count;
  if record_value_count = 0 and relation_value_count = 0 and workflow_reference_count = 0 and display_field_reference_count = 0 and view_reference_count = 0 and v_process_branch_reference_count = 0 then
    delete from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id;
    deleted := true;
  else
    deleted := false;
  end if;
  return next;
end;
$$;

create function delete_field_definition_if_safe_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid
)
returns table (
  deleted boolean, record_value_count bigint, relation_value_count bigint,
  workflow_reference_count bigint, display_field_reference_count bigint,
  view_reference_count bigint, process_branch_reference_count bigint
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  return query select * from delete_field_definition_if_safe(p_workspace_id, p_entity_type_id, p_field_definition_id);
end;
$$;

revoke all on table process_condition_wait_dependencies, process_condition_wait_wakeups from public, anon, authenticated;
revoke all on function private.validate_process_condition_wait_rule(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.enqueue_process_condition_wait_wakeup(uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.enqueue_process_condition_wait_record_change() from public, anon, authenticated, service_role;
revoke all on function private.enqueue_process_condition_wait_relation_change() from public, anon, authenticated, service_role;
revoke all on function private.enqueue_process_condition_wait_field_change() from public, anon, authenticated, service_role;
revoke all on function private.clear_process_condition_wait_dependencies() from public, anon, authenticated, service_role;
revoke all on function private.complete_process_step_and_advance(uuid, uuid, uuid, timestamptz, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.evaluate_process_condition_wait(uuid, uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.activate_process_step_run(uuid, uuid, uuid, timestamptz, uuid) from public, anon, authenticated, service_role;
revoke all on function private.resume_process_wait_step(uuid, uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function save_process_template_authorized_pre_condition_wait(uuid, uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public, anon;
revoke all on function dispatch_process_condition_wait_wakeups_system(integer) from public, anon, authenticated;
revoke all on function delete_field_definition_if_safe(uuid, uuid, uuid) from public, authenticated;
revoke all on function delete_field_definition_if_safe_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function dispatch_process_condition_wait_wakeups_system(integer) to service_role;
grant execute on function delete_field_definition_if_safe(uuid, uuid, uuid) to service_role;
grant execute on function delete_field_definition_if_safe_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on table process_condition_wait_dependencies is 'Active condition-wait subscriptions. Rows are removed when the wait resolves or is skipped.';
comment on table process_condition_wait_wakeups is 'Transactional record-change outbox. Dispatcher evaluation is intentionally separate from write triggers.';
