-- Corrects the 0031 start function on already-migrated databases. PostgreSQL
-- has no min(uuid) aggregate; a deterministic array aggregate selects the
-- sole validated start node instead.

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
  v_activation_at timestamptz := now();
  v_node process_nodes%rowtype;
  v_assignee_label text;
  v_node_count integer;
  v_start_count integer;
  v_edge process_edges%rowtype;
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
    select 1 from process_runs where workspace_id = p_workspace_id and process_template_id = p_process_template_id
      and origin_record_id = p_origin_record_id and status = 'active'
  ) then raise exception 'This process is already running for this record'; end if;

  select count(*) into v_node_count from process_nodes
  where workspace_id = p_workspace_id and process_template_id = p_process_template_id;
  if v_node_count = 0 then raise exception 'Process template has no steps'; end if;
  select count(*), (array_agg(n.id order by n.position))[1] into v_start_count, v_start_node_id
  from process_nodes n
  where n.workspace_id = p_workspace_id and n.process_template_id = p_process_template_id
    and not exists (
      select 1 from process_edges e where e.workspace_id = p_workspace_id
        and e.process_template_id = p_process_template_id and e.target_node_id = n.id
    );
  if v_start_count <> 1 then raise exception 'Process template must have exactly one start step'; end if;
  if exists (
    select 1 from process_nodes n where n.workspace_id = p_workspace_id and n.process_template_id = p_process_template_id and n.position > 1
      and not exists (select 1 from process_edges e where e.workspace_id = p_workspace_id and e.process_template_id = p_process_template_id and e.target_node_id = n.id)
  ) then raise exception 'Process template contains an unreachable step'; end if;
  for v_edge in select * from process_edges
    where workspace_id = p_workspace_id and process_template_id = p_process_template_id and not is_default
  loop
    perform private.validate_process_branch_conditions(p_workspace_id, p_origin_entity_type_id, v_edge.condition_config);
  end loop;

  insert into process_runs (
    id, workspace_id, process_template_id, process_template_name, process_template_description,
    origin_entity_type_id, origin_record_id, status
  ) values (
    v_run_id, p_workspace_id, p_process_template_id, v_template.name, v_template.description,
    p_origin_entity_type_id, p_origin_record_id, 'active'
  );

  for v_node in select * from process_nodes
    where workspace_id = p_workspace_id and process_template_id = p_process_template_id order by position
  loop
    v_assignee_label := null;
    if v_node.assignee_user_id is not null then
      select email into v_assignee_label from auth.users where id = v_node.assignee_user_id;
    end if;
    insert into process_step_runs (
      id, workspace_id, process_run_id, source_node_id, step_index, node_type, name, config,
      status, started_at, due_at, assignee_user_id, assignee_label
    ) values (
      gen_random_uuid(), p_workspace_id, v_run_id, v_node.id, v_node.position, v_node.node_type, v_node.name,
      v_node.config, case when v_node.id = v_start_node_id then 'active' else 'pending' end,
      case when v_node.id = v_start_node_id then v_activation_at else null end,
      case when v_node.id = v_start_node_id then private.process_due_at_from_config(v_node.config, v_activation_at) else null end,
      v_node.assignee_user_id, v_assignee_label
    );
  end loop;

  insert into process_step_run_routes (
    workspace_id, process_run_id, source_step_run_id, target_step_run_id, source_node_id, target_node_id,
    priority, condition_config, condition_summary, is_default
  )
  select e.workspace_id, v_run_id, source_step.id, target_step.id, e.source_node_id, e.target_node_id,
    e.priority, e.condition_config,
    case when e.is_default then null else private.process_branch_condition_summary(p_workspace_id, p_origin_entity_type_id, e.condition_config) end,
    e.is_default
  from process_edges e
  join process_step_runs source_step
    on source_step.workspace_id = e.workspace_id and source_step.process_run_id = v_run_id and source_step.source_node_id = e.source_node_id
  join process_step_runs target_step
    on target_step.workspace_id = e.workspace_id and target_step.process_run_id = v_run_id and target_step.source_node_id = e.target_node_id
  where e.workspace_id = p_workspace_id and e.process_template_id = p_process_template_id;

  return v_run_id;
end;
$$;

revoke all on function start_process_run_authorized(uuid, uuid, uuid, uuid) from public;
grant execute on function start_process_run_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;
