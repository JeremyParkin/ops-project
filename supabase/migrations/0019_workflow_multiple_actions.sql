-- Step 1: add the new ordered-actions representation, nullable so existing
-- rows can be backfilled before any constraint is enforced.
alter table workflows
  add column actions jsonb;

-- Step 2: backfill every existing single-action workflow into a one-element
-- actions[] array, and strip the now-redundant per-action keys out of
-- action_config so it holds only workflow-level trigger/condition config.
update workflows
set actions = jsonb_build_array(
  jsonb_strip_nulls(
    jsonb_build_object(
      'actionType', action_type,
      'actionTargetEntityTypeId', action_target_entity_type_id,
      'relatedFieldDefinitionId', action_config ->> 'relatedFieldDefinitionId',
      'fieldMappings', coalesce(action_config -> 'fieldMappings', '[]'::jsonb)
    )
  )
)
where actions is null;

update workflows
set action_config = jsonb_build_object(
  'triggerConfig', action_config -> 'triggerConfig',
  'conditions', coalesce(action_config -> 'conditions', '[]'::jsonb)
);

-- Step 3: validate the backfill before enforcing any new constraint.
do $$
declare
  v_unbackfilled_count bigint;
begin
  select count(*) into v_unbackfilled_count from workflows where actions is null;

  if v_unbackfilled_count > 0 then
    raise exception
      'Workflow actions backfill incomplete: % rows still have a null actions array.',
      v_unbackfilled_count;
  end if;
end;
$$;

-- Step 4: only now enforce the new representation and remove the old one.
alter table workflows
  alter column actions set not null;

alter table workflows
  add constraint workflows_actions_not_empty_check
    check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) >= 1);

alter table workflows
  drop constraint workflows_action_type_check;

alter table workflows
  drop constraint workflows_action_target_entity_type_id_check;

alter table workflows
  drop column action_type,
  drop column action_target_entity_type_id;

-- Structured per-action execution results, alongside the existing
-- execution-level summary fields. See mapWorkflowExecutionLog /
-- executeWorkflowActions for the authoritative TypeScript shape and the
-- legacy-singular-field backward-compatibility rules.
alter table workflow_execution_logs
  add column action_results jsonb not null default '[]'::jsonb;

create or replace function delete_field_definition_if_safe(
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
  view_reference_count bigint
)
language plpgsql
set search_path = public
as $$
declare
  v_field field_definitions%rowtype;
  v_template_token text;
begin
  select *
    into v_field
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_field_definition_id
  for update;

  if not found then
    raise exception 'Field definition not found.';
  end if;

  select count(*)
    into record_value_count
  from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and values ? v_field.key;

  select count(*)
    into relation_value_count
  from entity_record_relation_values
  where workspace_id = p_workspace_id
    and source_entity_type_id = p_entity_type_id
    and field_definition_id = p_field_definition_id;

  select count(*)
    into display_field_reference_count
  from entity_types
  where workspace_id = p_workspace_id
    and id = p_entity_type_id
    and display_field_definition_id = p_field_definition_id;

  v_template_token := '{{field:' || p_field_definition_id::text || '}}';

  select count(*)
    into workflow_reference_count
  from workflows workflow
  where workflow.workspace_id = p_workspace_id
    and (
      exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(
            workflow.action_config #> '{triggerConfig,watchedFieldDefinitionIds}',
            '[]'::jsonb
          )
        ) watched(field_definition_id)
        where watched.field_definition_id = p_field_definition_id::text
      )
      or exists (
        select 1
        from jsonb_array_elements(
          coalesce(workflow.action_config -> 'conditions', '[]'::jsonb)
        ) condition
        where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text
      )
      or exists (
        select 1
        from jsonb_array_elements(workflow.actions) action
        where action ->> 'relatedFieldDefinitionId' = p_field_definition_id::text
          or exists (
            select 1
            from jsonb_array_elements(
              coalesce(action -> 'fieldMappings', '[]'::jsonb)
            ) mapping
            where mapping ->> 'targetFieldDefinitionId' = p_field_definition_id::text
              or mapping #>> '{source,sourceFieldDefinitionId}' = p_field_definition_id::text
              or coalesce(mapping #>> '{source,template}', '')
                   like '%' || v_template_token || '%'
          )
      )
    );

  select count(*)
    into view_reference_count
  from entity_views view
  where view.workspace_id = p_workspace_id
    and view.entity_type_id = p_entity_type_id
    and (
      exists (
        select 1
        from jsonb_array_elements(coalesce(view.filters, '[]'::jsonb)) filter
        where filter ->> 'fieldDefinitionId' = p_field_definition_id::text
      )
      or exists (
        select 1
        from jsonb_array_elements(coalesce(view.sorts, '[]'::jsonb)) sort
        where sort ->> 'fieldDefinitionId' = p_field_definition_id::text
      )
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(view.column_field_definition_ids, '[]'::jsonb)
        ) column_field_definition_id
        where column_field_definition_id = p_field_definition_id::text
      )
    );

  if record_value_count = 0
    and relation_value_count = 0
    and workflow_reference_count = 0
    and display_field_reference_count = 0
    and view_reference_count = 0 then
    delete from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_field_definition_id;

    deleted := true;
  else
    deleted := false;
  end if;

  return next;
end;
$$;

comment on function delete_field_definition_if_safe(uuid, uuid, uuid)
  is 'Safely deletes an unused field definition. Blocks primitive values, relation rows, workflow JSON references across all ordered actions (related-record fields, field mappings) and workflow-level trigger/condition config, entity display-field configuration, and saved table-view configuration.';
