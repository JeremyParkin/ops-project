-- Automated Action Nodes (Phase 7 roadmap item 1): a process step that
-- performs a deterministic system action (create record, update record,
-- update related record, start process) automatically when activated,
-- reusing the same WorkflowAction shape and execution machinery workflows
-- already use. No new automation engine. Success/failure are represented
-- without a new ProcessStepRunStatus: an action step that fails simply stays
-- 'active' with action_result.status = 'failed', retryable by any workspace
-- member, exactly like an unresolved wait or human task stays 'active' for a
-- different reason. Idempotency for create_record/start_process is a durable
-- originating_process_step_run_id identity, not a distributed job framework.

-- 1. node_type: add 'action' everywhere the existing node types are enforced.

alter table process_nodes
  drop constraint if exists process_nodes_node_type_check,
  drop constraint if exists process_nodes_parallel_group_shape_check,
  drop constraint if exists process_nodes_system_metadata_check;

alter table process_nodes
  add constraint process_nodes_node_type_check
    check (node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'action', 'parallel_split', 'parallel_join')),
  add constraint process_nodes_parallel_group_shape_check
    check (
      (node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'action') and parallel_group_id is null)
      or (node_type in ('parallel_split', 'parallel_join') and parallel_group_id is not null)
    ),
  add constraint process_nodes_system_metadata_check
    check (
      node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'action')
      or (assignee_user_id is null and config = '{}'::jsonb)
    );

alter table process_step_runs
  add column if not exists action_result jsonb;

alter table process_step_runs
  drop constraint if exists process_step_runs_node_type_check,
  drop constraint if exists process_step_runs_system_metadata_check,
  drop constraint if exists process_step_runs_wait_shape_check,
  drop constraint if exists process_step_runs_condition_wait_shape_check;

alter table process_step_runs
  add constraint process_step_runs_node_type_check
    check (node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'action', 'parallel_split', 'parallel_join')),
  add constraint process_step_runs_system_metadata_check
    check (
      node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'action')
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
    ),
  add constraint process_step_runs_action_shape_check
    check (
      (node_type <> 'action' and action_result is null)
      or (node_type = 'action' and assignee_user_id is null and due_at is null and resume_at is null and condition_wait_result is null
        and (status not in ('pending', 'skipped') or action_result is null)
        and (status <> 'completed' or action_result is not null))
    );

-- A plain unique(workspace_id, id) alongside the existing composite key, so
-- entity_records/process_runs can reference "this exact step run" without
-- also carrying its process_run_id.
alter table process_step_runs
  add constraint process_step_runs_workspace_id_key unique (workspace_id, id);

-- 2. Idempotency identity: which ProcessStepRun (if any) originated this row.
-- Null for every existing/ordinary caller (manual record creation, workflow
-- actions, manual process starts) -- only process action-node execution ever
-- sets this, and only ever to its own step run's id.

alter table entity_records
  add column if not exists originating_process_step_run_id uuid;

alter table entity_records
  add constraint entity_records_originating_step_run_fkey
    foreign key (workspace_id, originating_process_step_run_id)
    references process_step_runs (workspace_id, id) on delete set null;

create unique index entity_records_originating_step_run_uniq
  on entity_records (workspace_id, originating_process_step_run_id)
  where originating_process_step_run_id is not null;

alter table process_runs
  add column if not exists originating_process_step_run_id uuid;

alter table process_runs
  add constraint process_runs_originating_step_run_fkey
    foreign key (workspace_id, originating_process_step_run_id)
    references process_step_runs (workspace_id, id) on delete set null;

create unique index process_runs_originating_step_run_uniq
  on process_runs (workspace_id, originating_process_step_run_id)
  where originating_process_step_run_id is not null;

-- 3. Template-save validation for an action node's config. Deliberately
-- lighter than execution-time validation (which reloads live entity
-- context, exactly as workflow actions already do): this only rejects
-- structurally broken or dangling references at save time, matching the
-- scope of validate_process_wait_rule / validate_process_condition_wait_rule.

create or replace function private.validate_process_action_node_config(
  p_workspace_id uuid,
  p_origin_entity_type_id uuid,
  p_process_template_id uuid,
  p_config jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action_type text;
  v_target_entity_type_id uuid;
  v_related_field field_definitions%rowtype;
  v_process_template_id uuid;
  v_mapping jsonb;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'Action step is missing its configuration';
  end if;

  v_action_type := p_config->>'action_type';
  if v_action_type not in ('create_record', 'update_record', 'update_related_record', 'start_process') then
    raise exception 'Action step has an invalid action type';
  end if;

  if v_action_type = 'create_record' then
    if nullif(p_config->>'action_target_entity_type_id', '') is null then
      raise exception 'Create-record action is missing its target entity';
    end if;
    v_target_entity_type_id := (p_config->>'action_target_entity_type_id')::uuid;
    if not exists (
      select 1 from entity_types
      where workspace_id = p_workspace_id and id = v_target_entity_type_id and archived_at is null
    ) then
      raise exception 'Create-record action targets an entity that no longer exists';
    end if;
    for v_mapping in select * from jsonb_array_elements(coalesce(p_config->'field_mappings', '[]'::jsonb)) loop
      if not exists (
        select 1 from field_definitions
        where workspace_id = p_workspace_id and entity_type_id = v_target_entity_type_id
          and id = (v_mapping->>'target_field_definition_id')::uuid and archived_at is null
      ) then
        raise exception 'Create-record action maps a field that no longer exists';
      end if;
    end loop;
  elsif v_action_type = 'update_record' then
    for v_mapping in select * from jsonb_array_elements(coalesce(p_config->'field_mappings', '[]'::jsonb)) loop
      if not exists (
        select 1 from field_definitions
        where workspace_id = p_workspace_id and entity_type_id = p_origin_entity_type_id
          and id = (v_mapping->>'target_field_definition_id')::uuid and archived_at is null
      ) then
        raise exception 'Update action maps a field that no longer exists';
      end if;
    end loop;
  elsif v_action_type = 'update_related_record' then
    if nullif(p_config->>'related_field_definition_id', '') is null then
      raise exception 'Update related record action is missing its relation field';
    end if;
    select * into v_related_field from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_origin_entity_type_id
      and id = (p_config->>'related_field_definition_id')::uuid and archived_at is null;
    if not found or v_related_field.type <> 'relation' or v_related_field.related_entity_type_id is null then
      raise exception 'Update related record action references an invalid relation field';
    end if;
    for v_mapping in select * from jsonb_array_elements(coalesce(p_config->'field_mappings', '[]'::jsonb)) loop
      if not exists (
        select 1 from field_definitions
        where workspace_id = p_workspace_id and entity_type_id = v_related_field.related_entity_type_id
          and id = (v_mapping->>'target_field_definition_id')::uuid and archived_at is null
      ) then
        raise exception 'Update related record action maps a field that no longer exists';
      end if;
    end loop;
  elsif v_action_type = 'start_process' then
    if nullif(p_config->>'process_template_id', '') is null then
      raise exception 'Start process action is missing its process template';
    end if;
    v_process_template_id := (p_config->>'process_template_id')::uuid;
    if p_process_template_id is not null and v_process_template_id = p_process_template_id then
      raise exception 'Start process action cannot start its own template';
    end if;
    if not exists (
      select 1 from process_templates
      where workspace_id = p_workspace_id and id = v_process_template_id and archived_at is null
    ) then
      raise exception 'Start process action references a process template that no longer exists';
    end if;
  end if;
end;
$$;

revoke all on function private.validate_process_action_node_config(uuid, uuid, uuid, jsonb) from public;

-- 4. Wrap the existing save function (same layered-delegation pattern used
-- for condition_wait/wait): intercept 'action' steps, validate and stash
-- their config, disguise them as a plain human_task for the inner save (an
-- action step has no assignee/due/wait config of its own to conflict with),
-- then patch node_type + config back in a follow-up update.

alter function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb)
  rename to save_process_template_authorized_pre_action;

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
  v_action_steps jsonb := '[]'::jsonb;
  v_template_id uuid;
  v_node_id uuid;
  v_index integer := 0;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Process steps must be an array'; end if;
  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_index := v_index + 1;
    if v_step->>'node_type' = 'action' then
      perform private.validate_process_action_node_config(
        p_workspace_id, p_applies_to_entity_type_id, p_process_template_id, v_step->'action_config'
      );
      if coalesce(nullif(trim(v_step->>'assignee_user_id'), ''), '') <> ''
        or coalesce(v_step->'due_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'wait_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'condition_wait_rule', 'null'::jsonb) <> 'null'::jsonb then
        raise exception 'Action steps cannot have an assignee, due rule, or wait rule';
      end if;
      v_action_steps := v_action_steps || jsonb_build_array(jsonb_build_object('position', v_index, 'config', jsonb_build_object('action_config', v_step->'action_config')));
      v_normalized := v_normalized || jsonb_build_array((v_step - 'action_config') || jsonb_build_object('node_type', 'human_task'));
    else
      v_normalized := v_normalized || jsonb_build_array(v_step);
    end if;
  end loop;

  v_template_id := save_process_template_authorized_pre_action(
    p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, v_normalized
  );
  for v_step in select * from jsonb_array_elements(v_action_steps) loop
    select id into v_node_id from process_nodes
    where workspace_id = p_workspace_id and process_template_id = v_template_id and position = (v_step->>'position')::integer for update;
    if not found then raise exception 'Action node was not saved'; end if;
    update process_nodes
    set node_type = 'action', assignee_user_id = null, config = v_step->'config', updated_at = now()
    where workspace_id = p_workspace_id and id = v_node_id;
  end loop;
  return v_template_id;
end;
$$;

revoke all on function save_process_template_authorized_pre_action(uuid, uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- 5. An activated action step stays 'active' uncascaded -- exactly like
-- human_task/approval/wait already do -- so the app layer can execute it via
-- the canonical action runner and call back one of the two functions below.
-- (Only parallel_split/parallel_join continue to auto-cascade in SQL.)

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
  elsif v_step.node_type not in ('human_task', 'approval', 'wait', 'action') then
    perform private.advance_process_system_step(p_workspace_id, p_process_run_id, p_step_run_id, p_activation_at);
  end if;
end;
$$;

-- 6. The canonical action-step executor's two completion entrypoints. Both
-- take only identity plus a result payload -- never action config -- and
-- both accept either an authenticated workspace member (interactive
-- complete/retry) or service_role (the wait/condition-wait scheduler
-- draining an action node it just activated), matching the same authority
-- boundary the rest of the process runtime already uses.

create or replace function complete_process_action_step_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_action_result jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step process_step_runs%rowtype;
begin
  if auth.role() <> 'service_role' and not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  select * into v_step from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.node_type <> 'action' or v_step.status <> 'active' then
    return false;
  end if;
  update process_step_runs set action_result = p_action_result
  where workspace_id = p_workspace_id and id = p_step_run_id;
  return private.complete_process_step_and_advance(
    p_workspace_id, p_process_run_id, p_step_run_id, now(), 'action_succeeded', '[]'::jsonb
  );
end;
$$;

create or replace function fail_process_action_step_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_action_result jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if auth.role() <> 'service_role' and not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  update process_step_runs set action_result = p_action_result
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id
    and node_type = 'action' and status = 'active';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- 7. Idempotent create_record: an originating step run's create always
-- returns the same record on retry, never a duplicate, and never repeats
-- relation writes for a row that already exists.

create or replace function create_entity_record_with_relations(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_record_id uuid;
  v_existing_id uuid;
  v_relation jsonb;
  v_field field_definitions%rowtype;
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
begin
  if p_relations is null or jsonb_typeof(p_relations) <> 'array' then
    raise exception 'p_relations must be a JSON array';
  end if;

  if p_originating_process_step_run_id is not null then
    select id into v_existing_id from entity_records
    where workspace_id = p_workspace_id and originating_process_step_run_id = p_originating_process_step_run_id;
    if found then
      return v_existing_id;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and required = true
      and archived_at is null
    order by position
  loop
    if v_field.type = 'relation' then
      if not exists (
        select 1
        from jsonb_array_elements(p_relations) relation
        where relation ->> 'field_definition_id' = v_field.id::text
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'text' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'string'
        and btrim(v_values ->> v_field.key) <> ''
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'number' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'number'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'date' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'string'
        and v_values ->> v_field.key ~ '^\d{4}-\d{2}-\d{2}$'
        and to_char(to_date(v_values ->> v_field.key, 'YYYY-MM-DD'), 'YYYY-MM-DD') =
          v_values ->> v_field.key
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'boolean' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'boolean'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    end if;
  end loop;

  v_record_id := gen_random_uuid();

  insert into entity_records (
    id,
    workspace_id,
    entity_type_id,
    values,
    originating_process_step_run_id
  )
  values (
    v_record_id,
    p_workspace_id,
    p_entity_type_id,
    v_values,
    p_originating_process_step_run_id
  )
  on conflict (workspace_id, originating_process_step_run_id) where originating_process_step_run_id is not null
  do nothing
  returning id into v_record_id;

  if v_record_id is null then
    -- Lost a race with a concurrent identical retry; reuse its row and skip
    -- relation writes, which that winning attempt already performed.
    select id into v_record_id from entity_records
    where workspace_id = p_workspace_id and originating_process_step_run_id = p_originating_process_step_run_id;
    return v_record_id;
  end if;

  for v_relation in select * from jsonb_array_elements(p_relations)
  loop
    insert into entity_record_relation_values (
      workspace_id,
      source_entity_type_id,
      source_record_id,
      field_definition_id,
      target_entity_type_id,
      target_record_id
    )
    values (
      p_workspace_id,
      p_entity_type_id,
      v_record_id,
      (v_relation->>'field_definition_id')::uuid,
      (v_relation->>'target_entity_type_id')::uuid,
      (v_relation->>'target_record_id')::uuid
    );
  end loop;

  return v_record_id;
end;
$$;

create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' and not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return create_entity_record_with_relations(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    p_originating_process_step_run_id
  );
end;
$$;

grant execute on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

-- 8. Idempotent start_process: an originating step run's start always
-- returns the same run on retry, checked before the ordinary
-- one-active-run-per-template-per-record rule (which stays intact for every
-- other caller, including a second, independent action node).

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

grant execute on function start_process_run_authorized(uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

-- 9. complete_process_step_run_authorized / decide_process_approval_authorized
-- are unchanged: an action step is never human-completable, and the private
-- activation cascade above already leaves it active-and-uncascaded exactly
-- like a wait, so no other RPC needs to know about node_type = 'action'.

grant execute on function private.validate_process_action_node_config(uuid, uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function complete_process_step_run_authorized(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function decide_process_approval_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function complete_process_action_step_authorized(uuid, uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function fail_process_action_step_authorized(uuid, uuid, uuid, jsonb) to authenticated, service_role;

comment on function complete_process_action_step_authorized(uuid, uuid, uuid, jsonb)
  is 'Canonical system action-step executor completion: records the result and advances the run. Callable by an authenticated workspace member (interactive/retry) or service_role (scheduler draining a wait/condition-wait-activated action node). Never accepts action config from the caller -- only identity and a result payload.';
comment on function fail_process_action_step_authorized(uuid, uuid, uuid, jsonb)
  is 'Records an action step execution failure. The step stays active (no new ProcessStepRunStatus); action_result.status = failed makes it visible and retryable.';
