create or replace function add_field_definition(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_name text,
  p_slug text,
  p_key text,
  p_type text,
  p_required boolean,
  p_related_entity_type_id uuid
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_field_definition_id uuid := gen_random_uuid();
  v_next_position integer;
  v_record_count integer;
begin
  if p_type not in ('text', 'number', 'date', 'boolean', 'relation') then
    raise exception 'Unsupported field type: %', p_type;
  end if;

  if p_type = 'relation' and p_related_entity_type_id is null then
    raise exception 'Relation fields require a related entity type';
  end if;

  if p_type <> 'relation' and p_related_entity_type_id is not null then
    raise exception 'Only relation fields may declare a related entity type';
  end if;

  -- This shared entity-scoped transaction lock serializes required-field
  -- addition with record creation. Record first -> required field add fails
  -- because records exist. Required field first -> record creation validates
  -- against the current required metadata after it gets the same lock.
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  if p_required then
    select count(*)
      into v_record_count
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id;

    if v_record_count > 0 then
      raise exception 'Required fields can only be added before this entity has records';
    end if;
  end if;

  select coalesce(max(position), 0) + 1
    into v_next_position
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id;

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
    p_entity_type_id,
    p_key,
    trim(p_name),
    trim(p_slug),
    p_type,
    p_related_entity_type_id,
    p_required,
    v_next_position
  );

  return v_field_definition_id;
end;
$$;

comment on function add_field_definition(uuid, uuid, text, text, text, text, boolean, uuid)
  is 'Adds a field definition with entity-scoped advisory locking. Required fields may only be added while the entity has zero records, including archived records.';

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
  v_field field_definitions%rowtype;
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
begin
  if p_relations is null or jsonb_typeof(p_relations) <> 'array' then
    raise exception 'p_relations must be a JSON array';
  end if;

  -- This shared entity-scoped transaction lock serializes record creation with
  -- required-field addition. Record first -> required field add fails because
  -- records exist. Required field first -> this function validates against the
  -- current active required metadata before inserting the record.
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
    v_values
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

comment on function create_entity_record_with_relations(uuid, uuid, jsonb, jsonb)
  is 'Creates a record and relation rows with entity-scoped advisory locking. Active required fields are validated inside the database transaction as a structural backstop behind application validation.';
