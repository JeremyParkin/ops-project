-- Process Graph 5A: deterministic single-path conditional branching. Template
-- position is editor/topological metadata only; every started run follows its
-- own process_step_run_routes snapshot and never consults live process_edges.

alter table process_nodes add column position integer;

with recursive ordered as (
  select n.workspace_id, n.process_template_id, n.id, 1 as position
  from process_nodes n
  where not exists (
    select 1 from process_edges e
    where e.workspace_id = n.workspace_id
      and e.process_template_id = n.process_template_id
      and e.target_node_id = n.id
  )
  union all
  select n.workspace_id, n.process_template_id, n.id, ordered.position + 1
  from ordered
  join process_edges e
    on e.workspace_id = ordered.workspace_id
   and e.process_template_id = ordered.process_template_id
   and e.source_node_id = ordered.id
  join process_nodes n
    on n.workspace_id = e.workspace_id
   and n.process_template_id = e.process_template_id
   and n.id = e.target_node_id
)
update process_nodes n
set position = ordered.position
from ordered
where n.workspace_id = ordered.workspace_id
  and n.process_template_id = ordered.process_template_id
  and n.id = ordered.id;

-- A valid pre-0031 template was a single chain, so the recursive pass above
-- assigns every node. Keep the migration deterministic even if an old draft
-- contains a disconnected/cyclic fragment rather than failing a uniqueness
-- constraint while assigning every remaining node position 1.
with missing_positions as (
  select
    node.id,
    coalesce(existing.max_position, 0)
      + row_number() over (
        partition by node.workspace_id, node.process_template_id
        order by node.created_at, node.id
      ) as position
  from process_nodes node
  left join lateral (
    select max(position) as max_position
    from process_nodes existing_node
    where existing_node.workspace_id = node.workspace_id
      and existing_node.process_template_id = node.process_template_id
      and existing_node.position is not null
  ) existing on true
  where node.position is null
)
update process_nodes node
set position = missing_positions.position
from missing_positions
where node.id = missing_positions.id;
alter table process_nodes alter column position set not null;
alter table process_nodes add constraint process_nodes_position_positive_check check (position > 0);
alter table process_nodes add constraint process_nodes_workspace_template_position_key unique (workspace_id, process_template_id, position);

alter table process_edges
  add column priority integer not null default 0,
  add column condition_config jsonb,
  add column is_default boolean not null default true;

alter table process_edges
  drop constraint if exists process_edges_workspace_id_source_node_id_key,
  drop constraint if exists process_edges_workspace_id_target_node_id_key;

alter table process_edges
  add constraint process_edges_priority_non_negative_check check (priority >= 0),
  add constraint process_edges_routing_shape_check check (
    (is_default and condition_config is null)
    or (
      not is_default
      and jsonb_typeof(condition_config) = 'array'
      and jsonb_array_length(condition_config) > 0
    )
  ),
  add constraint process_edges_workspace_template_source_priority_key
    unique (workspace_id, process_template_id, source_node_id, priority),
  add constraint process_edges_workspace_template_source_target_key
    unique (workspace_id, process_template_id, source_node_id, target_node_id);

create unique index process_edges_one_default_per_source_idx
  on process_edges (workspace_id, process_template_id, source_node_id)
  where is_default;

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'process_step_runs'::regclass
      and contype = 'c'
  loop
    execute format('alter table process_step_runs drop constraint %I', constraint_row.conname);
  end loop;
end;
$$;

alter table process_step_runs
  add column routing_result jsonb,
  add constraint process_step_runs_routing_result_object_check
    check (routing_result is null or jsonb_typeof(routing_result) = 'object'),
  add constraint process_step_runs_status_check
    check (status in ('pending', 'active', 'completed', 'skipped')),
  add constraint process_step_runs_lifecycle_check
    check (
      (status = 'pending' and started_at is null and completed_at is null and due_at is null)
      or (status = 'active' and started_at is not null and completed_at is null)
      or (status = 'completed' and started_at is not null and completed_at is not null)
      or (status = 'skipped' and started_at is null and completed_at is null and due_at is null)
    ),
  add constraint process_step_runs_workspace_run_id_key unique (workspace_id, process_run_id, id);

create table process_step_run_routes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_run_id uuid not null,
  source_step_run_id uuid not null,
  target_step_run_id uuid not null,
  source_node_id uuid,
  target_node_id uuid,
  priority integer not null check (priority >= 0),
  condition_config jsonb,
  condition_summary text,
  is_default boolean not null,
  created_at timestamptz not null default now(),

  check (source_step_run_id <> target_step_run_id),
  check (
    (is_default and condition_config is null)
    or (
      not is_default
      and jsonb_typeof(condition_config) = 'array'
      and jsonb_array_length(condition_config) > 0
    )
  ),
  unique (workspace_id, process_run_id, source_step_run_id, priority),
  unique (workspace_id, process_run_id, source_step_run_id, target_step_run_id),

  foreign key (workspace_id, process_run_id)
    references process_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, process_run_id, source_step_run_id)
    references process_step_runs(workspace_id, process_run_id, id) on delete cascade,
  foreign key (workspace_id, process_run_id, target_step_run_id)
    references process_step_runs(workspace_id, process_run_id, id) on delete cascade
);

create unique index process_step_run_routes_one_default_per_source_idx
  on process_step_run_routes (workspace_id, process_run_id, source_step_run_id)
  where is_default;
create index process_step_run_routes_source_idx
  on process_step_run_routes (workspace_id, process_run_id, source_step_run_id, priority);

alter table process_step_run_routes enable row level security;
create policy process_step_run_routes_member_access on process_step_run_routes
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));
revoke all on table process_step_run_routes from anon, authenticated;
grant select on table process_step_run_routes to authenticated;
create trigger process_step_run_routes_workspace_id_immutable
  before update on process_step_run_routes
  for each row execute function private.reject_workspace_id_change();

-- Pre-0031 templates were valid linear chains. Their edges are now explicit
-- default routes. Existing runs are backfilled from their own instantiated
-- StepRun order, never from editable template rows.
insert into process_step_run_routes (
  workspace_id, process_run_id, source_step_run_id, target_step_run_id,
  source_node_id, target_node_id, priority, condition_config, is_default
)
select workspace_id, process_run_id, id, next_step_run_id,
  source_node_id, next_source_node_id, 0, null, true
from (
  select s.*, lead(id) over run_order as next_step_run_id,
    lead(source_node_id) over run_order as next_source_node_id
  from process_step_runs s
  window run_order as (partition by workspace_id, process_run_id order by step_index)
) ordered_steps
where next_step_run_id is not null;

create or replace function private.validate_process_branch_conditions(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_conditions jsonb
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_condition jsonb;
  v_field field_definitions%rowtype;
  v_operator text;
  v_value_type text;
  v_value_text text;
  v_value_uuid uuid;
  v_needs_value boolean;
begin
  if p_conditions is null
    or jsonb_typeof(p_conditions) <> 'array'
    or jsonb_array_length(p_conditions) = 0 then
    raise exception 'Process branch conditions must be a non-empty array';
  end if;

  for v_condition in select * from jsonb_array_elements(p_conditions)
  loop
    if jsonb_typeof(v_condition) <> 'object'
      or v_condition - 'sourceFieldDefinitionId' - 'operator' - 'value' <> '{}'::jsonb
      or not (v_condition ? 'sourceFieldDefinitionId')
      or not (v_condition ? 'operator')
      or jsonb_typeof(v_condition->'sourceFieldDefinitionId') <> 'string'
      or jsonb_typeof(v_condition->'operator') <> 'string' then
      raise exception 'Process branch condition is invalid';
    end if;

    select * into v_field
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = (v_condition->>'sourceFieldDefinitionId')::uuid
      and archived_at is null;

    if not found then
      raise exception 'Process branch condition references a missing or archived field';
    end if;

    v_operator := v_condition->>'operator';
    v_needs_value := v_operator in (
      'equals', 'not_equals', 'contains', 'not_contains', 'greater_than',
      'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'before', 'after'
    );

    if (v_field.type = 'text' and v_operator not in ('equals', 'not_equals', 'contains', 'not_contains', 'is_set', 'is_not_set'))
      or (v_field.type = 'number' and v_operator not in ('equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'is_set', 'is_not_set'))
      or (v_field.type = 'date' and v_operator not in ('equals', 'before', 'after', 'is_set', 'is_not_set'))
      or (v_field.type = 'boolean' and v_operator not in ('equals', 'is_set', 'is_not_set'))
      or (v_field.type = 'relation' and v_operator not in ('equals', 'not_equals', 'is_set', 'is_not_set')) then
      raise exception '% is not valid for process branch field %', v_operator, v_field.name;
    end if;

    if not v_needs_value then
      if v_condition ? 'value' then
        raise exception 'Process branch condition does not accept a comparison value';
      end if;
      continue;
    end if;

    if not (v_condition ? 'value') then
      raise exception 'Process branch condition needs a comparison value';
    end if;

    v_value_type := jsonb_typeof(v_condition->'value');
    if (v_field.type in ('text', 'date', 'relation') and v_value_type <> 'string')
      or (v_field.type = 'number' and v_value_type <> 'number')
      or (v_field.type = 'boolean' and v_value_type <> 'boolean') then
      raise exception 'Process branch condition value has the wrong type for %', v_field.name;
    end if;

    v_value_text := v_condition->>'value';
    if v_field.type = 'date' then
      begin
        if v_value_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          or to_char(v_value_text::date, 'YYYY-MM-DD') <> v_value_text then
          raise exception 'invalid';
        end if;
      exception when others then
        raise exception 'Process branch condition date must be YYYY-MM-DD';
      end;
    elsif v_field.type = 'relation' then
      begin
        v_value_uuid := v_value_text::uuid;
      exception when others then
        raise exception 'Process branch condition relation value is invalid';
      end;
      if not exists (
        select 1 from entity_records
        where workspace_id = p_workspace_id
          and entity_type_id = v_field.related_entity_type_id
          and id = v_value_uuid
          and archived_at is null
      ) then
        raise exception 'Process branch condition relation record is missing or archived';
      end if;
    end if;
  end loop;
end;
$$;

create or replace function private.process_branch_condition_summary(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_conditions jsonb
)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select string_agg(
    field.name || ' ' || replace(condition.value->>'operator', '_', ' ') ||
      case when condition.value ? 'value' then ' ' || (condition.value->>'value') else '' end,
    ' AND ' order by condition.ordinality
  )
  from jsonb_array_elements(p_conditions) with ordinality as condition(value, ordinality)
  join field_definitions field
    on field.workspace_id = p_workspace_id
   and field.entity_type_id = p_entity_type_id
   and field.id = (condition.value->>'sourceFieldDefinitionId')::uuid;
$$;

create or replace function private.evaluate_process_branch_conditions(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_origin_record_id uuid,
  p_conditions jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_origin entity_records%rowtype;
  v_condition jsonb;
  v_field field_definitions%rowtype;
  v_actual jsonb;
  v_expected jsonb;
  v_is_set boolean;
  v_matches boolean;
  v_all_match boolean := true;
  v_context jsonb := '[]'::jsonb;
  v_relation_value uuid;
begin
  select * into v_origin
  from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_origin_record_id
    and archived_at is null
  for share;

  if not found then
    raise exception 'Origin record not found or archived';
  end if;

  perform private.validate_process_branch_conditions(
    p_workspace_id, p_entity_type_id, p_conditions
  );

  for v_condition in select * from jsonb_array_elements(p_conditions)
  loop
    select * into v_field
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = (v_condition->>'sourceFieldDefinitionId')::uuid
      and archived_at is null;

    if v_field.type = 'relation' then
      select target_record_id into v_relation_value
      from entity_record_relation_values
      where workspace_id = p_workspace_id
        and source_entity_type_id = p_entity_type_id
        and source_record_id = p_origin_record_id
        and field_definition_id = v_field.id;
      v_actual := case when v_relation_value is null then null else to_jsonb(v_relation_value::text) end;
    else
      v_actual := v_origin.values -> v_field.key;
    end if;

    v_expected := v_condition->'value';
    v_is_set := v_actual is not null
      and v_actual <> 'null'::jsonb
      and (v_field.type <> 'text' or btrim(v_actual->>'') <> '');

    if v_condition->>'operator' = 'is_set' then
      v_matches := v_is_set;
    elsif v_condition->>'operator' = 'is_not_set' then
      v_matches := not v_is_set;
    elsif not v_is_set then
      v_matches := false;
    elsif v_field.type = 'text' then
      case v_condition->>'operator'
        when 'equals' then v_matches := v_actual->>'' = v_expected->>'';
        when 'not_equals' then v_matches := v_actual->>'' <> v_expected->>'';
        when 'contains' then v_matches := lower(v_actual->>'') like '%' || lower(v_expected->>'') || '%';
        when 'not_contains' then v_matches := lower(v_actual->>'') not like '%' || lower(v_expected->>'') || '%';
        else v_matches := false;
      end case;
    elsif v_field.type = 'number' then
      case v_condition->>'operator'
        when 'equals' then v_matches := (v_actual->>'')::numeric = (v_expected->>'')::numeric;
        when 'not_equals' then v_matches := (v_actual->>'')::numeric <> (v_expected->>'')::numeric;
        when 'greater_than' then v_matches := (v_actual->>'')::numeric > (v_expected->>'')::numeric;
        when 'greater_than_or_equal' then v_matches := (v_actual->>'')::numeric >= (v_expected->>'')::numeric;
        when 'less_than' then v_matches := (v_actual->>'')::numeric < (v_expected->>'')::numeric;
        when 'less_than_or_equal' then v_matches := (v_actual->>'')::numeric <= (v_expected->>'')::numeric;
        else v_matches := false;
      end case;
    elsif v_field.type = 'date' then
      case v_condition->>'operator'
        when 'equals' then v_matches := v_actual->>'' = v_expected->>'';
        when 'before' then v_matches := v_actual->>'' < v_expected->>'';
        when 'after' then v_matches := v_actual->>'' > v_expected->>'';
        else v_matches := false;
      end case;
    elsif v_field.type = 'boolean' then
      v_matches := v_condition->>'operator' = 'equals' and v_actual = v_expected;
    else
      case v_condition->>'operator'
        when 'equals' then v_matches := v_actual->>'' = v_expected->>'';
        when 'not_equals' then v_matches := v_actual->>'' <> v_expected->>'';
        else v_matches := false;
      end case;
    end if;

    v_context := v_context || jsonb_build_array(jsonb_build_object(
      'fieldName', v_field.name,
      'operator', v_condition->>'operator',
      'expectedValue', v_expected,
      'actualValue', v_actual,
      'matched', v_matches
    ));
    v_all_match := v_all_match and v_matches;
  end loop;

  return jsonb_build_object('matched', v_all_match, 'conditions', v_context);
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
  v_target_node_id uuid;
  v_step_name text;
  v_client_key text;
  v_target_client_key text;
  v_step_assignee_user_id uuid;
  v_due_rule jsonb;
  v_node_config jsonb;
  v_routes jsonb;
  v_conditions jsonb;
  v_seen_node_ids uuid[] := '{}'::uuid[];
  v_seen_client_keys text[] := '{}'::text[];
  v_seen_target_keys text[];
  v_final_node_ids uuid[] := '{}'::uuid[];
  v_node_by_client_key jsonb := '{}'::jsonb;
  v_position_by_client_key jsonb := '{}'::jsonb;
  v_index integer;
  v_route_index integer;
  v_route_count integer;
  v_default_count integer;
  v_is_default boolean;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'A process template requires at least one step';
  end if;
  if nullif(trim(p_name), '') is null then raise exception 'A process template requires a name'; end if;
  if not exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id and id = p_applies_to_entity_type_id and archived_at is null
  ) then raise exception 'Applies-to entity type not found or archived'; end if;

  if p_process_template_id is null then
    v_template_id := gen_random_uuid();
    insert into process_templates (id, workspace_id, name, description, applies_to_entity_type_id)
    values (v_template_id, p_workspace_id, trim(p_name), nullif(trim(coalesce(p_description, '')), ''), p_applies_to_entity_type_id);
  else
    select applies_to_entity_type_id, archived_at into v_existing_applies_to, v_existing_archived_at
    from process_templates where workspace_id = p_workspace_id and id = p_process_template_id for update;
    if not found then raise exception 'Process template not found'; end if;
    if v_existing_archived_at is not null then raise exception 'Archived process templates are read-only. Restore before editing.'; end if;
    if v_existing_applies_to <> p_applies_to_entity_type_id then raise exception 'Applies-to entity type cannot be changed after creation'; end if;
    v_template_id := p_process_template_id;
    update process_templates set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''), updated_at = now()
    where workspace_id = p_workspace_id and id = v_template_id;
    update process_nodes set position = position + 1000000
    where workspace_id = p_workspace_id and process_template_id = v_template_id;
  end if;

  for v_index in 1 .. jsonb_array_length(p_steps) loop
    v_step := p_steps -> (v_index - 1);
    if jsonb_typeof(v_step) <> 'object'
      or v_step - 'client_key' - 'node_id' - 'name' - 'assignee_user_id' - 'due_rule' - 'routes' <> '{}'::jsonb then
      raise exception 'Process step configuration is invalid';
    end if;
    v_client_key := nullif(trim(coalesce(v_step->>'client_key', '')), '');
    v_step_name := nullif(trim(coalesce(v_step->>'name', '')), '');
    v_step_assignee_user_id := nullif(v_step->>'assignee_user_id', '')::uuid;
    v_due_rule := v_step->'due_rule';
    v_node_config := case when v_due_rule is null or v_due_rule = 'null'::jsonb then '{}'::jsonb else jsonb_build_object('due_rule', v_due_rule) end;
    perform private.process_due_at_from_config(v_node_config, now());
    if v_client_key is null or v_client_key = any(v_seen_client_keys) then raise exception 'Duplicate or missing step client key'; end if;
    if v_step_name is null then raise exception 'Every step requires a name'; end if;
    if v_step_assignee_user_id is not null and not exists (
      select 1 from workspace_memberships where workspace_id = p_workspace_id and user_id = v_step_assignee_user_id
    ) then raise exception 'Assignee is not a member of this workspace'; end if;

    v_step_node_id := nullif(v_step->>'node_id', '')::uuid;
    if v_step_node_id is not null then
      if v_step_node_id = any(v_seen_node_ids) then raise exception 'Duplicate step submitted'; end if;
      if not exists (
        select 1 from process_nodes where workspace_id = p_workspace_id and process_template_id = v_template_id and id = v_step_node_id
      ) then raise exception 'Submitted step does not belong to this template'; end if;
      update process_nodes set name = v_step_name, position = v_index, assignee_user_id = v_step_assignee_user_id,
        config = v_node_config, updated_at = now()
      where workspace_id = p_workspace_id and id = v_step_node_id;
    else
      v_step_node_id := gen_random_uuid();
      insert into process_nodes (id, workspace_id, process_template_id, node_type, name, position, assignee_user_id, config)
      values (v_step_node_id, p_workspace_id, v_template_id, 'human_task', v_step_name, v_index, v_step_assignee_user_id, v_node_config);
    end if;
    v_seen_node_ids := v_seen_node_ids || v_step_node_id;
    v_seen_client_keys := v_seen_client_keys || v_client_key;
    v_final_node_ids := v_final_node_ids || v_step_node_id;
    v_node_by_client_key := v_node_by_client_key || jsonb_build_object(v_client_key, v_step_node_id::text);
    v_position_by_client_key := v_position_by_client_key || jsonb_build_object(v_client_key, v_index);
  end loop;

  delete from process_nodes
  where workspace_id = p_workspace_id and process_template_id = v_template_id and not (id = any(v_final_node_ids));
  delete from process_edges where workspace_id = p_workspace_id and process_template_id = v_template_id;

  for v_index in 1 .. jsonb_array_length(p_steps) loop
    v_step := p_steps -> (v_index - 1);
    v_step_node_id := (v_node_by_client_key ->> (v_step->>'client_key'))::uuid;
    v_routes := v_step->'routes';
    if v_routes is null then v_routes := '[]'::jsonb; end if;
    if jsonb_typeof(v_routes) <> 'array' then raise exception 'Process routes must be an array'; end if;
    v_route_count := jsonb_array_length(v_routes);

    if v_route_count = 0 then
      if v_index < jsonb_array_length(p_steps) then
        v_target_client_key := (p_steps -> v_index)->>'client_key';
        insert into process_edges (workspace_id, process_template_id, source_node_id, target_node_id, priority, condition_config, is_default)
        values (p_workspace_id, v_template_id, v_step_node_id, (v_node_by_client_key->>v_target_client_key)::uuid, 0, null, true);
      end if;
      continue;
    end if;

    select count(*) into v_default_count
    from jsonb_array_elements(v_routes) route where route->>'is_default' = 'true';
    if (v_route_count = 1 and v_default_count <> 1) or (v_route_count > 1 and v_default_count <> 1) then
      raise exception 'A routed step requires exactly one default route';
    end if;
    v_seen_target_keys := '{}'::text[];

    for v_route_index in 1 .. v_route_count loop
      v_route := v_routes -> (v_route_index - 1);
      if jsonb_typeof(v_route) <> 'object'
        or v_route - 'target_client_key' - 'is_default' - 'conditions' <> '{}'::jsonb
        or jsonb_typeof(v_route->'target_client_key') <> 'string'
        or jsonb_typeof(v_route->'is_default') <> 'boolean' then
        raise exception 'Process route configuration is invalid';
      end if;
      v_target_client_key := nullif(trim(v_route->>'target_client_key'), '');
      v_is_default := (v_route->>'is_default')::boolean;
      if v_target_client_key is null or not (v_node_by_client_key ? v_target_client_key) then raise exception 'Route target does not belong to this template'; end if;
      if v_target_client_key = any(v_seen_target_keys) then raise exception 'A step cannot contain duplicate routes to the same target'; end if;
      if (v_position_by_client_key->>v_target_client_key)::integer <= v_index then raise exception 'Routes must point to a later step'; end if;
      v_conditions := v_route->'conditions';
      if v_is_default then
        if v_conditions is not null and (jsonb_typeof(v_conditions) <> 'array' or jsonb_array_length(v_conditions) <> 0) then
          raise exception 'Default process routes cannot have conditions';
        end if;
        v_conditions := null;
      else
        perform private.validate_process_branch_conditions(p_workspace_id, p_applies_to_entity_type_id, v_conditions);
      end if;
      insert into process_edges (workspace_id, process_template_id, source_node_id, target_node_id, priority, condition_config, is_default)
      values (p_workspace_id, v_template_id, v_step_node_id, (v_node_by_client_key->>v_target_client_key)::uuid,
        v_route_index - 1, v_conditions, v_is_default);
      v_seen_target_keys := v_seen_target_keys || v_target_client_key;
    end loop;
  end loop;

  if exists (
    select 1 from process_nodes n
    where n.workspace_id = p_workspace_id and n.process_template_id = v_template_id and n.position > 1
      and not exists (select 1 from process_edges e where e.workspace_id = p_workspace_id and e.process_template_id = v_template_id and e.target_node_id = n.id)
  ) then raise exception 'Every step after the first must be reachable from an earlier step'; end if;

  return v_template_id;
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
  v_run process_runs%rowtype;
  v_target_step_run process_step_runs%rowtype;
  v_route process_step_run_routes%rowtype;
  v_default_route process_step_run_routes%rowtype;
  v_route_count integer;
  v_default_count integer;
  v_selected_route_id uuid;
  v_outcome text;
  v_evaluation jsonb;
  v_evaluated_conditions jsonb := '[]'::jsonb;
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
  select * into v_run from process_runs
  where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active' for update;
  if not found then raise exception 'Process run is not active'; end if;
  -- Lock and validate the live origin before evaluating its current values.
  perform 1 from entity_records where workspace_id = p_workspace_id
    and entity_type_id = v_run.origin_entity_type_id and id = v_run.origin_record_id and archived_at is null for share;
  if not found then raise exception 'Origin record not found or archived'; end if;

  select count(*), count(*) filter (where is_default) into v_route_count, v_default_count
  from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = p_step_run_id;

  if v_route_count = 0 then
    update process_step_runs set status = 'completed', completed_at = v_activation_at
    where workspace_id = p_workspace_id and id = p_step_run_id;
    update process_step_runs set status = 'skipped', due_at = null
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id and status = 'pending';
    update process_runs set status = 'completed', completed_at = v_activation_at
    where workspace_id = p_workspace_id and id = p_process_run_id;
    return;
  end if;
  if v_default_count <> 1 then raise exception 'Process route configuration has no unambiguous default'; end if;
  select * into v_default_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = p_step_run_id and is_default;

  if v_route_count = 1 then
    v_selected_route_id := v_default_route.id;
    v_outcome := 'unconditional';
  else
    for v_route in select * from process_step_run_routes
      where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = p_step_run_id and not is_default
      order by priority
    loop
      v_evaluation := private.evaluate_process_branch_conditions(
        p_workspace_id, v_run.origin_entity_type_id, v_run.origin_record_id, v_route.condition_config
      );
      v_evaluated_conditions := v_evaluated_conditions || coalesce(v_evaluation->'conditions', '[]'::jsonb);
      if coalesce((v_evaluation->>'matched')::boolean, false) then
        v_selected_route_id := v_route.id;
        v_outcome := 'matched_condition';
        exit;
      end if;
    end loop;
    if v_selected_route_id is null then
      v_selected_route_id := v_default_route.id;
      v_outcome := 'default_fallback';
    end if;
  end if;

  select * into v_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_selected_route_id;
  select * into v_target_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_route.target_step_run_id for update;
  if not found or v_target_step_run.status <> 'pending' then raise exception 'Process route target is not available'; end if;

  update process_step_runs set status = 'completed', completed_at = v_activation_at,
    routing_result = jsonb_build_object(
      'selectedRouteId', v_route.id,
      'targetStepRunId', v_target_step_run.id,
      'outcome', v_outcome,
      'evaluatedAt', v_activation_at,
      'evaluatedConditions', v_evaluated_conditions
    )
  where workspace_id = p_workspace_id and id = p_step_run_id;
  update process_step_runs set status = 'active', started_at = v_activation_at,
    due_at = private.process_due_at_from_config(v_target_step_run.config, v_activation_at)
  where workspace_id = p_workspace_id and id = v_target_step_run.id;

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
  where step_run.workspace_id = p_workspace_id
    and step_run.process_run_id = p_process_run_id
    and step_run.status = 'pending'
    and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
end;
$$;

-- A field remains a hard-delete dependency while a live template references
-- it, or while an active run still has a pending/active route that may need
-- to evaluate it. Completed routing_result rows retain their own history and
-- do not block deletion forever on their own.
drop function if exists delete_field_definition_if_safe_authorized(uuid, uuid, uuid);
drop function if exists delete_field_definition_if_safe(uuid, uuid, uuid);

create function delete_field_definition_if_safe(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns table (
  deleted boolean,
  record_value_count bigint,
  relation_value_count bigint,
  workflow_reference_count bigint,
  display_field_reference_count bigint,
  view_reference_count bigint,
  process_branch_reference_count bigint
)
language plpgsql
set search_path = public
as $$
declare
  v_field field_definitions%rowtype;
  v_template_token text;
  v_process_branch_reference_count bigint := 0;
begin
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id
  for update;
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
  from process_edges edge
  join process_templates template
    on template.workspace_id = edge.workspace_id and template.id = edge.process_template_id
  where edge.workspace_id = p_workspace_id
    and template.applies_to_entity_type_id = p_entity_type_id
    and exists (
      select 1 from jsonb_array_elements(coalesce(edge.condition_config, '[]'::jsonb)) condition
      where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text
    );

  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_step_run_routes route
  join process_step_runs source_step
    on source_step.workspace_id = route.workspace_id and source_step.id = route.source_step_run_id
  join process_runs run
    on run.workspace_id = route.workspace_id and run.id = route.process_run_id
  where route.workspace_id = p_workspace_id
    and run.origin_entity_type_id = p_entity_type_id
    and run.status = 'active'
    and source_step.status in ('pending', 'active')
    and exists (
      select 1 from jsonb_array_elements(coalesce(route.condition_config, '[]'::jsonb)) condition
      where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text
    );

  process_branch_reference_count := v_process_branch_reference_count;

  if record_value_count = 0 and relation_value_count = 0 and workflow_reference_count = 0
    and display_field_reference_count = 0 and view_reference_count = 0 and v_process_branch_reference_count = 0 then
    delete from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id;
    deleted := true;
  else
    deleted := false;
  end if;
  return next;
end;
$$;

create function delete_field_definition_if_safe_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns table (
  deleted boolean,
  record_value_count bigint,
  relation_value_count bigint,
  workflow_reference_count bigint,
  display_field_reference_count bigint,
  view_reference_count bigint,
  process_branch_reference_count bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  return query select * from delete_field_definition_if_safe(p_workspace_id, p_entity_type_id, p_field_definition_id);
end;
$$;

revoke all on function private.validate_process_branch_conditions(uuid, uuid, jsonb) from public;
revoke all on function private.process_branch_condition_summary(uuid, uuid, jsonb) from public;
revoke all on function private.evaluate_process_branch_conditions(uuid, uuid, uuid, jsonb) from public;
revoke all on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public;
revoke all on function start_process_run_authorized(uuid, uuid, uuid, uuid) from public;
revoke all on function complete_process_step_run_authorized(uuid, uuid, uuid) from public;
revoke all on function delete_field_definition_if_safe(uuid, uuid, uuid) from public, authenticated;
revoke all on function delete_field_definition_if_safe_authorized(uuid, uuid, uuid) from public;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function start_process_run_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function complete_process_step_run_authorized(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function delete_field_definition_if_safe(uuid, uuid, uuid) to service_role;
grant execute on function delete_field_definition_if_safe_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on table process_step_run_routes is
  'Immutable per-run route snapshot. Existing runs never consult live process_edges when choosing the next step.';
comment on column process_step_runs.routing_result is
  'Compact completed-step routing history: selected route/target, outcome, timestamp, and evaluated condition context.';
