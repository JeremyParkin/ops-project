alter table entity_types
  add column if not exists display_field_definition_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'field_definitions_workspace_entity_id_key'
      and conrelid = 'field_definitions'::regclass
  ) then
    alter table field_definitions
      add constraint field_definitions_workspace_entity_id_key
      unique (workspace_id, entity_type_id, id);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'entity_types_display_field_definition_fk'
      and conrelid = 'entity_types'::regclass
  ) then
    alter table entity_types
      add constraint entity_types_display_field_definition_fk
      foreign key (workspace_id, id, display_field_definition_id)
      references field_definitions(workspace_id, entity_type_id, id);
  end if;
end;
$$;

create or replace function set_entity_display_field(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_field field_definitions%rowtype;
begin
  if p_field_definition_id is null then
    update entity_types
    set display_field_definition_id = null,
        updated_at = now()
    where workspace_id = p_workspace_id
      and id = p_entity_type_id;

    if not found then
      raise exception 'Entity type not found';
    end if;

    return p_entity_type_id;
  end if;

  select *
    into v_field
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_field_definition_id;

  if not found then
    raise exception 'Display field must belong to this entity.';
  end if;

  if v_field.archived_at is not null then
    raise exception 'Display field must be active.';
  end if;

  if v_field.type <> 'text' then
    raise exception 'Display field must be a text field.';
  end if;

  update entity_types
  set display_field_definition_id = p_field_definition_id,
      updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_entity_type_id;

  if not found then
    raise exception 'Entity type not found';
  end if;

  return p_entity_type_id;
end;
$$;

comment on function set_entity_display_field(uuid, uuid, uuid)
  is 'Sets or clears the text field used to display records for an entity. Non-null values must reference an active text field owned by the same workspace/entity.';

create or replace function create_entity_type_with_fields(
  p_workspace_id uuid,
  p_entity_name text,
  p_entity_slug text,
  p_entity_description text,
  p_fields jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_entity_type_id uuid := gen_random_uuid();
  v_field jsonb;
  v_field_definition_id uuid;
  v_field_type text;
  v_field_position integer;
  v_related_entity_type_id uuid;
  v_display_field_definition_id uuid;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
    raise exception 'p_fields must be a JSON array';
  end if;

  if jsonb_array_length(p_fields) = 0 then
    raise exception 'p_fields must include at least one field';
  end if;

  insert into entity_types (
    id,
    workspace_id,
    name,
    slug,
    description
  )
  values (
    v_entity_type_id,
    p_workspace_id,
    trim(p_entity_name),
    trim(p_entity_slug),
    nullif(trim(coalesce(p_entity_description, '')), '')
  );

  for v_field in select * from jsonb_array_elements(p_fields)
  loop
    v_field_definition_id := gen_random_uuid();
    v_field_type := v_field->>'type';
    v_field_position := (v_field->>'position')::integer;
    v_related_entity_type_id :=
      nullif(v_field->>'related_entity_type_id', '')::uuid;

    if v_field_type not in ('text', 'number', 'date', 'boolean', 'relation') then
      raise exception 'Unsupported field type: %', v_field_type;
    end if;

    if v_field_position <= 0 then
      raise exception 'Field position must be positive';
    end if;

    if v_field_type = 'relation' and v_related_entity_type_id is null then
      raise exception 'Relation fields require a related entity type';
    end if;

    if v_field_type <> 'relation' and v_related_entity_type_id is not null then
      raise exception 'Only relation fields may declare a related entity type';
    end if;

    insert into field_definitions (
      id,
      workspace_id,
      entity_type_id,
      key,
      name,
      slug,
      type,
      related_entity_type_id,
      required,
      position
    )
    values (
      v_field_definition_id,
      p_workspace_id,
      v_entity_type_id,
      v_field->>'key',
      v_field->>'name',
      v_field->>'slug',
      v_field_type,
      v_related_entity_type_id,
      coalesce((v_field->>'required')::boolean, false),
      v_field_position
    );

    if v_field_type = 'text' and v_display_field_definition_id is null then
      v_display_field_definition_id := v_field_definition_id;
    end if;
  end loop;

  if v_display_field_definition_id is not null then
    update entity_types
    set display_field_definition_id = v_display_field_definition_id
    where workspace_id = p_workspace_id
      and id = v_entity_type_id;
  end if;

  return v_entity_type_id;
end;
$$;

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
                      display_field_reference_count bigint
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
    and workflow_reference_count = 0
    and display_field_reference_count = 0 then
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
  is 'Safely deletes an unused field definition. Blocks primitive values, relation rows, workflow JSON references, and entity display-field configuration.';
