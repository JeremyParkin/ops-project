-- 0068 rewrote bulk_create_entity_records_authorized to swap in the
-- effective-identity capability check, but the reproduction of its body was
-- inaccurate rather than a faithful copy: it silently dropped
-- entity_records.import_batch_id from the record insert, dropped
-- entity_record_relation_values.source_entity_type_id/target_entity_type_id
-- from the relation insert, and invented a record_import_batches.
-- completed_at column that has never existed on that table. Confirmed by
-- direct execution (record-import.commit.test.ts) -- every relation-import
-- and every completed-batch path failed outright the moment this function
-- actually ran. Fix: restore the exact original body from 0062, verbatim,
-- with only the one intended change (the capability-check line) applied on
-- top -- no other line differs from 0062's version.
create or replace function bulk_create_entity_records_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_import_id uuid,
  p_rows jsonb
)
returns table (imported_row_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_count integer;
  v_row jsonb;
  v_values jsonb;
  v_relation jsonb;
  v_record_id uuid;
  v_field field_definitions%rowtype;
  v_inserted_count integer := 0;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty JSON array';
  end if;

  if not exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id and id = p_entity_type_id and archived_at is null
  ) then
    raise exception 'Object not found or archived';
  end if;

  insert into record_import_batches (id, workspace_id, entity_type_id, actor_user_id)
  values (p_import_id, p_workspace_id, p_entity_type_id, auth.uid())
  on conflict (id) do nothing;

  if not found then
    select record_import_batches.imported_row_count into v_existing_count
    from record_import_batches
    where id = p_import_id
      and workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id;

    if not found then
      raise exception 'Import ID already used for a different object';
    end if;

    return query select v_existing_count;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_values := coalesce(v_row->'values', '{}'::jsonb);

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
          from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb)) relation
          where relation->>'field_definition_id' = v_field.id::text
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

    v_record_id := gen_random_uuid();

    insert into entity_records (id, workspace_id, entity_type_id, values, import_batch_id)
    values (v_record_id, p_workspace_id, p_entity_type_id, v_values, p_import_id);

    for v_relation in select * from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb))
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

    v_inserted_count := v_inserted_count + 1;
  end loop;

  update record_import_batches
  set imported_row_count = v_inserted_count
  where id = p_import_id;

  return query select v_inserted_count;
end;
$$;
