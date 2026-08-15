alter table field_definitions
  add column related_entity_type_id uuid;

alter table field_definitions
  drop constraint if exists field_definitions_type_check;

alter table field_definitions
  add constraint field_definitions_type_check
  check (type in ('text', 'number', 'date', 'boolean', 'relation'));

alter table field_definitions
  add constraint field_definitions_related_entity_workspace_fk
  foreign key (workspace_id, related_entity_type_id)
  references entity_types(workspace_id, id);

alter table field_definitions
  add constraint field_definitions_relation_target_required
  check (
    (type = 'relation' and related_entity_type_id is not null)
    or
    (type <> 'relation' and related_entity_type_id is null)
  );

alter table field_definitions
  add constraint field_definitions_workspace_id_id_key
  unique (workspace_id, id);

alter table field_definitions
  add constraint field_definitions_relation_contract_key
  unique (workspace_id, entity_type_id, id, related_entity_type_id);

alter table entity_records
  add constraint entity_records_workspace_id_id_key
  unique (workspace_id, id);

alter table entity_records
  add constraint entity_records_workspace_entity_type_id_id_key
  unique (workspace_id, entity_type_id, id);

create table entity_record_relation_values (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source_entity_type_id uuid not null,
  source_record_id uuid not null,
  field_definition_id uuid not null,
  target_entity_type_id uuid not null,
  target_record_id uuid not null,
  created_at timestamptz not null default now(),

  unique (workspace_id, source_record_id, field_definition_id),

  foreign key (workspace_id)
    references workspaces(id)
    on delete cascade,

  foreign key (
    workspace_id,
    source_entity_type_id,
    source_record_id
  )
    references entity_records(workspace_id, entity_type_id, id)
    on delete cascade,

  foreign key (
    workspace_id,
    source_entity_type_id,
    field_definition_id,
    target_entity_type_id
  )
    references field_definitions(
      workspace_id,
      entity_type_id,
      id,
      related_entity_type_id
    )
    on delete cascade,

  foreign key (
    workspace_id,
    target_entity_type_id,
    target_record_id
  )
    references entity_records(workspace_id, entity_type_id, id)
    on delete restrict
);

create index entity_record_relation_values_source_idx
  on entity_record_relation_values (
    workspace_id,
    source_entity_type_id,
    source_record_id
  );

create index entity_record_relation_values_target_idx
  on entity_record_relation_values (
    workspace_id,
    target_entity_type_id,
    target_record_id
  );

create index entity_record_relation_values_field_idx
  on entity_record_relation_values (
    workspace_id,
    source_entity_type_id,
    field_definition_id
  );

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
  v_field_type text;
  v_field_position integer;
  v_related_entity_type_id uuid;
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
      gen_random_uuid(),
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
  end loop;

  return v_entity_type_id;
end;
$$;

create or replace function create_entity_record_with_relations(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_record_id uuid := gen_random_uuid();
  v_relation jsonb;
begin
  if p_relations is null or jsonb_typeof(p_relations) <> 'array' then
    raise exception 'p_relations must be a JSON array';
  end if;

  insert into entity_records (
    id,
    workspace_id,
    entity_type_id,
    values
  )
  values (
    v_record_id,
    p_workspace_id,
    p_entity_type_id,
    coalesce(p_values, '{}'::jsonb)
  );

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
