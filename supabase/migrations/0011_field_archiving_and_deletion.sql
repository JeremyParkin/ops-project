alter table field_definitions
  add column if not exists archived_at timestamptz;

create index if not exists field_definitions_workspace_entity_archived_idx
  on field_definitions (workspace_id, entity_type_id, archived_at);

create or replace function delete_field_definition_if_safe(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns table (
  deleted boolean,
  record_value_count bigint,
  relation_value_count bigint,
  workflow_reference_count bigint
)
language plpgsql
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
        from jsonb_array_elements(
          coalesce(workflow.action_config -> 'fieldMappings', '[]'::jsonb)
        ) mapping
        where mapping ->> 'targetFieldDefinitionId' = p_field_definition_id::text
          or mapping #>> '{source,sourceFieldDefinitionId}' = p_field_definition_id::text
          or coalesce(mapping #>> '{source,template}', '') like '%' || v_template_token || '%'
      )
    );

  if record_value_count = 0
    and relation_value_count = 0
    and workflow_reference_count = 0 then
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
  is 'Safely deletes an unused field definition. Workflow references are stored in JSONB rather than relational FKs, so concurrent workflow creation during field deletion is a future hardening concern for multi-user/authenticated operation.';
