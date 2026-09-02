-- Phase 9.3: relation-target referential integrity at the canonical RPC
-- boundary. Confirmed by inspection: the relation insert in every one of
-- the three canonical write RPCs was a plain insert into
-- entity_record_relation_values with no check on the target's
-- archived_at, and the table itself (0003_relation_fields.sql) carries no
-- CHECK constraint or trigger for it either -- the FK only proves the
-- target row exists, never that it is active. A direct RPC call could
-- already assign a relation to an archived target, or to a record whose
-- target_entity_type_id doesn't actually match the field's own configured
-- related_entity_type_id. The same class of gap Phase 9.2 closed for
-- Choice, except this one predates that phase.
--
-- Latest applied definitions confirmed by searching every migration for
-- each function name (not assumed from the most recent migration that
-- happens to touch the same feature area -- the exact mistake 0081
-- corrected):
--   create_entity_record_with_relations   -> 0080_choice_field_type.sql
--   update_entity_record_with_relations   -> 0080_choice_field_type.sql
--   bulk_create_entity_records_authorized -> 0081_bulk_import_choice_validation_restore.sql
-- All three bodies below are copied verbatim from those exact sources.
-- Authorization, impersonation capability checks, import-batch
-- idempotency, relation-shape (six-column insert, import_batch_id),
-- advisory locking, and the existing Choice referential-integrity loops
-- are all unchanged -- the only new code is the relation-target validation
-- loop added to each function, in each case placed immediately before the
-- point where entity_record_relation_values is written.
--
-- CREATE / BULK CREATE: every relation being written is a fresh
-- assignment (no prior row to preserve) -- its target must exist, must
-- belong to the field's own configured related_entity_type_id (never
-- trusting the caller-supplied target_entity_type_id on its own), and
-- must be active.
--
-- UPDATE: preserve != assign, the same invariant Choice already has.
-- Before the existing delete-then-insert relation cycle, each incoming
-- (field, target) pair is compared against entity_record_relation_values'
-- pre-update state for this exact record. An incoming pair that already
-- exists as a row (the value is genuinely untouched, even if that target
-- has since been archived) is preserved with no check. A pair that does
-- not already exist -- a new assignment or a change to a different target
-- -- requires the target to be active. Clearing a relation (a field
-- present in p_relation_field_ids but absent from p_relations) is
-- untouched by this loop, exactly as today, and stays governed purely by
-- the existing required/optional check below it.

create or replace function create_entity_record_with_relations(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_record_id uuid;
  v_existing_id uuid;
  v_relation jsonb;
  v_field field_definitions%rowtype;
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
begin
  if p_relations is null or jsonb_typeof(p_relations) <> 'array' then
    raise exception 'p_relations must be a JSON array';
  end if;

  if p_originating_process_step_run_id is not null then
    select id into v_existing_id from entity_records
    where workspace_id = p_workspace_id and originating_process_step_run_id = p_originating_process_step_run_id;
    if found then
      return v_existing_id;
    end if;
  end if;

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
    elsif v_field.type = 'choice' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'string'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    end if;
  end loop;

  -- Choice referential integrity: any active choice field's non-null value
  -- (required or not) must reference an ACTIVE option for that exact
  -- field. There is no "existing value" on a brand-new record, so every
  -- non-null value here is a fresh assignment.
  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and type = 'choice'
      and archived_at is null
  loop
    if v_values ? v_field.key and v_values -> v_field.key <> 'null'::jsonb then
      begin
        if jsonb_typeof(v_values -> v_field.key) <> 'string'
          or not exists (
            select 1 from field_choice_options
            where workspace_id = p_workspace_id
              and field_definition_id = v_field.id
              and id = (v_values ->> v_field.key)::uuid
              and archived_at is null
          )
        then
          raise exception '% must reference an active option.', v_field.name;
        end if;
      exception
        when invalid_text_representation then
          raise exception '% must reference an active option.', v_field.name;
      end;
    end if;
  end loop;

  -- Phase 9.3 addition: relation referential integrity. Every relation
  -- here is a fresh assignment (a brand-new record has no prior relation
  -- rows to preserve), so each target must exist, must belong to the
  -- field's own configured related_entity_type_id, and must be active.
  for v_relation in select * from jsonb_array_elements(p_relations)
  loop
    begin
      select * into v_field
      from field_definitions
      where workspace_id = p_workspace_id
        and id = (v_relation ->> 'field_definition_id')::uuid
        and type = 'relation';

      if not found
        or v_field.related_entity_type_id is distinct from (v_relation ->> 'target_entity_type_id')::uuid
      then
        raise exception 'A relation must reference its own configured related object.';
      end if;

      if not exists (
        select 1 from entity_records
        where workspace_id = p_workspace_id
          and entity_type_id = v_field.related_entity_type_id
          and id = (v_relation ->> 'target_record_id')::uuid
          and archived_at is null
      ) then
        raise exception '% must reference an active record.', v_field.name;
      end if;
    exception
      when invalid_text_representation then
        raise exception 'A relation must reference a valid record.';
    end;
  end loop;

  v_record_id := gen_random_uuid();

  insert into entity_records (
    id,
    workspace_id,
    entity_type_id,
    values,
    originating_process_step_run_id
  )
  values (
    v_record_id,
    p_workspace_id,
    p_entity_type_id,
    v_values,
    p_originating_process_step_run_id
  )
  on conflict (workspace_id, originating_process_step_run_id) where originating_process_step_run_id is not null
  do nothing
  returning id into v_record_id;

  if v_record_id is null then
    -- Lost a race with a concurrent identical retry; reuse its row and skip
    -- relation writes, which that winning attempt already performed.
    select id into v_record_id from entity_records
    where workspace_id = p_workspace_id and originating_process_step_run_id = p_originating_process_step_run_id;
    return v_record_id;
  end if;

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
      begin
        if not (
          v_next_values ? v_field.key
          and jsonb_typeof(v_next_values -> v_field.key) = 'string'
          and v_next_values ->> v_field.key ~ '^\d{4}-\d{2}-\d{2}$'
          and to_char(to_date(v_next_values ->> v_field.key, 'YYYY-MM-DD'), 'YYYY-MM-DD') =
            v_next_values ->> v_field.key
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      exception
        when others then
          raise exception '% is required.', v_field.name;
      end;
    elsif v_field.type = 'boolean' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'boolean'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'choice' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'string'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    end if;
  end loop;

  -- Choice referential integrity: preserve != assign. Only validate a
  -- choice field's value against "must be active" when it actually
  -- changed from what this record already had -- an untouched value
  -- (possibly an archived option, kept from before it was archived) is
  -- preserved verbatim.
  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and type = 'choice'
      and archived_at is null
  loop
    if v_next_values ? v_field.key and v_next_values -> v_field.key <> 'null'::jsonb
      and (v_existing_values -> v_field.key) is distinct from (v_next_values -> v_field.key)
    then
      begin
        if jsonb_typeof(v_next_values -> v_field.key) <> 'string'
          or not exists (
            select 1 from field_choice_options
            where workspace_id = p_workspace_id
              and field_definition_id = v_field.id
              and id = (v_next_values ->> v_field.key)::uuid
              and archived_at is null
          )
        then
          raise exception '% must reference an active option.', v_field.name;
        end if;
      exception
        when invalid_text_representation then
          raise exception '% must reference an active option.', v_field.name;
      end;
    end if;
  end loop;

  -- Phase 9.3 addition: relation referential integrity, preserve != assign.
  -- Checked here, before the delete below, so the "does an identical row
  -- already exist" comparison sees the pre-update state. An incoming
  -- (field, target) pair that already exists as a row for this exact
  -- record is untouched -- preserved as-is even if that target has since
  -- been archived. A pair that does not already exist is a genuinely new
  -- assignment (including a change to a different target) and requires
  -- the target to be active. Clearing a relation (present in
  -- p_relation_field_ids, absent from p_relations) is untouched by this
  -- loop -- governed purely by the required/optional check above.
  for v_relation in select * from jsonb_array_elements(p_relations)
  loop
    begin
      select * into v_field
      from field_definitions
      where workspace_id = p_workspace_id
        and id = (v_relation ->> 'field_definition_id')::uuid
        and type = 'relation';

      if not found
        or v_field.related_entity_type_id is distinct from (v_relation ->> 'target_entity_type_id')::uuid
      then
        raise exception 'A relation must reference its own configured related object.';
      end if;

      if not exists (
        select 1
        from entity_record_relation_values rv
        where rv.workspace_id = p_workspace_id
          and rv.source_entity_type_id = p_entity_type_id
          and rv.source_record_id = p_record_id
          and rv.field_definition_id = v_field.id
          and rv.target_record_id = (v_relation ->> 'target_record_id')::uuid
      ) then
        if not exists (
          select 1 from entity_records
          where workspace_id = p_workspace_id
            and entity_type_id = v_field.related_entity_type_id
            and id = (v_relation ->> 'target_record_id')::uuid
            and archived_at is null
        ) then
          raise exception '% must reference an active record.', v_field.name;
        end if;
      end if;
    exception
      when invalid_text_representation then
        raise exception 'A relation must reference a valid record.';
    end;
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
  is 'Updates primitive values and covered relation rows with entity-scoped advisory locking. Active required fields are validated against the final updated record state, while archived primitive field values are preserved by field-definition metadata. Choice fields and relation targets whose value actually changed must reference an active option/record; an untouched value (including a previously-active target now archived) is preserved as-is.';

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

    -- Choice referential integrity (see comment above the function).
    for v_field in
      select *
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and type = 'choice'
        and archived_at is null
    loop
      if v_values ? v_field.key and v_values -> v_field.key <> 'null'::jsonb then
        begin
          if jsonb_typeof(v_values -> v_field.key) <> 'string'
            or not exists (
              select 1 from field_choice_options
              where workspace_id = p_workspace_id
                and field_definition_id = v_field.id
                and id = (v_values ->> v_field.key)::uuid
                and archived_at is null
            )
          then
            raise exception '% must reference an active option.', v_field.name;
          end if;
        exception
          when invalid_text_representation then
            raise exception '% must reference an active option.', v_field.name;
        end;
      end if;
    end loop;

    -- Phase 9.3 addition: relation referential integrity. Every relation in
    -- a bulk-created row is a fresh assignment, same reasoning as plain
    -- create above.
    for v_relation in select * from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb))
    loop
      begin
        select * into v_field
        from field_definitions
        where workspace_id = p_workspace_id
          and id = (v_relation ->> 'field_definition_id')::uuid
          and type = 'relation';

        if not found
          or v_field.related_entity_type_id is distinct from (v_relation ->> 'target_entity_type_id')::uuid
        then
          raise exception 'A relation must reference its own configured related object.';
        end if;

        if not exists (
          select 1 from entity_records
          where workspace_id = p_workspace_id
            and entity_type_id = v_field.related_entity_type_id
            and id = (v_relation ->> 'target_record_id')::uuid
            and archived_at is null
        ) then
          raise exception '% must reference an active record.', v_field.name;
        end if;
      exception
        when invalid_text_representation then
          raise exception 'A relation must reference a valid record.';
      end;
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
