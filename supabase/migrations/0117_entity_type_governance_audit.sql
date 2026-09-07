-- Phase 13.2B2: authoritative EntityType lifecycle audit.
-- Migrations 0110-0116 are immutable. This migration extends the existing
-- governance history store and closes only the EntityType mutation boundaries
-- needed for complete transactional capture.

alter table governance_audit_events
  alter column parent_entity_type_id drop not null;

alter table governance_audit_events
  drop constraint if exists governance_audit_events_event_type_check,
  drop constraint if exists governance_audit_events_subject_kind_check,
  drop constraint if exists governance_audit_events_check;

alter table governance_audit_events
  add constraint governance_audit_events_event_type_check check (event_type in (
    'field_created', 'field_updated', 'field_archived', 'field_restored', 'field_deleted',
    'choice_option_created', 'choice_option_updated', 'choice_option_archived', 'choice_option_restored',
    'entity_type_created', 'entity_type_updated', 'entity_type_archived', 'entity_type_restored', 'entity_type_deleted'
  )),
  add constraint governance_audit_events_subject_kind_check check (subject_kind in ('field', 'choice_option', 'entity_type')),
  add constraint governance_audit_events_subject_hierarchy_check check (
    (subject_kind = 'entity_type' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'field' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind = 'choice_option' and parent_entity_type_id is not null and parent_field_id is not null)
  );

-- Preserve the complete normal create implementation as an internal-in-practice
-- core. It now captures the EntityType and directly-created Fields in the same
-- transaction. The existing return shape and validation remain unchanged.
alter function public.create_entity_type_with_fields(uuid, text, text, text, jsonb)
  rename to create_entity_type_with_fields_core;

revoke all on function public.create_entity_type_with_fields_core(uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.create_entity_type_with_fields_core(
  p_workspace_id uuid,
  p_entity_name text,
  p_entity_slug text,
  p_entity_description text,
  p_fields jsonb
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entity_type_id uuid := gen_random_uuid();
  v_field jsonb;
  v_field_definition_id uuid;
  v_field_type text;
  v_field_position integer;
  v_related_entity_type_id uuid;
  v_display_field_definition_id uuid;
  v_display_field_name text;
  v_entity_name text := trim(p_entity_name);
  v_entity_description text := nullif(trim(coalesce(p_entity_description, '')), '');
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
    raise exception 'p_fields must be a JSON array';
  end if;
  if jsonb_array_length(p_fields) = 0 then
    raise exception 'p_fields must include at least one field';
  end if;

  insert into entity_types (id, workspace_id, name, slug, description)
  values (v_entity_type_id, p_workspace_id, v_entity_name, trim(p_entity_slug), v_entity_description);

  for v_field in select * from jsonb_array_elements(p_fields)
  loop
    v_field_definition_id := gen_random_uuid();
    v_field_type := v_field->>'type';
    v_field_position := (v_field->>'position')::integer;
    v_related_entity_type_id := nullif(v_field->>'related_entity_type_id', '')::uuid;

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
      id, workspace_id, entity_type_id, key, name, slug, type,
      related_entity_type_id, required, position
    ) values (
      v_field_definition_id, p_workspace_id, v_entity_type_id,
      v_field->>'key', v_field->>'name', v_field->>'slug', v_field_type,
      v_related_entity_type_id, coalesce((v_field->>'required')::boolean, false),
      v_field_position
    );

    perform private.governance_audit_insert(
      p_workspace_id, 'field_created', 'field', v_field_definition_id,
      v_field->>'name', null, null, v_entity_type_id, v_entity_name,
      jsonb_build_object('new', jsonb_build_object(
        'name', v_field->>'name', 'required', coalesce((v_field->>'required')::boolean, false),
        'type', v_field_type
      ))
    );

    if v_field_type = 'text' and v_display_field_definition_id is null then
      v_display_field_definition_id := v_field_definition_id;
      v_display_field_name := v_field->>'name';
    end if;
  end loop;

  if v_display_field_definition_id is not null then
    update entity_types
    set display_field_definition_id = v_display_field_definition_id
    where workspace_id = p_workspace_id and id = v_entity_type_id;
  end if;

  perform private.governance_audit_insert(
    p_workspace_id, 'entity_type_created', 'entity_type', v_entity_type_id,
    v_entity_name, null, null, null, null,
    jsonb_build_object('new', jsonb_build_object(
      'name', v_entity_name,
      'description', v_entity_description,
      'display_field_definition_id', v_display_field_definition_id,
      'display_field_name', v_display_field_name
    ))
  );

  return v_entity_type_id;
end;
$$;

create function public.create_entity_type_with_fields(
  p_workspace_id uuid,
  p_entity_name text,
  p_entity_slug text,
  p_entity_description text,
  p_fields jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  return public.create_entity_type_with_fields_core(
    p_workspace_id, p_entity_name, p_entity_slug, p_entity_description, p_fields
  );
end;
$$;

-- Onboarding has a distinct multi-EntityType contract. Preserve its complete
-- validation and local-relation mechanics while adding the same shared audit
-- helper calls for each inserted EntityType and Field.
create or replace function public.create_entity_types_with_fields_authorized(
  p_workspace_id uuid,
  p_entities jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity jsonb;
  v_field jsonb;
  v_entity_id uuid;
  v_field_id uuid;
  v_local_id text;
  v_related_local_id text;
  v_related_entity_id uuid;
  v_entity_ids jsonb := '{}'::jsonb;
  v_result jsonb := '{}'::jsonb;
  v_display_field_id uuid;
  v_display_field_name text;
  v_field_position integer;
  v_field_type text;
  v_entity_name text;
  v_entity_description text;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  if exists (select 1 from entity_types where workspace_id = p_workspace_id) then
    raise exception 'Workspace setup is only available before any entity has been created';
  end if;
  if p_entities is null or jsonb_typeof(p_entities) <> 'array' or jsonb_array_length(p_entities) = 0 then
    raise exception 'p_entities must be a non-empty JSON array';
  end if;

  for v_entity in select * from jsonb_array_elements(p_entities)
  loop
    v_local_id := nullif(trim(v_entity->>'local_id'), '');
    if v_local_id is null or v_local_id !~ '^[a-z][a-z0-9_]*$' then raise exception 'Each entity requires a valid local_id'; end if;
    if v_entity_ids ? v_local_id then raise exception 'Duplicate entity local_id: %', v_local_id; end if;
    if nullif(trim(v_entity->>'name'), '') is null or nullif(trim(v_entity->>'slug'), '') is null then
      raise exception 'Each entity requires a name and slug';
    end if;
    if jsonb_typeof(v_entity->'fields') <> 'array' or jsonb_array_length(v_entity->'fields') = 0 then
      raise exception 'Each entity requires at least one field';
    end if;

    v_entity_id := gen_random_uuid();
    v_entity_name := trim(v_entity->>'name');
    v_entity_description := nullif(trim(coalesce(v_entity->>'description', '')), '');
    insert into entity_types (id, workspace_id, name, slug, description)
    values (v_entity_id, p_workspace_id, v_entity_name, trim(v_entity->>'slug'), v_entity_description);
    v_entity_ids := v_entity_ids || jsonb_build_object(v_local_id, v_entity_id::text);
  end loop;

  for v_entity in select * from jsonb_array_elements(p_entities)
  loop
    v_local_id := v_entity->>'local_id';
    v_entity_id := (v_entity_ids->>v_local_id)::uuid;
    v_entity_name := trim(v_entity->>'name');
    v_entity_description := nullif(trim(coalesce(v_entity->>'description', '')), '');
    v_display_field_id := null;
    v_display_field_name := null;

    for v_field in select * from jsonb_array_elements(v_entity->'fields')
    loop
      v_field_type := v_field->>'type';
      v_field_position := nullif(v_field->>'position', '')::integer;
      v_related_local_id := nullif(trim(v_field->>'related_local_id'), '');
      v_related_entity_id := null;

      if nullif(trim(v_field->>'key'), '') is null or nullif(trim(v_field->>'name'), '') is null or nullif(trim(v_field->>'slug'), '') is null then
        raise exception 'Each field requires a key, name, and slug';
      end if;
      if v_field_type not in ('text', 'number', 'date', 'boolean', 'relation') then raise exception 'Unsupported field type: %', v_field_type; end if;
      if v_field_position is null or v_field_position <= 0 then raise exception 'Field position must be positive'; end if;
      if v_field_type = 'relation' then
        if v_related_local_id is null or not (v_entity_ids ? v_related_local_id) then raise exception 'Relation fields must reference a selected entity'; end if;
        v_related_entity_id := (v_entity_ids->>v_related_local_id)::uuid;
      elsif v_related_local_id is not null then
        raise exception 'Only relation fields may declare related_local_id';
      end if;

      v_field_id := gen_random_uuid();
      insert into field_definitions (
        id, workspace_id, entity_type_id, key, name, slug, type,
        related_entity_type_id, required, position
      ) values (
        v_field_id, p_workspace_id, v_entity_id, trim(v_field->>'key'),
        trim(v_field->>'name'), trim(v_field->>'slug'), v_field_type,
        v_related_entity_id, coalesce((v_field->>'required')::boolean, false), v_field_position
      );

      perform private.governance_audit_insert(
        p_workspace_id, 'field_created', 'field', v_field_id, trim(v_field->>'name'),
        null, null, v_entity_id, v_entity_name,
        jsonb_build_object('new', jsonb_build_object(
          'name', trim(v_field->>'name'), 'required', coalesce((v_field->>'required')::boolean, false),
          'type', v_field_type
        ))
      );

      if v_field_type = 'text' and v_display_field_id is null then
        v_display_field_id := v_field_id;
        v_display_field_name := trim(v_field->>'name');
      end if;
    end loop;

    if v_display_field_id is not null then
      update entity_types
      set display_field_definition_id = v_display_field_id, updated_at = now()
      where workspace_id = p_workspace_id and id = v_entity_id;
    end if;

    perform private.governance_audit_insert(
      p_workspace_id, 'entity_type_created', 'entity_type', v_entity_id,
      v_entity_name, null, null, null, null,
      jsonb_build_object('new', jsonb_build_object(
        'name', v_entity_name, 'description', v_entity_description,
        'display_field_definition_id', v_display_field_id,
        'display_field_name', v_display_field_name
      ))
    );
    v_result := v_result || jsonb_build_object(v_local_id, v_entity_id::text);
  end loop;

  return v_result;
end;
$$;

revoke all on function public.create_entity_type_with_fields(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.create_entity_type_with_fields(uuid, text, text, text, jsonb) to authenticated, service_role;

-- A single metadata-save boundary makes name, description, and display-field
-- changes atomic and produces at most one grouped semantic event.
create function public.update_entity_type_metadata_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_name text,
  p_entity_slug text,
  p_entity_description text,
  p_display_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_entity entity_types%rowtype;
  new_display_name text;
  old_display_name text;
  v_changes jsonb := '{}'::jsonb;
  v_new_description text := nullif(trim(coalesce(p_entity_description, '')), '');
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into old_entity from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id for update;
  if not found then raise exception 'Entity type not found'; end if;
  if old_entity.archived_at is not null then raise exception 'Cannot update an archived entity type'; end if;

  if old_entity.display_field_definition_id is not null then
    select name into old_display_name from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = old_entity.display_field_definition_id;
  end if;
  if p_display_field_definition_id is not null then
    select name into new_display_name from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id
      and id = p_display_field_definition_id and archived_at is null and type = 'text';
    if not found then raise exception 'Display field must be an active text field owned by this entity.'; end if;
  end if;

  if old_entity.name is distinct from trim(p_entity_name) then
    v_changes := v_changes || jsonb_build_object('name', jsonb_build_object('old', old_entity.name, 'new', trim(p_entity_name)));
  end if;
  if old_entity.description is distinct from v_new_description then
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_object('old', old_entity.description, 'new', v_new_description));
  end if;
  if old_entity.display_field_definition_id is distinct from p_display_field_definition_id then
    v_changes := v_changes || jsonb_build_object('display_field', jsonb_build_object(
      'old', jsonb_build_object('id', old_entity.display_field_definition_id, 'name', old_display_name),
      'new', jsonb_build_object('id', p_display_field_definition_id, 'name', new_display_name)
    ));
  end if;

  update entity_types
  set name = trim(p_entity_name), slug = trim(p_entity_slug), description = v_new_description,
      display_field_definition_id = p_display_field_definition_id, updated_at = now()
  where workspace_id = p_workspace_id and id = p_entity_type_id;

  if v_changes <> '{}'::jsonb then
    perform private.governance_audit_insert(
      p_workspace_id, 'entity_type_updated', 'entity_type', p_entity_type_id,
      trim(p_entity_name), null, null, null, null, v_changes
    );
  end if;
  return p_entity_type_id;
end;
$$;

-- Preserve the existing display-field RPC for specialized callers, but make
-- its independent operation an audited authorized boundary.
alter function public.set_entity_display_field(uuid, uuid, uuid)
  rename to set_entity_display_field_core;
revoke all on function public.set_entity_display_field_core(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create function public.set_entity_display_field(p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare old_entity entity_types%rowtype; new_field field_definitions%rowtype; old_field_name text;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into old_entity from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id for update;
  if not found then raise exception 'Entity type not found'; end if;
  if old_entity.display_field_definition_id is not null then
    select name into old_field_name from field_definitions where workspace_id = p_workspace_id and id = old_entity.display_field_definition_id;
  end if;
  perform public.set_entity_display_field_core(p_workspace_id, p_entity_type_id, p_field_definition_id);
  if p_field_definition_id is not null then
    select * into new_field from field_definitions where workspace_id = p_workspace_id and id = p_field_definition_id;
  end if;
  if old_entity.display_field_definition_id is distinct from p_field_definition_id then
    perform private.governance_audit_insert(
      p_workspace_id, 'entity_type_updated', 'entity_type', p_entity_type_id,
      old_entity.name, null, null, null, null,
      jsonb_build_object('display_field', jsonb_build_object(
        'old', jsonb_build_object('id', old_entity.display_field_definition_id, 'name', old_field_name),
        'new', jsonb_build_object('id', p_field_definition_id, 'name', new_field.name)
      ))
    );
  end if;
  return p_entity_type_id;
end;
$$;

create function public.archive_entity_type_authorized(p_workspace_id uuid, p_entity_type_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into e from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id for update;
  if not found then raise exception 'Entity type not found'; end if;
  if e.archived_at is null then
    update entity_types set archived_at = now(), updated_at = now() where workspace_id = p_workspace_id and id = p_entity_type_id;
    perform private.governance_audit_insert(p_workspace_id, 'entity_type_archived', 'entity_type', e.id, e.name, null, null, null, null,
      jsonb_build_object('old', jsonb_build_object('archived_at', null), 'new', jsonb_build_object('archived_at', now())));
  end if;
end;
$$;

create function public.restore_entity_type_authorized(p_workspace_id uuid, p_entity_type_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into e from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id for update;
  if not found then raise exception 'Entity type not found'; end if;
  if e.archived_at is not null then
    update entity_types set archived_at = null, updated_at = now() where workspace_id = p_workspace_id and id = p_entity_type_id;
    perform private.governance_audit_insert(p_workspace_id, 'entity_type_restored', 'entity_type', e.id, e.name, null, null, null, null,
      jsonb_build_object('old', jsonb_build_object('archived_at', e.archived_at), 'new', jsonb_build_object('archived_at', null)));
  end if;
end;
$$;

-- Capture successful safe deletion before the physical delete. The event and
-- delete remain in the same transaction; cascading Field rows are structural
-- consequences and intentionally do not receive synthetic field_deleted events.
create or replace function public.delete_entity_type_if_safe(
  p_workspace_id uuid, p_entity_type_id uuid
)
returns table (
  deleted boolean, record_count integer, relation_field_count integer,
  workflow_target_count integer, process_template_count integer,
  person_type_designation_count integer
)
language plpgsql set search_path = public, pg_temp as $$
declare
  e entity_types%rowtype;
  v_record_count integer := 0;
  v_relation_field_count integer := 0;
  v_workflow_target_count integer := 0;
  v_process_template_count integer := 0;
  v_person_type_designation_count integer := 0;
begin
  select * into e from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id for update;
  if not found then raise exception 'Entity type not found'; end if;
  select count(*) into v_record_count from entity_records where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id;
  select count(*) into v_relation_field_count from field_definitions where workspace_id = p_workspace_id and related_entity_type_id = p_entity_type_id;
  select count(*) into v_workflow_target_count from workflows workflow where workflow.workspace_id = p_workspace_id and exists (
    select 1 from jsonb_array_elements(workflow.actions) action
    where action ->> 'actionType' = 'create_record' and action ->> 'actionTargetEntityTypeId' = p_entity_type_id::text
  );
  select count(*) into v_process_template_count from process_templates where workspace_id = p_workspace_id and applies_to_entity_type_id = p_entity_type_id;
  select count(*) into v_person_type_designation_count from workspaces where id = p_workspace_id and person_entity_type_id = p_entity_type_id;

  if v_record_count > 0 or v_relation_field_count > 0 or v_workflow_target_count > 0
    or v_process_template_count > 0 or v_person_type_designation_count > 0 then
    return query select false, v_record_count, v_relation_field_count, v_workflow_target_count,
      v_process_template_count, v_person_type_designation_count;
    return;
  end if;

  perform private.governance_audit_insert(p_workspace_id, 'entity_type_deleted', 'entity_type', e.id, e.name, null, null, null, null,
    jsonb_build_object('old', jsonb_build_object('name', e.name, 'description', e.description,
      'display_field_definition_id', e.display_field_definition_id), 'new', null));
  delete from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  return query select true, 0, 0, 0, 0, 0;
end;
$$;

revoke all on table entity_types from authenticated;
grant select on table entity_types to authenticated;

revoke all on function public.update_entity_type_metadata_authorized(uuid, uuid, text, text, text, uuid),
  public.set_entity_display_field(uuid, uuid, uuid),
  public.archive_entity_type_authorized(uuid, uuid),
  public.restore_entity_type_authorized(uuid, uuid)
  from public, anon;
grant execute on function public.update_entity_type_metadata_authorized(uuid, uuid, text, text, text, uuid),
  public.set_entity_display_field(uuid, uuid, uuid),
  public.archive_entity_type_authorized(uuid, uuid),
  public.restore_entity_type_authorized(uuid, uuid)
  to authenticated, service_role;

revoke all on function public.create_entity_type_with_fields_core(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.set_entity_display_field_core(uuid, uuid, uuid) from public, anon, authenticated, service_role;
