-- Phase 9.2: Choice / Select field type.
--
-- Options live in a new normalized table (field_choice_options), mirroring
-- field_definitions' own shape (id, label, position, archived_at) rather
-- than a JSONB blob on field_definitions -- options are individually added,
-- renamed, reordered, archived, and restored over time, exactly like fields
-- themselves already are, and that table already proves this exact pattern
-- works. Record values stay in the existing entity_records.values JSONB
-- scalar model (the option's id, a plain string) -- unlike relation fields,
-- an option has no existence or identity outside the field that defines it,
-- so it doesn't need entity_record_relation_values' cross-entity-type FK
-- machinery.
--
-- field_choice_options RPCs (add/update/archive/restore/reorder) follow
-- field_definitions' own established convention: security invoker (no
-- explicit capability check inside), relying on RLS
-- (field_choice_options_schema_write below) for the schema.manage
-- boundary -- exactly like add_field_definition/update_field_definition/
-- swap_field_definition_positions already do for fields.
--
-- Physical option deletion is deliberately not included in this migration.
-- Archive/restore covers the full required lifecycle; a stable option row
-- is cheap to retain.

-- 1. Allow 'choice' as a field type.
alter table field_definitions
  drop constraint if exists field_definitions_type_check;

alter table field_definitions
  add constraint field_definitions_type_check
  check (type in ('text', 'number', 'date', 'boolean', 'relation', 'choice'));

-- 2. Option storage.
create table field_choice_options (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  field_definition_id uuid not null,
  label text not null,
  -- A small fixed color-key enum, not a free hex value -- kept in sync with
  -- lib/domain/choice-colors.ts's CHOICE_OPTION_COLORS. Enforced here too
  -- (defense in depth), the same way field_definitions.type has its own
  -- check constraint independent of the app-layer FieldType union.
  color text check (color is null or color in ('gray', 'red', 'amber', 'emerald', 'blue', 'violet')),
  position integer not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, field_definition_id, id),
  unique (workspace_id, field_definition_id, position),

  foreign key (workspace_id, field_definition_id)
    references field_definitions(workspace_id, id)
    on delete cascade
);

-- Global label uniqueness per field, across active AND archived options.
-- Deliberately not scoped to "active only": with a global constraint, a new
-- active option can never collide with an archived one in the first place,
-- so restoring an archived option is always safe -- no restore-time
-- collision handling is ever needed, by construction.
create unique index field_choice_options_label_idx
  on field_choice_options (workspace_id, field_definition_id, lower(label));

create index field_choice_options_field_idx
  on field_choice_options (workspace_id, field_definition_id);

alter table field_choice_options enable row level security;

create policy field_choice_options_member_read
  on field_choice_options for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));

create policy field_choice_options_schema_write
  on field_choice_options for all to authenticated
  using ((select private.has_workspace_capability(workspace_id, 'schema.manage')))
  with check ((select private.has_workspace_capability(workspace_id, 'schema.manage')));

-- 3. Option lifecycle RPCs -- add / rename+color / archive / restore /
-- reorder. Same security-invoker-plus-RLS posture as field_definitions'
-- own RPCs; no _authorized wrapper, since this table's RLS write policy
-- already is the capability check.

create function add_field_choice_option(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_label text,
  p_color text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_option_id uuid := gen_random_uuid();
  v_next_position integer;
begin
  if not exists (
    select 1 from field_definitions
    where workspace_id = p_workspace_id
      and id = p_field_definition_id
      and type = 'choice'
  ) then
    raise exception 'Choice field not found';
  end if;

  select coalesce(max(position), 0) + 1
    into v_next_position
  from field_choice_options
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id;

  insert into field_choice_options (
    id, workspace_id, field_definition_id, label, color, position
  )
  values (
    v_option_id, p_workspace_id, p_field_definition_id, trim(p_label), p_color, v_next_position
  );

  return v_option_id;
end;
$$;

create function update_field_choice_option(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid,
  p_label text,
  p_color text
)
returns void
language plpgsql
set search_path = public
as $$
begin
  update field_choice_options
  set label = trim(p_label),
      color = p_color,
      updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;
end;
$$;

create function archive_field_choice_option(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
begin
  update field_choice_options
  set archived_at = now(), updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;
end;
$$;

create function restore_field_choice_option(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
begin
  -- No collision guard needed here: the global (active-or-archived) label
  -- uniqueness index already guarantees no active option could ever have
  -- been created with this option's label while it was archived.
  update field_choice_options
  set archived_at = null, updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;
end;
$$;

-- Same three-step sentinel-swap shape as swap_field_definition_positions
-- (0059) -- field_choice_options has the identical
-- unique(workspace_id, field_definition_id, position) constraint problem a
-- direct two-row swap would momentarily violate.
create function swap_field_choice_option_positions(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_first_option_id uuid,
  p_second_option_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_first field_choice_options%rowtype;
  v_second field_choice_options%rowtype;
  v_sentinel constant integer := 2147483647;
begin
  select * into v_first
  from field_choice_options
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_first_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;

  select * into v_second
  from field_choice_options
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_second_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;

  update field_choice_options
  set position = v_sentinel, updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = v_first.id;

  update field_choice_options
  set position = v_first.position, updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = v_second.id;

  update field_choice_options
  set position = v_second.position, updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = v_first.id;
end;
$$;

-- 4. Allow 'choice' when adding a field. Full body faithfully copied from
-- 0013_required_field_record_creation_safety.sql (the latest prior
-- definition); the only change is 'choice' added to the type allowlist on
-- the first check.
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
  if p_type not in ('text', 'number', 'date', 'boolean', 'relation', 'choice') then
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
      raise exception 'Cannot add a required field to an object that already has records';
    end if;
  end if;

  select coalesce(max(position), 0) + 1
    into v_next_position
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id;

  insert into field_definitions (
    id, workspace_id, entity_type_id, key, name, slug, type,
    related_entity_type_id, required, position
  )
  values (
    v_field_definition_id, p_workspace_id, p_entity_type_id, p_key, p_name, p_slug, p_type,
    p_related_entity_type_id, p_required, v_next_position
  );

  return v_field_definition_id;
end;
$$;

-- 5. Record-write integrity for choice values, at the canonical RPC
-- boundary -- not app-layer-only. entity_records.values has no FK the way
-- entity_record_relation_values does, so this is enforced with explicit
-- EXISTS checks instead.
--
-- CREATE / BULK CREATE: every record is new, so any non-null choice value
-- is inherently a *fresh* assignment -- it must reference an ACTIVE option.
--
-- UPDATE: a record may already hold an archived option from before that
-- option was archived. That must keep working (archive must never rewrite
-- existing records) -- so UPDATE only enforces "must be active" when the
-- incoming value for that field actually differs from what the record
-- already had (v_existing_values vs v_next_values). An untouched value is
-- preserved verbatim, active or archived; a genuinely new assignment must
-- be active.

-- create_entity_record_with_relations: full body faithfully copied from
-- 0041_process_action_nodes.sql (the latest prior definition). Two changes
-- only: a `choice` branch added to the existing required-field loop
-- (identical style to the text/number/date/boolean branches already
-- there), and a new, separate loop enforcing "non-null choice values must
-- reference an active option" for every active choice field regardless of
-- required-ness. Everything else -- the advisory lock, the idempotent
-- p_originating_process_step_run_id race handling, the relation inserts --
-- is unchanged.
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

-- update_entity_record_with_relations: full body faithfully copied from
-- 0015_required_field_update_date_validation.sql (the latest prior
-- definition). Same two kinds of changes as create above, plus the
-- preserve-vs-assign distinction described at the top of this section: the
-- new loop only validates a choice field's value against v_existing_values
-- when it actually changed.
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
  is 'Updates primitive values and covered relation rows with entity-scoped advisory locking. Active required fields are validated against the final updated record state, while archived primitive field values are preserved by field-definition metadata. Choice fields whose value actually changed must reference an active option; an untouched value (including a previously-selected, now-archived option) is preserved as-is.';

-- bulk_create_entity_records_authorized: full body faithfully copied from
-- 0068_impersonation.sql (the latest prior definition). One addition: the
-- same "non-null choice value must reference an active option" loop as the
-- plain create RPC above, appended per-row right after the existing
-- required-field loop. This RPC only ever creates new records (no update
-- path), so -- like plain create -- every non-null choice value is
-- inherently a fresh assignment; no preserve-vs-assign distinction is
-- needed here. (In practice CSV import already resolves option labels to
-- active option ids before rows ever reach this RPC, so this is a
-- defense-in-depth backstop, not the primary gate -- but it closes the
-- same third entry point that could otherwise write an invalid choice
-- value.) Authorization, the advisory lock, and the import-batch
-- idempotency handling are all unchanged.
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
      else
        if not (v_values ? v_field.key and v_values -> v_field.key is not null) then
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

    v_record_id := gen_random_uuid();
    insert into entity_records (id, workspace_id, entity_type_id, values)
    values (v_record_id, p_workspace_id, p_entity_type_id, v_values);

    for v_relation in select * from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb))
    loop
      insert into entity_record_relation_values (workspace_id, source_record_id, field_definition_id, target_record_id)
      values (p_workspace_id, v_record_id, (v_relation->>'field_definition_id')::uuid, (v_relation->>'target_record_id')::uuid);
    end loop;

    v_inserted_count := v_inserted_count + 1;
  end loop;

  update record_import_batches
  set imported_row_count = v_inserted_count, completed_at = now()
  where id = p_import_id and workspace_id = p_workspace_id and entity_type_id = p_entity_type_id;

  return query select v_inserted_count;
end;
$$;

-- 6. Read-only API (8F.3): expose Choice options and resolved record
-- values the same way relation targets already are -- stable {id, label}
-- objects, not opaque raw ids.

-- get_object_for_api_key: full body faithfully copied from
-- 0074_api_keys.sql (the latest and only prior definition). One addition:
-- each field's jsonb_build_object gains an 'options' key, populated only
-- for choice fields (archived options included, flagged, since an API
-- consumer resolving a record's stored id needs those too).
create or replace function get_object_for_api_key(p_key_hash text, p_entity_type_id uuid)
returns table(id uuid, name text, slug text, created_at timestamptz, updated_at timestamptz, fields jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_scopes text[];
begin
  select r.workspace_id, r.scopes into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  if not ('records:read' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  return query
  select
    et.id, et.name, et.slug, et.created_at, et.updated_at,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', fd.id, 'key', fd.key, 'name', fd.name, 'type', fd.type,
          'required', fd.required, 'relatedEntityTypeId', fd.related_entity_type_id,
          'options', case when fd.type = 'choice' then (
            select jsonb_agg(
              jsonb_build_object(
                'id', co.id, 'label', co.label, 'color', co.color,
                'archived', co.archived_at is not null
              )
              order by co.position
            )
            from public.field_choice_options co
            where co.workspace_id = v_workspace_id and co.field_definition_id = fd.id
          ) end
        )
        order by fd.position asc
      )
      from public.field_definitions fd
      where fd.entity_type_id = et.id and fd.workspace_id = v_workspace_id and fd.archived_at is null
    ), '[]'::jsonb)
  from public.entity_types et
  where et.id = p_entity_type_id and et.workspace_id = v_workspace_id and et.archived_at is null;
end;
$$;

-- list_records_for_api_key / get_record_for_api_key: full bodies
-- faithfully copied from 0075_api_records_active_fields_only.sql (the
-- latest prior definitions). One addition to each: the existing
-- `case when af.type = 'relation' then ... else ... end` gains a third
-- branch resolving choice values into {id, label, color, archived} the
-- same way relation targets resolve into {id, label}. Everything else --
-- scope checks, active-object/active-field-only projection, cursor
-- pagination -- is unchanged.
create or replace function list_records_for_api_key(
  p_key_hash text,
  p_entity_type_id uuid,
  p_limit integer default 50,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
returns table(id uuid, record_values jsonb, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_scopes text[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_limit';
  end if;

  select r.workspace_id, r.scopes into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  if not ('records:read' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  if not exists (
    select 1 from public.entity_types et
    where et.id = p_entity_type_id and et.workspace_id = v_workspace_id and et.archived_at is null
  ) then
    return;
  end if;

  return query
  with page as (
    select er.id, er.values, er.created_at, er.updated_at
    from public.entity_records er
    where er.workspace_id = v_workspace_id
      and er.entity_type_id = p_entity_type_id
      and er.archived_at is null
      and (p_after_created_at is null or (er.created_at, er.id) > (p_after_created_at, p_after_id))
    order by er.created_at asc, er.id asc
    limit p_limit + 1
  ),
  active_fields as (
    select fd.id as field_id, fd.key, fd.type, fd.related_entity_type_id
    from public.field_definitions fd
    where fd.entity_type_id = p_entity_type_id
      and fd.workspace_id = v_workspace_id
      and fd.archived_at is null
  ),
  relation_targets as (
    select rv.source_record_id, af.key, rv.target_record_id, af.related_entity_type_id
    from public.entity_record_relation_values rv
    join active_fields af on af.field_id = rv.field_definition_id and af.type = 'relation'
    where rv.workspace_id = v_workspace_id
      and rv.source_record_id in (select p.id from page p)
  ),
  field_values as (
    select
      p.id as record_id,
      af.key,
      case
        when af.type = 'relation' then (
          select jsonb_build_object(
            'id', rt.target_record_id,
            'label', private.api_record_label(v_workspace_id, rt.related_entity_type_id, rt.target_record_id)
          )
          from relation_targets rt
          where rt.source_record_id = p.id and rt.key = af.key
        )
        when af.type = 'choice' then (
          select jsonb_build_object(
            'id', co.id, 'label', co.label, 'color', co.color,
            'archived', co.archived_at is not null
          )
          from public.field_choice_options co
          where co.workspace_id = v_workspace_id
            and co.field_definition_id = af.field_id
            and co.id = (p.values ->> af.key)::uuid
        )
        else p.values -> af.key
      end as value
    from page p
    cross join active_fields af
  )
  select
    p.id,
    coalesce(
      (select jsonb_object_agg(fv.key, coalesce(fv.value, 'null'::jsonb)) from field_values fv where fv.record_id = p.id),
      '{}'::jsonb
    ),
    p.created_at,
    p.updated_at
  from page p
  order by p.created_at asc, p.id asc;
end;
$$;

create or replace function get_record_for_api_key(p_key_hash text, p_entity_type_id uuid, p_record_id uuid)
returns table(id uuid, record_values jsonb, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_scopes text[];
begin
  select r.workspace_id, r.scopes into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  if not ('records:read' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  if not exists (
    select 1 from public.entity_types et
    where et.id = p_entity_type_id and et.workspace_id = v_workspace_id and et.archived_at is null
  ) then
    return;
  end if;

  return query
  with target as (
    select er.id, er.values, er.created_at, er.updated_at
    from public.entity_records er
    where er.id = p_record_id
      and er.workspace_id = v_workspace_id
      and er.entity_type_id = p_entity_type_id
      and er.archived_at is null
  ),
  active_fields as (
    select fd.id as field_id, fd.key, fd.type, fd.related_entity_type_id
    from public.field_definitions fd
    where fd.entity_type_id = p_entity_type_id
      and fd.workspace_id = v_workspace_id
      and fd.archived_at is null
  ),
  relation_targets as (
    select rv.source_record_id, af.key, rv.target_record_id, af.related_entity_type_id
    from public.entity_record_relation_values rv
    join active_fields af on af.field_id = rv.field_definition_id and af.type = 'relation'
    where rv.workspace_id = v_workspace_id
      and rv.source_record_id = p_record_id
  ),
  field_values as (
    select
      af.key,
      case
        when af.type = 'relation' then (
          select jsonb_build_object(
            'id', rt.target_record_id,
            'label', private.api_record_label(v_workspace_id, rt.related_entity_type_id, rt.target_record_id)
          )
          from relation_targets rt
          where rt.key = af.key
        )
        when af.type = 'choice' then (
          select jsonb_build_object(
            'id', co.id, 'label', co.label, 'color', co.color,
            'archived', co.archived_at is not null
          )
          from public.field_choice_options co
          where co.workspace_id = v_workspace_id
            and co.field_definition_id = af.field_id
            and co.id = (t.values ->> af.key)::uuid
        )
        else t.values -> af.key
      end as value
    from target t
    cross join active_fields af
  )
  select
    t.id,
    coalesce((select jsonb_object_agg(fv.key, coalesce(fv.value, 'null'::jsonb)) from field_values fv), '{}'::jsonb),
    t.created_at,
    t.updated_at
  from target t;
end;
$$;
