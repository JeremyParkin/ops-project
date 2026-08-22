create or replace function update_entity_record_with_relations(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_relation jsonb;
  v_field field_definitions%rowtype;
  v_existing_values jsonb;
  v_next_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_relation_count integer;
begin
  if p_relation_field_ids is null or jsonb_typeof(p_relation_field_ids) <> 'array' then
    raise exception 'p_relation_field_ids must be a JSON array';
  end if;

  if p_relations is null or jsonb_typeof(p_relations) <> 'array' then
    raise exception 'p_relations must be a JSON array';
  end if;

  -- Keep record updates serialized with required-field additions and record
  -- creation for the same entity. After this lock is held, current active
  -- required metadata is authoritative for the final updated record state.
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  select values
    into v_existing_values
  from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id
  for update;

  if not found then
    raise exception 'Record not found';
  end if;

  -- Preserve archived primitive field data by metadata, not by blindly merging
  -- arbitrary existing JSONB keys. Active primitive fields remain governed by
  -- the existing complete-replacement p_values contract.
  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and archived_at is not null
      and type <> 'relation'
      and v_existing_values ? key
  loop
    v_next_values := jsonb_set(
      v_next_values,
      array[v_field.key],
      v_existing_values -> v_field.key,
      true
    );
  end loop;

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
      select count(*)
        into v_relation_count
      from (
        select rv.field_definition_id
        from entity_record_relation_values rv
        where rv.workspace_id = p_workspace_id
          and rv.source_entity_type_id = p_entity_type_id
          and rv.source_record_id = p_record_id
          and rv.field_definition_id = v_field.id
          and not exists (
            select 1
            from jsonb_array_elements_text(p_relation_field_ids) covered(field_definition_id)
            where covered.field_definition_id::uuid = v_field.id
          )
        union all
        select (relation ->> 'field_definition_id')::uuid
        from jsonb_array_elements(p_relations) relation
        where relation ->> 'field_definition_id' = v_field.id::text
      ) final_relations;

      if v_relation_count <> 1 then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'text' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'string'
        and btrim(v_next_values ->> v_field.key) <> ''
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'number' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'number'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'date' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'string'
        and v_next_values ->> v_field.key ~ '^\d{4}-\d{2}-\d{2}$'
        and to_char(to_date(v_next_values ->> v_field.key, 'YYYY-MM-DD'), 'YYYY-MM-DD') =
          v_next_values ->> v_field.key
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'boolean' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'boolean'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    end if;
  end loop;

  update entity_records
  set values = v_next_values,
      updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  delete from entity_record_relation_values
  where workspace_id = p_workspace_id
    and source_entity_type_id = p_entity_type_id
    and source_record_id = p_record_id
    and field_definition_id in (
      select value::uuid
      from jsonb_array_elements_text(p_relation_field_ids)
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
      p_record_id,
      (v_relation->>'field_definition_id')::uuid,
      (v_relation->>'target_entity_type_id')::uuid,
      (v_relation->>'target_record_id')::uuid
    );
  end loop;

  return p_record_id;
end;
$$;

comment on function update_entity_record_with_relations(uuid, uuid, uuid, jsonb, jsonb, jsonb)
  is 'Updates primitive values and covered relation rows with entity-scoped advisory locking. Active required fields are validated against the final updated record state, while archived primitive field values are preserved by field-definition metadata.';
