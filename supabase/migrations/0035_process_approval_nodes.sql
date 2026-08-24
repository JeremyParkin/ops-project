-- Process Graph 5C.1: explicit, single-person approval decisions. Approval
-- outcomes remain graph edges and are copied into run-scoped route snapshots;
-- decision history belongs to the completed StepRun, not live template data.

alter table process_nodes
  drop constraint if exists process_nodes_node_type_check,
  drop constraint if exists process_nodes_parallel_group_shape_check,
  drop constraint if exists process_nodes_system_metadata_check;

alter table process_nodes
  add constraint process_nodes_node_type_check
    check (node_type in ('human_task', 'approval', 'parallel_split', 'parallel_join')),
  add constraint process_nodes_parallel_group_shape_check
    check (
      (node_type in ('human_task', 'approval') and parallel_group_id is null)
      or (node_type in ('parallel_split', 'parallel_join') and parallel_group_id is not null)
    ),
  add constraint process_nodes_system_metadata_check
    check (
      node_type in ('human_task', 'approval')
      or (assignee_user_id is null and config = '{}'::jsonb)
    );

alter table process_step_runs
  add column if not exists approval_outcome_id uuid,
  add column if not exists approval_outcome_label text,
  add column if not exists decided_at timestamptz,
  add column if not exists decided_by_user_id uuid,
  add column if not exists decided_by_label text;

alter table process_step_runs
  drop constraint if exists process_step_runs_node_type_check,
  drop constraint if exists process_step_runs_system_metadata_check,
  drop constraint if exists process_step_runs_approval_decision_shape_check;

alter table process_step_runs
  add constraint process_step_runs_node_type_check
    check (node_type in ('human_task', 'approval', 'parallel_split', 'parallel_join')),
  add constraint process_step_runs_system_metadata_check
    check (
      node_type in ('human_task', 'approval')
      or (assignee_user_id is null and due_at is null and config = '{}'::jsonb)
    ),
  add constraint process_step_runs_approval_decision_shape_check
    check (
      (approval_outcome_id is null and approval_outcome_label is null and decided_at is null
        and decided_by_user_id is null and decided_by_label is null)
      or (node_type = 'approval' and status = 'completed'
        and approval_outcome_id is not null and nullif(trim(approval_outcome_label), '') is not null
        and decided_at is not null and decided_by_user_id is not null
        and nullif(trim(decided_by_label), '') is not null)
    );

alter table process_edges
  add column if not exists approval_outcome_id uuid,
  add column if not exists approval_outcome_label text;

alter table process_step_run_routes
  add column if not exists approval_outcome_id uuid,
  add column if not exists approval_outcome_label text;

alter table process_edges
  drop constraint if exists process_edges_routing_shape_check,
  drop constraint if exists process_edges_workspace_template_source_target_key,
  drop constraint if exists process_edges_approval_outcome_shape_check;

alter table process_edges
  add constraint process_edges_approval_outcome_shape_check
    check (
      (approval_outcome_id is null and approval_outcome_label is null)
      or (approval_outcome_id is not null and nullif(trim(approval_outcome_label), '') is not null)
    ),
  add constraint process_edges_routing_shape_check
    check (
      (approval_outcome_id is not null and not is_parallel and not is_default and condition_config is null)
      or (is_parallel and not is_default and condition_config is null and approval_outcome_id is null)
      or (
        approval_outcome_id is null and not is_parallel and (
          (is_default and condition_config is null)
          or (not is_default and jsonb_typeof(condition_config) = 'array' and jsonb_array_length(condition_config) > 0)
        )
      )
    );

create unique index if not exists process_edges_non_approval_source_target_key
  on process_edges (workspace_id, process_template_id, source_node_id, target_node_id)
  where approval_outcome_id is null;
create unique index if not exists process_edges_approval_outcome_key
  on process_edges (workspace_id, process_template_id, source_node_id, approval_outcome_id)
  where approval_outcome_id is not null;

alter table process_step_run_routes
  drop constraint if exists process_step_run_routes_routing_shape_check,
  drop constraint if exists process_step_run_routes_approval_outcome_shape_check;

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'process_step_run_routes'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%source_step_run_id, target_step_run_id%'
  loop
    execute format('alter table process_step_run_routes drop constraint %I', constraint_row.conname);
  end loop;
end;
$$;

alter table process_step_run_routes
  add constraint process_step_run_routes_approval_outcome_shape_check
    check (
      (approval_outcome_id is null and approval_outcome_label is null)
      or (approval_outcome_id is not null and nullif(trim(approval_outcome_label), '') is not null)
    ),
  add constraint process_step_run_routes_routing_shape_check
    check (
      (approval_outcome_id is not null and not is_parallel and not is_default and condition_config is null)
      or (is_parallel and not is_default and condition_config is null and approval_outcome_id is null)
      or (
        approval_outcome_id is null and not is_parallel and (
          (is_default and condition_config is null)
          or (not is_default and jsonb_typeof(condition_config) = 'array' and jsonb_array_length(condition_config) > 0)
        )
      )
    );

create unique index if not exists process_step_run_routes_non_approval_source_target_key
  on process_step_run_routes (workspace_id, process_run_id, source_step_run_id, target_step_run_id)
  where approval_outcome_id is null;
create unique index if not exists process_step_run_routes_approval_outcome_key
  on process_step_run_routes (workspace_id, process_run_id, source_step_run_id, approval_outcome_id)
  where approval_outcome_id is not null;

-- This is additive to the 5B structural validator: the latter remains the
-- owner of connected, forward-only, and parallel-block validity.
create or replace function private.validate_process_approval_template(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_node process_nodes%rowtype;
  v_outcome_count integer;
begin
  if exists (
    select 1
    from process_edges edge
    join process_nodes source on source.workspace_id = edge.workspace_id and source.id = edge.source_node_id
    where edge.workspace_id = p_workspace_id
      and edge.process_template_id = p_process_template_id
      and ((source.node_type = 'approval') <> (edge.approval_outcome_id is not null))
  ) then
    raise exception 'Approval routing must use approval outcomes only';
  end if;

  for v_node in
    select * from process_nodes
    where workspace_id = p_workspace_id and process_template_id = p_process_template_id and node_type = 'approval'
  loop
    select count(*) into v_outcome_count
    from process_edges
    where workspace_id = p_workspace_id and process_template_id = p_process_template_id and source_node_id = v_node.id;
    if v_outcome_count < 2 then raise exception 'An approval requires at least two outcomes'; end if;
    if exists (
      select 1 from process_edges
      where workspace_id = p_workspace_id and process_template_id = p_process_template_id and source_node_id = v_node.id
        and (is_default or is_parallel or condition_config is not null
          or approval_outcome_id is null or nullif(trim(approval_outcome_label), '') is null)
    ) then raise exception 'Approval outcomes must be direct named routes'; end if;
    if exists (
      select 1 from process_edges
      where workspace_id = p_workspace_id and process_template_id = p_process_template_id and source_node_id = v_node.id
      group by lower(trim(approval_outcome_label)) having count(*) > 1
    ) then raise exception 'Approval outcome labels must be unique'; end if;
  end loop;
end;
$$;

create or replace function save_process_template_authorized(
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
  v_template_id uuid;
  v_existing_applies_to uuid;
  v_existing_archived_at timestamptz;
  v_step jsonb;
  v_route jsonb;
  v_step_node_id uuid;
  v_step_name text;
  v_client_key text;
  v_target_client_key text;
  v_step_assignee_user_id uuid;
  v_due_rule jsonb;
  v_node_config jsonb;
  v_routes jsonb;
  v_conditions jsonb;
  v_node_type text;
  v_parallel_group_id uuid;
  v_approval_outcome_id uuid;
  v_approval_outcome_label text;
  v_seen_node_ids uuid[] := '{}'::uuid[];
  v_seen_client_keys text[] := '{}'::text[];
  v_final_node_ids uuid[] := '{}'::uuid[];
  v_node_by_client_key jsonb := '{}'::jsonb;
  v_position_by_client_key jsonb := '{}'::jsonb;
  v_index integer;
  v_route_index integer;
  v_route_count integer;
  v_default_count integer;
  v_is_default boolean;
  v_is_parallel boolean;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then raise exception 'A process template requires at least one step'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'A process template requires a name'; end if;
  if not exists (select 1 from entity_types where workspace_id = p_workspace_id and id = p_applies_to_entity_type_id and archived_at is null) then raise exception 'Applies-to entity type not found or archived'; end if;

  if p_process_template_id is null then
    v_template_id := gen_random_uuid();
    insert into process_templates (id, workspace_id, name, description, applies_to_entity_type_id)
    values (v_template_id, p_workspace_id, trim(p_name), nullif(trim(coalesce(p_description, '')), ''), p_applies_to_entity_type_id);
  else
    select applies_to_entity_type_id, archived_at into v_existing_applies_to, v_existing_archived_at from process_templates where workspace_id = p_workspace_id and id = p_process_template_id for update;
    if not found then raise exception 'Process template not found'; end if;
    if v_existing_archived_at is not null then raise exception 'Archived process templates are read-only. Restore before editing.'; end if;
    if v_existing_applies_to <> p_applies_to_entity_type_id then raise exception 'Applies-to entity type cannot be changed after creation'; end if;
    v_template_id := p_process_template_id;
    update process_templates set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''), updated_at = now() where workspace_id = p_workspace_id and id = v_template_id;
    update process_nodes set position = position + 1000000 where workspace_id = p_workspace_id and process_template_id = v_template_id;
  end if;

  for v_index in 1 .. jsonb_array_length(p_steps) loop
    v_step := p_steps -> (v_index - 1);
    if jsonb_typeof(v_step) <> 'object' or v_step - 'client_key' - 'node_id' - 'node_type' - 'parallel_group_id' - 'name' - 'assignee_user_id' - 'due_rule' - 'routes' <> '{}'::jsonb then raise exception 'Process step configuration is invalid'; end if;
    v_client_key := nullif(trim(coalesce(v_step->>'client_key', '')), '');
    v_step_name := nullif(trim(coalesce(v_step->>'name', '')), '');
    v_node_type := coalesce(nullif(v_step->>'node_type', ''), 'human_task');
    v_parallel_group_id := nullif(v_step->>'parallel_group_id', '')::uuid;
    v_step_assignee_user_id := nullif(v_step->>'assignee_user_id', '')::uuid;
    v_due_rule := v_step->'due_rule';
    v_node_config := case when v_due_rule is null or v_due_rule = 'null'::jsonb then '{}'::jsonb else jsonb_build_object('due_rule', v_due_rule) end;
    if v_client_key is null or v_client_key = any(v_seen_client_keys) then raise exception 'Duplicate or missing step client key'; end if;
    if v_node_type not in ('human_task', 'approval', 'parallel_split', 'parallel_join') then raise exception 'Unsupported process node type'; end if;
    if v_step_name is null then raise exception 'Every process node requires a name'; end if;
    if v_node_type in ('human_task', 'approval') then
      if v_parallel_group_id is not null then raise exception 'Human work nodes cannot be assigned a parallel group'; end if;
      perform private.process_due_at_from_config(v_node_config, now());
      if v_step_assignee_user_id is not null and not exists (select 1 from workspace_memberships where workspace_id = p_workspace_id and user_id = v_step_assignee_user_id) then raise exception 'Assignee is not a member of this workspace'; end if;
    elsif v_parallel_group_id is null or v_step_assignee_user_id is not null or (v_due_rule is not null and v_due_rule <> 'null'::jsonb) then
      raise exception 'Parallel system nodes cannot have an assignee or due rule';
    else
      v_node_config := '{}'::jsonb;
    end if;
    v_step_node_id := nullif(v_step->>'node_id', '')::uuid;
    if v_step_node_id is not null then
      if v_step_node_id = any(v_seen_node_ids) then raise exception 'Duplicate step submitted'; end if;
      if not exists (select 1 from process_nodes where workspace_id = p_workspace_id and process_template_id = v_template_id and id = v_step_node_id) then raise exception 'Submitted step does not belong to this template'; end if;
      update process_nodes set node_type = v_node_type, parallel_group_id = v_parallel_group_id, name = v_step_name, position = v_index, assignee_user_id = v_step_assignee_user_id, config = v_node_config, updated_at = now() where workspace_id = p_workspace_id and id = v_step_node_id;
    else
      v_step_node_id := gen_random_uuid();
      insert into process_nodes (id, workspace_id, process_template_id, node_type, parallel_group_id, name, position, assignee_user_id, config)
      values (v_step_node_id, p_workspace_id, v_template_id, v_node_type, v_parallel_group_id, v_step_name, v_index, v_step_assignee_user_id, v_node_config);
    end if;
    v_seen_node_ids := v_seen_node_ids || v_step_node_id;
    v_seen_client_keys := v_seen_client_keys || v_client_key;
    v_final_node_ids := v_final_node_ids || v_step_node_id;
    v_node_by_client_key := v_node_by_client_key || jsonb_build_object(v_client_key, v_step_node_id::text);
    v_position_by_client_key := v_position_by_client_key || jsonb_build_object(v_client_key, v_index);
  end loop;

  delete from process_nodes where workspace_id = p_workspace_id and process_template_id = v_template_id and not (id = any(v_final_node_ids));
  delete from process_edges where workspace_id = p_workspace_id and process_template_id = v_template_id;

  for v_index in 1 .. jsonb_array_length(p_steps) loop
    v_step := p_steps -> (v_index - 1);
    v_step_node_id := (v_node_by_client_key ->> (v_step->>'client_key'))::uuid;
    v_node_type := coalesce(nullif(v_step->>'node_type', ''), 'human_task');
    v_routes := coalesce(v_step->'routes', '[]'::jsonb);
    if jsonb_typeof(v_routes) <> 'array' then raise exception 'Process routes must be an array'; end if;
    v_route_count := jsonb_array_length(v_routes);
    if v_route_count = 0 then
      if v_node_type = 'approval' then raise exception 'An approval requires at least two outcomes'; end if;
      if v_index < jsonb_array_length(p_steps) then
        v_target_client_key := (p_steps -> v_index)->>'client_key';
        insert into process_edges (workspace_id, process_template_id, source_node_id, target_node_id, priority, condition_config, is_default, is_parallel)
        values (p_workspace_id, v_template_id, v_step_node_id, (v_node_by_client_key->>v_target_client_key)::uuid, 0, null, true, false);
      end if;
      continue;
    end if;
    select count(*) into v_default_count from jsonb_array_elements(v_routes) route where route->>'is_default' = 'true';
    if v_node_type = 'parallel_split' then
      if v_route_count < 2 then raise exception 'A parallel split requires at least two branches'; end if;
    elsif v_node_type = 'approval' then
      if v_route_count < 2 then raise exception 'An approval requires at least two outcomes'; end if;
    elsif v_route_count > 1 and v_default_count <> 1 then raise exception 'Conditional routing requires one Otherwise route';
    elsif v_route_count = 1 and v_default_count <> 1 then raise exception 'A routed step requires one unconditional route'; end if;

    for v_route_index in 1 .. v_route_count loop
      v_route := v_routes -> (v_route_index - 1);
      if jsonb_typeof(v_route) <> 'object' or v_route - 'target_client_key' - 'is_default' - 'is_parallel' - 'approval_outcome_id' - 'approval_outcome_label' - 'conditions' <> '{}'::jsonb or jsonb_typeof(v_route->'target_client_key') <> 'string' or jsonb_typeof(v_route->'is_default') <> 'boolean' then raise exception 'Process route configuration is invalid'; end if;
      v_target_client_key := nullif(trim(v_route->>'target_client_key'), '');
      v_is_default := (v_route->>'is_default')::boolean;
      v_is_parallel := coalesce((v_route->>'is_parallel')::boolean, false);
      v_approval_outcome_id := nullif(v_route->>'approval_outcome_id', '')::uuid;
      v_approval_outcome_label := nullif(trim(coalesce(v_route->>'approval_outcome_label', '')), '');
      if v_target_client_key is null or not (v_node_by_client_key ? v_target_client_key) then raise exception 'Route target does not belong to this template'; end if;
      if (v_position_by_client_key->>v_target_client_key)::integer <= v_index then raise exception 'Routes must point to a later step'; end if;
      v_conditions := v_route->'conditions';
      if v_node_type = 'parallel_split' then
        if v_approval_outcome_id is not null or v_approval_outcome_label is not null or not v_is_parallel or v_is_default or (v_conditions is not null and jsonb_array_length(v_conditions) <> 0) then raise exception 'Parallel branch routes cannot have conditions or default semantics'; end if;
        v_conditions := null;
      elsif v_node_type = 'approval' then
        if v_approval_outcome_id is null or v_approval_outcome_label is null or v_is_parallel or v_is_default or (v_conditions is not null and jsonb_array_length(v_conditions) <> 0) then raise exception 'Approval outcomes must be direct named routes'; end if;
        v_conditions := null;
      else
        if v_approval_outcome_id is not null or v_approval_outcome_label is not null then raise exception 'Only approval nodes can configure approval outcomes'; end if;
        if v_is_parallel then raise exception 'Only parallel split nodes may use parallel branch routes'; end if;
        if v_is_default then
          if v_conditions is not null and (jsonb_typeof(v_conditions) <> 'array' or jsonb_array_length(v_conditions) <> 0) then raise exception 'Default process routes cannot have conditions'; end if;
          v_conditions := null;
        else
          perform private.validate_process_branch_conditions(p_workspace_id, p_applies_to_entity_type_id, v_conditions);
        end if;
      end if;
      insert into process_edges (workspace_id, process_template_id, source_node_id, target_node_id, priority, condition_config, is_default, is_parallel, approval_outcome_id, approval_outcome_label)
      values (p_workspace_id, v_template_id, v_step_node_id, (v_node_by_client_key->>v_target_client_key)::uuid, v_route_index - 1, v_conditions, v_is_default, v_is_parallel, v_approval_outcome_id, v_approval_outcome_label);
    end loop;
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
declare
  v_step process_step_runs%rowtype;
begin
  select * into v_step from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.status <> 'pending' then raise exception 'Process route target is not available'; end if;
  if v_step.parallel_branch_token is not null and p_parallel_branch_token is not null and v_step.parallel_branch_token <> p_parallel_branch_token then
    raise exception 'Process branch token does not match its target';
  end if;
  update process_step_runs
  set status = 'active', started_at = p_activation_at,
    due_at = case when v_step.node_type in ('human_task', 'approval')
      then private.process_due_at_from_config(v_step.config, p_activation_at) else null end,
    parallel_branch_token = coalesce(v_step.parallel_branch_token, p_parallel_branch_token)
  where workspace_id = p_workspace_id and id = p_step_run_id;
  if v_step.node_type not in ('human_task', 'approval') then
    perform private.advance_process_system_step(p_workspace_id, p_process_run_id, p_step_run_id, p_activation_at);
  end if;
end;
$$;

create or replace function start_process_run_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template process_templates%rowtype;
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
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
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
  insert into process_runs (id, workspace_id, process_template_id, process_template_name, process_template_description, origin_entity_type_id, origin_record_id, status)
  values (v_run_id, p_workspace_id, p_process_template_id, v_template.name, v_template.description, p_origin_entity_type_id, p_origin_record_id, 'active');
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

create or replace function decide_process_approval_authorized(
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

revoke all on function private.validate_process_approval_template(uuid, uuid) from public;
revoke all on function private.activate_process_step_run(uuid, uuid, uuid, timestamptz, uuid) from public;
revoke all on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public;
revoke all on function start_process_run_authorized(uuid, uuid, uuid, uuid) from public;
revoke all on function complete_process_step_run_authorized(uuid, uuid, uuid) from public;
revoke all on function decide_process_approval_authorized(uuid, uuid, uuid, uuid) from public;
revoke all on function decide_process_approval_authorized(uuid, uuid, uuid, uuid) from anon;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function start_process_run_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function complete_process_step_run_authorized(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function decide_process_approval_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;

comment on column process_step_runs.approval_outcome_id is
  'The selected approval outcome from the run-scoped route snapshot, never a live template lookup.';
