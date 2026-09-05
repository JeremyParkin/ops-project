-- Phase 12.2: People-Sensitive Read Access -- SECURITY DEFINER RPC
-- enforcement.
--
-- Confirmed by inspection (round 3): create_entity_record_with_relations,
-- update_entity_record_with_relations, delete_entity_record_if_unreferenced,
-- bulk_create_entity_records_authorized, and set_entity_records_archived_
-- authorized are each SECURITY DEFINER (or called from within one), which
-- means RLS is never consulted for their internal statements at all --
-- 0100's corrected entity_records/entity_record_relation_values RLS
-- protects reads and the direct-table single-record archive/restore path,
-- but every one of these RPCs must independently re-implement row
-- visibility, because RLS structurally cannot reach them.
--
-- Every function body below is reproduced in full from its exact latest
-- canonical definition (traced by grepping every migration for the
-- function name, not assumed from the most recent migration that happens
-- to touch the same feature area), with only the intended new checks
-- added. No signature or return-shape changes anywhere in this file, so
-- every function uses `create or replace function` -- no DROP is needed
-- and no grant is disturbed.

-- 1. create_entity_record_with_relations (latest body: 0082). Adds one new
-- check to the existing per-relation referential-integrity loop: the
-- target of every relation must be independently visible to the effective
-- user, reusing the exact same error text the existing "must reference an
-- active record" check already uses, so a hidden sensitive target and a
-- nonexistent target are indistinguishable. The record being created is
-- always the source, never the target, of every relation in this loop --
-- it does not exist prior to this call, so there is nothing to check on
-- the source side, by construction, with no separate exception carved out.
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

      -- Phase 12.2 addition: target-side visibility. See migration header.
      if not private.can_view_people_sensitive_record(
        p_workspace_id, v_field.related_entity_type_id, (v_relation ->> 'target_record_id')::uuid,
        private.current_effective_user(p_workspace_id)
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

-- 2. update_entity_record_with_relations (latest body: 0082). Three
-- additions: (a) an existing-record visibility check immediately after the
-- existing not-found check, with identical wording, so a hidden sensitive
-- record and a genuinely nonexistent one are indistinguishable to the
-- caller; (b) the same target-side visibility check as create, added to
-- the existing preserve-vs-assign relation loop's "genuinely new
-- assignment" branch only (an untouched, preserved relation is not
-- re-checked, exactly like its existing active-target check); (c) the
-- subject/author governance boundary -- a NEW or CHANGED value for the
-- entity type's designated subject/author relation requires
-- private.require_people_data_governance_authority, evaluated with the
-- exact same "is this a genuine change, not an unchanged preserve"
-- comparison already used elsewhere in this function, so resubmitting an
-- untouched form never demands elevated privilege. Ordinary field/relation
-- edits below are otherwise completely unchanged.
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
  v_entity_type entity_types%rowtype;
  v_subject_covered boolean;
  v_subject_desired_target uuid;
  v_subject_existing_target uuid;
  v_author_covered boolean;
  v_author_desired_target uuid;
  v_author_existing_target uuid;
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

  -- Phase 12.2 addition: existing-record visibility. records.operate
  -- (already required by the _authorized wrapper) says the caller may
  -- mutate records in general; this says the caller may operate on THIS
  -- existing sensitive record specifically. Identical error text to the
  -- not-found case above -- a hidden and a nonexistent record must behave
  -- identically.
  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_record_id, private.current_effective_user(p_workspace_id)
  ) then
    raise exception 'Record not found';
  end if;

  select * into v_entity_type
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id;

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

        -- Phase 12.2 addition: target-side visibility, new assignments only
        -- (an unchanged preserved pair is never re-checked, matching the
        -- active-target check immediately above it).
        if not private.can_view_people_sensitive_record(
          p_workspace_id, v_field.related_entity_type_id, (v_relation ->> 'target_record_id')::uuid,
          private.current_effective_user(p_workspace_id)
        ) then
          raise exception '% must reference an active record.', v_field.name;
        end if;
      end if;
    exception
      when invalid_text_representation then
        raise exception 'A relation must reference a valid record.';
    end;
  end loop;

  -- Phase 12.2 addition: subject/author security-relation governance.
  -- Evaluated before any mutation below, using the same field/target
  -- comparison shape as the relation-integrity loop above, but against
  -- p_relation_field_ids/p_relations directly rather than pre-existing
  -- rows, since a CLEARED designated relation (covered, but absent from
  -- p_relations) must also be governed, not only a reassigned one.
  if v_entity_type.subject_person_field_id is not null then
    v_subject_covered := exists (
      select 1 from jsonb_array_elements_text(p_relation_field_ids) covered(field_definition_id)
      where covered.field_definition_id::uuid = v_entity_type.subject_person_field_id
    );

    select (relation ->> 'target_record_id')::uuid into v_subject_desired_target
    from jsonb_array_elements(p_relations) relation
    where relation ->> 'field_definition_id' = v_entity_type.subject_person_field_id::text;

    select target_record_id into v_subject_existing_target
    from entity_record_relation_values
    where workspace_id = p_workspace_id
      and source_entity_type_id = p_entity_type_id
      and source_record_id = p_record_id
      and field_definition_id = v_entity_type.subject_person_field_id;

    if v_subject_covered and v_subject_desired_target is distinct from v_subject_existing_target then
      perform private.require_people_data_governance_authority(p_workspace_id);
    end if;
  end if;

  if v_entity_type.author_person_field_id is not null then
    v_author_covered := exists (
      select 1 from jsonb_array_elements_text(p_relation_field_ids) covered(field_definition_id)
      where covered.field_definition_id::uuid = v_entity_type.author_person_field_id
    );

    select (relation ->> 'target_record_id')::uuid into v_author_desired_target
    from jsonb_array_elements(p_relations) relation
    where relation ->> 'field_definition_id' = v_entity_type.author_person_field_id::text;

    select target_record_id into v_author_existing_target
    from entity_record_relation_values
    where workspace_id = p_workspace_id
      and source_entity_type_id = p_entity_type_id
      and source_record_id = p_record_id
      and field_definition_id = v_entity_type.author_person_field_id;

    if v_author_covered and v_author_desired_target is distinct from v_author_existing_target then
      perform private.require_people_data_governance_authority(p_workspace_id);
    end if;
  end if;

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
  is 'Updates primitive values and covered relation rows with entity-scoped advisory locking. Active required fields are validated against the final updated record state, while archived primitive field values are preserved by field-definition metadata. Choice fields and relation targets whose value actually changed must reference an active option/record and be visible to the effective user; an untouched value (including a previously-active target now archived) is preserved as-is. A changed or cleared designated subject/author relation requires people_data.view_all held by the real actor, unavailable while impersonating.';

-- 3. delete_entity_record_if_unreferenced (latest body: 0097). Adds the
-- existing-record visibility check immediately after the existing
-- not-found check, before the reference-count/process-run-count/
-- comment-count/person-link-count queries run -- this is what stops the
-- reference-count leak at its source, not merely by sanitizing the number
-- afterward.
create or replace function delete_entity_record_if_unreferenced(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns table (
  deleted boolean,
  reference_count integer,
  process_run_count integer,
  comment_count integer,
  person_link_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_reference_count integer := 0;
  v_process_run_count integer := 0;
  v_comment_count integer := 0;
  v_person_link_count integer := 0;
begin
  if not exists (
    select 1
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_record_id
  ) then
    raise exception 'Record not found';
  end if;

  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_record_id, private.current_effective_user(p_workspace_id)
  ) then
    raise exception 'Record not found';
  end if;

  select count(*)
    into v_reference_count
  from entity_record_relation_values
  where workspace_id = p_workspace_id
    and target_entity_type_id = p_entity_type_id
    and target_record_id = p_record_id;

  select count(*)
    into v_process_run_count
  from process_runs
  where workspace_id = p_workspace_id
    and origin_entity_type_id = p_entity_type_id
    and origin_record_id = p_record_id;

  select count(*)
    into v_comment_count
  from record_comments
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and entity_record_id = p_record_id;

  select count(*)
    into v_person_link_count
  from entity_record_person_links
  where workspace_id = p_workspace_id
    and entity_record_id = p_record_id;

  if v_reference_count > 0 or v_process_run_count > 0 or v_comment_count > 0 or v_person_link_count > 0 then
    return query select false, v_reference_count, v_process_run_count, v_comment_count, v_person_link_count;
    return;
  end if;

  delete from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  return query select true, 0, 0, 0, 0;
end;
$$;

comment on function delete_entity_record_if_unreferenced(uuid, uuid, uuid)
  is 'Safely hard-deletes a record. Blocks deletion when another record relation references it, when any process run originates from it, when any durable comment exists for it, or when it is linked to a workspace member identity. A hidden sensitive record behaves identically to a nonexistent one.';

-- 4. set_entity_records_archived_authorized (latest and only body: 0083).
-- Adds the visibility predicate directly into the existing row-locking
-- subquery, so a hidden sensitive record id simply never locks and falls
-- out of v_locked_ids -- it then trips the exact same "N of M selected
-- records could not be found" count-mismatch exception a genuinely
-- nonexistent id already produces, never a distinguishable message naming
-- which id was hidden. All-or-nothing batch behavior is unchanged.
create or replace function set_entity_records_archived_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_ids uuid[],
  p_archived boolean
)
returns table (updated_record_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_ids uuid[];
  v_requested_count integer;
  v_locked_ids uuid[];
  v_locked_count integer;
  v_now timestamptz := now();
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if p_archived is null then
    raise exception 'p_archived must not be null';
  end if;

  if p_record_ids is null or array_length(p_record_ids, 1) is null then
    raise exception 'p_record_ids must be a non-empty array';
  end if;

  if exists (select 1 from unnest(p_record_ids) as id where id is null) then
    raise exception 'p_record_ids must not contain null elements';
  end if;

  select array_agg(distinct id) into v_record_ids from unnest(p_record_ids) as id;
  v_requested_count := array_length(v_record_ids, 1);

  -- Lock the actual matching rows first (a plain, non-aggregate select --
  -- FOR UPDATE cannot be combined with an aggregate directly), then derive
  -- the found set/count from that already-locked row set. Phase 12.2
  -- addition: the visibility predicate sits in this same inner WHERE, so a
  -- hidden sensitive record is never locked and never counted as found --
  -- it fails the same way a nonexistent id does, below.
  select array_agg(locked.id) into v_locked_ids
  from (
    select id
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = any(v_record_ids)
      and private.can_view_people_sensitive_record(
        workspace_id, entity_type_id, id, private.current_effective_user(p_workspace_id)
      )
    for update
  ) as locked;
  v_locked_count := coalesce(array_length(v_locked_ids, 1), 0);

  if v_locked_count <> v_requested_count then
    raise exception '% of % selected records could not be found in this object; nothing was changed.',
      v_requested_count - v_locked_count, v_requested_count;
  end if;

  -- Only rows not already in the target state are written -- a record
  -- already archived (or already active) inside the batch is left with its
  -- original archived_at/updated_at untouched, not bumped to now. The
  -- returned count is still the full validated request count: every
  -- selected record ends this call in the requested state, whether it
  -- just changed or already was, which is what the caller actually asked
  -- for -- but a no-op member of the batch never has its own history
  -- rewritten to look like it changed just now.
  update entity_records
  set archived_at = case when p_archived then v_now else null end,
      updated_at = v_now
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = any(v_locked_ids)
    and (archived_at is null) = p_archived;

  return query select v_requested_count;
end;
$$;

comment on function set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean)
  is 'Sets archived_at (and updated_at) for a complete, workspace/entity-type-validated, visible set of records in one transaction -- all-or-nothing, no cascade, no relation rewrite. A hidden sensitive record id fails identically to a nonexistent one. p_archived selects archive (true) vs restore (false); both directions share this one primitive.';

-- 5. bulk_create_entity_records_authorized (latest body: 0082). Same
-- target-side visibility addition as create_entity_record_with_relations,
-- applied per-row within the batch -- every newly-created row is its own
-- source with no prior existence to check, exactly as in plain create.
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

        -- Phase 12.2 addition: target-side visibility. See migration header.
        if not private.can_view_people_sensitive_record(
          p_workspace_id, v_field.related_entity_type_id, (v_relation ->> 'target_record_id')::uuid,
          private.current_effective_user(p_workspace_id)
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
