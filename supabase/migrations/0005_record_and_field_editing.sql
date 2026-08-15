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
begin
  if p_relation_field_ids is null or jsonb_typeof(p_relation_field_ids) <> 'array' then
    raise exception 'p_relation_field_ids must be a JSON array';
  end if;

  if p_relations is null or jsonb_typeof(p_relations) <> 'array' then
    raise exception 'p_relations must be a JSON array';
  end if;

  update entity_records
  set values = coalesce(p_values, '{}'::jsonb),
      updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  if not found then
    raise exception 'Record not found';
  end if;

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

create or replace function update_field_definition(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid,
  p_name text,
  p_slug text,
  p_required boolean
)
returns table (
  field_definition_id uuid,
  violation_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_field field_definitions%rowtype;
  v_violation_count integer := 0;
begin
  select *
    into v_field
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_field_definition_id;

  if not found then
    raise exception 'Field definition not found';
  end if;

  -- Future hardening: this validation/update is transactional, but another
  -- concurrent transaction could theoretically create or modify records while
  -- this check runs. The current app is single-user/no-auth, so we avoid extra
  -- locking complexity until multi-user editing semantics are introduced.
  if v_field.required = false and p_required = true then
    if v_field.type = 'relation' then
      select count(*)
        into v_violation_count
      from entity_records r
      where r.workspace_id = p_workspace_id
        and r.entity_type_id = p_entity_type_id
        and not exists (
          select 1
          from entity_record_relation_values rv
          where rv.workspace_id = r.workspace_id
            and rv.source_entity_type_id = r.entity_type_id
            and rv.source_record_id = r.id
            and rv.field_definition_id = p_field_definition_id
        );
    else
      select count(*)
        into v_violation_count
      from entity_records r
      where r.workspace_id = p_workspace_id
        and r.entity_type_id = p_entity_type_id
        and not (
          case v_field.type
            when 'text' then
              r.values ? v_field.key
              and jsonb_typeof(r.values -> v_field.key) = 'string'
              and btrim(r.values ->> v_field.key) <> ''
            when 'number' then
              r.values ? v_field.key
              and jsonb_typeof(r.values -> v_field.key) = 'number'
            when 'date' then
              r.values ? v_field.key
              and jsonb_typeof(r.values -> v_field.key) = 'string'
              and r.values ->> v_field.key ~ '^\d{4}-\d{2}-\d{2}$'
              and to_char(to_date(r.values ->> v_field.key, 'YYYY-MM-DD'), 'YYYY-MM-DD') =
                r.values ->> v_field.key
            when 'boolean' then
              r.values ? v_field.key
              and jsonb_typeof(r.values -> v_field.key) = 'boolean'
            else false
          end
        );
    end if;

    if v_violation_count > 0 then
      return query select p_field_definition_id, v_violation_count;
      return;
    end if;
  end if;

  update field_definitions
  set name = trim(p_name),
      slug = trim(p_slug),
      required = p_required,
      updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_field_definition_id;

  return query select p_field_definition_id, 0;
end;
$$;
