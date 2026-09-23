-- Phase 15 foundation: Saved View presentation modes.
--
-- Existing Saved Views remain table views. Board and Calendar are persisted
-- as a mode plus a small typed JSON config, but rendering/mutation behavior
-- is implemented in later slices.

alter table entity_views
  add column if not exists presentation_mode text not null default 'table',
  add column if not exists presentation_config jsonb not null default '{}'::jsonb;

alter table entity_views
  drop constraint if exists entity_views_presentation_mode_check;

alter table entity_views
  add constraint entity_views_presentation_mode_check
  check (presentation_mode in ('table', 'board', 'calendar'));

create or replace function private.validate_entity_view_presentation_config(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_presentation_mode text,
  p_presentation_config jsonb
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_config jsonb := coalesce(p_presentation_config, '{}'::jsonb);
  v_key_count integer;
  v_field_id_text text;
  v_field field_definitions%rowtype;
begin
  if p_presentation_mode not in ('table', 'board', 'calendar') then
    raise exception 'Saved view presentation mode is invalid.';
  end if;

  if jsonb_typeof(v_config) <> 'object' then
    raise exception 'Saved view presentation config is invalid.';
  end if;

  select count(*) into v_key_count from jsonb_object_keys(v_config);

  if p_presentation_mode = 'table' then
    if v_key_count <> 0 then
      raise exception 'Table presentation must not have mode-specific config.';
    end if;
    return;
  end if;

  if p_presentation_mode = 'board' then
    if v_key_count <> 1 or not (v_config ? 'choiceFieldDefinitionId') then
      raise exception 'Board presentation must reference one Choice field.';
    end if;

    v_field_id_text := v_config ->> 'choiceFieldDefinitionId';

    if v_field_id_text is null
      or v_field_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Board presentation must reference one Choice field.';
    end if;

    select * into v_field
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = v_field_id_text::uuid
      and archived_at is null;

    if not found then
      raise exception 'Board presentation field must be an active field on this object.';
    end if;

    if v_field.type <> 'choice' then
      raise exception 'Board presentation field must be a Choice field.';
    end if;

    return;
  end if;

  if v_key_count <> 1 or not (v_config ? 'dateFieldDefinitionId') then
    raise exception 'Calendar presentation must reference one Date field.';
  end if;

  v_field_id_text := v_config ->> 'dateFieldDefinitionId';

  if v_field_id_text is null
    or v_field_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Calendar presentation must reference one Date field.';
  end if;

  select * into v_field
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = v_field_id_text::uuid
    and archived_at is null;

  if not found then
    raise exception 'Calendar presentation field must be an active field on this object.';
  end if;

  if v_field.type <> 'date' then
    raise exception 'Calendar presentation field must be a Date field.';
  end if;
end;
$$;

revoke all on function private.validate_entity_view_presentation_config(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function private.validate_entity_view_presentation_config(uuid, uuid, text, jsonb) to service_role;

create function create_entity_view_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_name text,
  p_filters jsonb,
  p_sorts jsonb,
  p_column_field_definition_ids jsonb,
  p_presentation_mode text,
  p_presentation_config jsonb
)
returns entity_views
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_view entity_views%rowtype;
  v_next_position integer;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if not exists (
    select 1 from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id
  ) then
    raise exception 'Entity type not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  perform private.validate_entity_view_presentation_config(
    p_workspace_id,
    p_entity_type_id,
    p_presentation_mode,
    p_presentation_config
  );

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) f
    join field_definitions fd on fd.workspace_id = p_workspace_id
      and fd.id = (f ->> 'fieldDefinitionId')::uuid and fd.type = 'choice'
    where f ->> 'value' is not null and f ->> 'value' <> ''
      and not exists (
        select 1 from field_choice_options co
        where co.workspace_id = p_workspace_id and co.field_definition_id = fd.id
          and co.id = (f ->> 'value')::uuid
      )
  ) then
    raise exception 'View filter references a Choice option that no longer exists';
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from entity_views where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id;

  insert into entity_views (
    id, workspace_id, entity_type_id, name, position, is_default, filters, sorts, column_field_definition_ids,
    presentation_mode, presentation_config
  )
  values (
    gen_random_uuid(), p_workspace_id, p_entity_type_id, p_name, v_next_position, false,
    coalesce(p_filters, '[]'::jsonb), coalesce(p_sorts, '[]'::jsonb), coalesce(p_column_field_definition_ids, '[]'::jsonb),
    p_presentation_mode, coalesce(p_presentation_config, '{}'::jsonb)
  )
  returning * into v_view;

  return v_view;
end;
$$;

create function update_entity_view_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_view_id uuid,
  p_name text,
  p_filters jsonb,
  p_sorts jsonb,
  p_column_field_definition_ids jsonb,
  p_presentation_mode text,
  p_presentation_config jsonb
)
returns entity_views
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_view entity_views%rowtype;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  perform private.validate_entity_view_presentation_config(
    p_workspace_id,
    p_entity_type_id,
    p_presentation_mode,
    p_presentation_config
  );

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) f
    join field_definitions fd on fd.workspace_id = p_workspace_id
      and fd.id = (f ->> 'fieldDefinitionId')::uuid and fd.type = 'choice'
    where f ->> 'value' is not null and f ->> 'value' <> ''
      and not exists (
        select 1 from field_choice_options co
        where co.workspace_id = p_workspace_id and co.field_definition_id = fd.id
          and co.id = (f ->> 'value')::uuid
      )
  ) then
    raise exception 'View filter references a Choice option that no longer exists';
  end if;

  update entity_views
  set name = p_name,
      filters = coalesce(p_filters, '[]'::jsonb),
      sorts = coalesce(p_sorts, '[]'::jsonb),
      column_field_definition_ids = coalesce(p_column_field_definition_ids, '[]'::jsonb),
      presentation_mode = p_presentation_mode,
      presentation_config = coalesce(p_presentation_config, '{}'::jsonb),
      updated_at = now()
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_view_id
  returning * into v_view;

  if not found then
    raise exception 'Entity view not found';
  end if;

  return v_view;
end;
$$;

revoke all on function create_entity_view_authorized(uuid, uuid, text, jsonb, jsonb, jsonb, text, jsonb) from public;
revoke all on function update_entity_view_authorized(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, text, jsonb) from public;
grant execute on function create_entity_view_authorized(uuid, uuid, text, jsonb, jsonb, jsonb, text, jsonb) to authenticated, service_role;
grant execute on function update_entity_view_authorized(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, text, jsonb) to authenticated, service_role;

comment on function create_entity_view_authorized(uuid, uuid, text, jsonb, jsonb, jsonb, text, jsonb)
  is 'records.operate-checked entity-view creation with presentation mode/config validation. Existing six-argument overload remains for table-compatible callers.';
comment on function update_entity_view_authorized(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, text, jsonb)
  is 'records.operate-checked entity-view update with presentation mode/config validation. Existing six-argument overload remains for table-compatible callers.';

create or replace function delete_field_definition_if_safe(
  p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid
)
returns table (
  deleted boolean, record_value_count bigint, relation_value_count bigint, workflow_reference_count bigint,
  display_field_reference_count bigint, view_reference_count bigint, process_branch_reference_count bigint
)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_field field_definitions%rowtype;
  v_template_token text;
  v_process_branch_reference_count bigint := 0;
  v_workspace_member_value_count bigint := 0;
  v_work_settings_reference_count bigint := 0;
begin
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found.'; end if;

  select count(*) into record_value_count from entity_records
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and values ? v_field.key;
  select count(*) into relation_value_count from entity_record_relation_values
  where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and field_definition_id = p_field_definition_id;
  select count(*) into v_workspace_member_value_count from entity_record_workspace_member_values
  where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and field_definition_id = p_field_definition_id;
  relation_value_count := relation_value_count + v_workspace_member_value_count;
  select count(*) into display_field_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id and display_field_definition_id = p_field_definition_id;
  select count(*) into v_work_settings_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
    and (
      work_assignment_field_id = p_field_definition_id
      or work_due_field_id = p_field_definition_id
      or work_status_field_id = p_field_definition_id
    );
  display_field_reference_count := display_field_reference_count + v_work_settings_reference_count;
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
    or (
      view.presentation_mode = 'board'
      and view.presentation_config ->> 'choiceFieldDefinitionId' = p_field_definition_id::text
    )
    or (
      view.presentation_mode = 'calendar'
      and view.presentation_config ->> 'dateFieldDefinitionId' = p_field_definition_id::text
    )
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
