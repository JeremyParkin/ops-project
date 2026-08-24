-- Process Due Dates + Attention (v1): human-task deadlines are configured on
-- template nodes, snapshotted onto ProcessStepRuns, and calculated only when
-- a step becomes active. There is deliberately no scheduler or notification
-- delivery state in this migration.

alter table process_step_runs
  add column due_at timestamptz;

-- My Work reads active assigned work by due time. Pending work intentionally
-- has no due_at until it activates, and is ordered separately by the repository.
create index process_step_runs_active_assignee_due_idx
  on process_step_runs (workspace_id, assignee_user_id, due_at, process_run_id, step_index)
  where status = 'active' and due_at is not null;

-- Returns a due timestamp from one snapshotted node config, or null when no
-- rule exists. A day is always 24 elapsed hours, never a calendar/business day.
-- The strict validation here is also used at run start, so malformed legacy or
-- privileged direct config changes cannot create ambiguous runtime deadlines.
create or replace function private.process_due_at_from_config(
  p_config jsonb,
  p_activation_at timestamptz
)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_due_rule jsonb;
  v_amount_text text;
  v_amount integer;
  v_unit text;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'Process step configuration is invalid';
  end if;

  if p_config - 'due_rule' <> '{}'::jsonb then
    raise exception 'Process step configuration is invalid';
  end if;

  v_due_rule := p_config->'due_rule';

  if v_due_rule is null or v_due_rule = 'null'::jsonb then
    return null;
  end if;

  if jsonb_typeof(v_due_rule) <> 'object'
    or v_due_rule - 'amount' - 'unit' <> '{}'::jsonb
    or not (v_due_rule ? 'amount')
    or not (v_due_rule ? 'unit')
    or jsonb_typeof(v_due_rule->'amount') <> 'number'
    or jsonb_typeof(v_due_rule->'unit') <> 'string' then
    raise exception 'Process step due rule is invalid';
  end if;

  v_amount_text := v_due_rule->>'amount';
  v_unit := v_due_rule->>'unit';

  if v_amount_text !~ '^[1-9][0-9]*$' then
    raise exception 'Process step due offset must be a whole number';
  end if;

  v_amount := v_amount_text::integer;

  if v_amount > 8760 then
    raise exception 'Process step due offset must be between 1 and 8760';
  end if;

  if v_unit not in ('hours', 'days') then
    raise exception 'Process step due unit must be hours or days';
  end if;

  return p_activation_at + make_interval(hours => case
    when v_unit = 'hours' then v_amount
    else v_amount * 24
  end);
end;
$$;

-- The template save path owns the only supported Node config shape. Existing
-- templates with {} remain valid and mean no due rule.
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
  v_step_node_id uuid;
  v_step_name text;
  v_step_assignee_user_id uuid;
  v_due_rule jsonb;
  v_node_config jsonb;
  v_previous_node_id uuid;
  v_seen_node_ids uuid[] := '{}'::uuid[];
  v_final_node_ids uuid[] := '{}'::uuid[];
  v_index integer;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'A process template requires at least one step';
  end if;

  if nullif(trim(p_name), '') is null then
    raise exception 'A process template requires a name';
  end if;

  if not exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id
      and id = p_applies_to_entity_type_id
      and archived_at is null
  ) then
    raise exception 'Applies-to entity type not found or archived';
  end if;

  if p_process_template_id is null then
    v_template_id := gen_random_uuid();
    insert into process_templates (
      id, workspace_id, name, description, applies_to_entity_type_id
    ) values (
      v_template_id, p_workspace_id, trim(p_name),
      nullif(trim(coalesce(p_description, '')), ''), p_applies_to_entity_type_id
    );
  else
    select applies_to_entity_type_id, archived_at
      into v_existing_applies_to, v_existing_archived_at
    from process_templates
    where workspace_id = p_workspace_id and id = p_process_template_id
    for update;

    if not found then
      raise exception 'Process template not found';
    end if;
    if v_existing_archived_at is not null then
      raise exception 'Archived process templates are read-only. Restore before editing.';
    end if;
    if v_existing_applies_to <> p_applies_to_entity_type_id then
      raise exception 'Applies-to entity type cannot be changed after creation';
    end if;

    v_template_id := p_process_template_id;
    update process_templates
    set name = trim(p_name),
        description = nullif(trim(coalesce(p_description, '')), ''),
        updated_at = now()
    where workspace_id = p_workspace_id and id = v_template_id;
  end if;

  for v_step in select * from jsonb_array_elements(p_steps)
  loop
    if jsonb_typeof(v_step) <> 'object' then
      raise exception 'Process step configuration is invalid';
    end if;

    v_step_node_id := nullif(v_step->>'node_id', '')::uuid;
    v_step_name := nullif(trim(coalesce(v_step->>'name', '')), '');
    v_step_assignee_user_id := nullif(v_step->>'assignee_user_id', '')::uuid;
    v_due_rule := v_step->'due_rule';
    v_node_config := case
      when v_due_rule is null or v_due_rule = 'null'::jsonb then '{}'::jsonb
      else jsonb_build_object('due_rule', v_due_rule)
    end;

    perform private.process_due_at_from_config(v_node_config, now());

    if v_step_name is null then
      raise exception 'Every step requires a name';
    end if;

    if v_step_assignee_user_id is not null and not exists (
      select 1 from workspace_memberships
      where workspace_id = p_workspace_id and user_id = v_step_assignee_user_id
    ) then
      raise exception 'Assignee is not a member of this workspace';
    end if;

    if v_step_node_id is not null then
      if v_step_node_id = any(v_seen_node_ids) then
        raise exception 'Duplicate step submitted';
      end if;
      if not exists (
        select 1 from process_nodes
        where workspace_id = p_workspace_id
          and process_template_id = v_template_id
          and id = v_step_node_id
      ) then
        raise exception 'Submitted step does not belong to this template';
      end if;

      v_seen_node_ids := v_seen_node_ids || v_step_node_id;
      update process_nodes
      set name = v_step_name,
          assignee_user_id = v_step_assignee_user_id,
          config = v_node_config,
          updated_at = now()
      where workspace_id = p_workspace_id and id = v_step_node_id;
    else
      v_step_node_id := gen_random_uuid();
      insert into process_nodes (
        id, workspace_id, process_template_id, node_type, name, assignee_user_id, config
      ) values (
        v_step_node_id, p_workspace_id, v_template_id, 'human_task', v_step_name,
        v_step_assignee_user_id, v_node_config
      );
    end if;

    v_final_node_ids := v_final_node_ids || v_step_node_id;
  end loop;

  delete from process_nodes
  where workspace_id = p_workspace_id
    and process_template_id = v_template_id
    and not (id = any(v_final_node_ids));

  delete from process_edges
  where workspace_id = p_workspace_id and process_template_id = v_template_id;

  v_previous_node_id := null;
  for v_index in 1 .. array_length(v_final_node_ids, 1)
  loop
    if v_previous_node_id is not null then
      insert into process_edges (workspace_id, process_template_id, source_node_id, target_node_id)
      values (p_workspace_id, v_template_id, v_previous_node_id, v_final_node_ids[v_index]);
    end if;
    v_previous_node_id := v_final_node_ids[v_index];
  end loop;

  return v_template_id;
end;
$$;

-- A run snapshots the complete Node config. The first activation time is
-- captured once and reused for both started_at and due_at.
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
  v_node process_nodes%rowtype;
  v_current_node_id uuid;
  v_step_index integer := 0;
  v_first boolean := true;
  v_assignee_label text;
  v_activation_at timestamptz := now();
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  select * into v_template from process_templates
  where workspace_id = p_workspace_id and id = p_process_template_id and archived_at is null;
  if not found then raise exception 'Process template not found or archived'; end if;
  if v_template.applies_to_entity_type_id <> p_origin_entity_type_id then
    raise exception 'Process template does not apply to this record''s entity type';
  end if;
  if not exists (
    select 1 from entity_records where workspace_id = p_workspace_id
      and entity_type_id = p_origin_entity_type_id and id = p_origin_record_id and archived_at is null
  ) then raise exception 'Origin record not found or archived'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_origin_record_id::text, 0));
  if exists (
    select 1 from process_runs where workspace_id = p_workspace_id
      and process_template_id = p_process_template_id and origin_record_id = p_origin_record_id and status = 'active'
  ) then raise exception 'This process is already running for this record'; end if;

  insert into process_runs (
    id, workspace_id, process_template_id, process_template_name, process_template_description,
    origin_entity_type_id, origin_record_id, status
  ) values (
    v_run_id, p_workspace_id, p_process_template_id, v_template.name, v_template.description,
    p_origin_entity_type_id, p_origin_record_id, 'active'
  );

  select n.id into v_current_node_id from process_nodes n
  where n.workspace_id = p_workspace_id and n.process_template_id = p_process_template_id
    and not exists (
      select 1 from process_edges e where e.workspace_id = p_workspace_id
        and e.process_template_id = p_process_template_id and e.target_node_id = n.id
    );
  if v_current_node_id is null then raise exception 'Process template has no steps'; end if;

  while v_current_node_id is not null loop
    select * into v_node from process_nodes where workspace_id = p_workspace_id and id = v_current_node_id;
    v_step_index := v_step_index + 1;
    v_assignee_label := null;
    if v_node.assignee_user_id is not null then
      select email into v_assignee_label from auth.users where id = v_node.assignee_user_id;
    end if;

    insert into process_step_runs (
      id, workspace_id, process_run_id, source_node_id, step_index, node_type, name, config,
      status, started_at, due_at, assignee_user_id, assignee_label
    ) values (
      gen_random_uuid(), p_workspace_id, v_run_id, v_node.id, v_step_index, v_node.node_type,
      v_node.name, v_node.config, case when v_first then 'active' else 'pending' end,
      case when v_first then v_activation_at else null end,
      case when v_first then private.process_due_at_from_config(v_node.config, v_activation_at) else null end,
      v_node.assignee_user_id, v_assignee_label
    );
    v_first := false;
    select e.target_node_id into v_current_node_id from process_edges e
    where e.workspace_id = p_workspace_id and e.process_template_id = p_process_template_id
      and e.source_node_id = v_current_node_id;
  end loop;
  return v_run_id;
end;
$$;

-- Completion remains assignee-authorized and atomic. It uses the next
-- StepRun's snapshot, never the live template node, when calculating due_at.
create or replace function complete_process_step_run_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_run process_step_runs%rowtype;
  v_next_step_run process_step_runs%rowtype;
  v_activation_at timestamptz := now();
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  select * into v_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found then raise exception 'Step not found'; end if;
  if v_step_run.status <> 'active' then raise exception 'This step is not active'; end if;
  if v_step_run.assignee_user_id is not null and v_step_run.assignee_user_id <> auth.uid() then
    raise exception 'This step is assigned to another member';
  end if;

  update process_step_runs set status = 'completed', completed_at = v_activation_at
  where workspace_id = p_workspace_id and id = p_step_run_id;

  select * into v_next_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id
    and step_index = v_step_run.step_index + 1 for update;

  if found then
    update process_step_runs
    set status = 'active', started_at = v_activation_at,
        due_at = private.process_due_at_from_config(v_next_step_run.config, v_activation_at)
    where workspace_id = p_workspace_id and id = v_next_step_run.id;
  else
    update process_runs set status = 'completed', completed_at = v_activation_at
    where workspace_id = p_workspace_id and id = p_process_run_id;
  end if;
end;
$$;

revoke all on function start_process_run_authorized(uuid, uuid, uuid, uuid) from public;
revoke all on function complete_process_step_run_authorized(uuid, uuid, uuid) from public;
revoke all on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public;
grant execute on function start_process_run_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function complete_process_step_run_authorized(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
revoke all on function private.process_due_at_from_config(jsonb, timestamptz) from public;

comment on column process_step_runs.due_at is
  'Absolute timestamp calculated at activation from this row''s snapshotted due_rule; null until activation or when no due rule exists.';
