-- Corrective migration for 0119. Initial display assignment during trusted
-- compound creation uses a private marker; later metadata updates remain owned
-- by the 0119 trigger.

create table if not exists private.entity_type_creation_display_assignments (
  backend_pid integer not null,
  transaction_id bigint not null,
  entity_type_id uuid not null,
  primary key (backend_pid, transaction_id, entity_type_id)
);

revoke all on table private.entity_type_creation_display_assignments from public, anon, authenticated, service_role;

create or replace function private.assign_initial_entity_type_display(
  p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into private.entity_type_creation_display_assignments
    (backend_pid, transaction_id, entity_type_id)
  values (pg_backend_pid(), txid_current(), p_entity_type_id);
  update entity_types
  set display_field_definition_id = p_field_definition_id
  where workspace_id = p_workspace_id and id = p_entity_type_id;
  delete from private.entity_type_creation_display_assignments
  where backend_pid = pg_backend_pid() and transaction_id = txid_current()
    and entity_type_id = p_entity_type_id;
end;
$$;

revoke all on function private.assign_initial_entity_type_display(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function private.capture_entity_type_metadata_update()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_old_display_name text;
  v_new_display_name text;
begin
  if exists (
    select 1 from private.entity_type_creation_display_assignments
    where backend_pid = pg_backend_pid() and transaction_id = txid_current()
      and entity_type_id = new.id
  ) then return new; end if;
  if old.name is distinct from new.name then
    v_changes := v_changes || jsonb_build_object('name', jsonb_build_object('old', old.name, 'new', new.name));
  end if;
  if old.description is distinct from new.description then
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_object('old', old.description, 'new', new.description));
  end if;
  if old.display_field_definition_id is distinct from new.display_field_definition_id then
    if old.display_field_definition_id is not null then
      select name into v_old_display_name from field_definitions where id = old.display_field_definition_id;
    end if;
    if new.display_field_definition_id is not null then
      select name into v_new_display_name from field_definitions where id = new.display_field_definition_id;
    end if;
    v_changes := v_changes || jsonb_build_object('display_field', jsonb_build_object(
      'old', jsonb_build_object('id', old.display_field_definition_id, 'name', v_old_display_name),
      'new', jsonb_build_object('id', new.display_field_definition_id, 'name', v_new_display_name)
    ));
  end if;
  if v_changes <> '{}'::jsonb then
    perform private.governance_audit_insert(new.workspace_id, 'entity_type_updated', 'entity_type', new.id, new.name,
      null, null, null, null, v_changes);
  end if;
  return new;
end;
$$;

-- Rebind both trusted creation functions to the private helper. Their full
-- 0117 validation, relation resolution, return shapes, and audit calls remain.
create or replace function public.create_entity_type_with_fields_core(
  p_workspace_id uuid, p_entity_name text, p_entity_slug text,
  p_entity_description text, p_fields jsonb
)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare
  v_entity_type_id uuid := gen_random_uuid(); v_field jsonb; v_field_definition_id uuid;
  v_field_type text; v_field_position integer; v_related_entity_type_id uuid;
  v_display_field_definition_id uuid; v_display_field_name text;
  v_entity_name text := trim(p_entity_name);
  v_entity_description text := nullif(trim(coalesce(p_entity_description, '')), '');
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then raise exception 'p_fields must be a JSON array'; end if;
  if jsonb_array_length(p_fields) = 0 then raise exception 'p_fields must include at least one field'; end if;
  insert into entity_types (id, workspace_id, name, slug, description)
    values (v_entity_type_id, p_workspace_id, v_entity_name, trim(p_entity_slug), v_entity_description);
  for v_field in select * from jsonb_array_elements(p_fields) loop
    v_field_definition_id := gen_random_uuid(); v_field_type := v_field->>'type';
    v_field_position := (v_field->>'position')::integer;
    v_related_entity_type_id := nullif(v_field->>'related_entity_type_id', '')::uuid;
    if v_field_type not in ('text', 'number', 'date', 'boolean', 'relation') then raise exception 'Unsupported field type: %', v_field_type; end if;
    if v_field_position <= 0 then raise exception 'Field position must be positive'; end if;
    if v_field_type = 'relation' and v_related_entity_type_id is null then raise exception 'Relation fields require a related entity type'; end if;
    if v_field_type <> 'relation' and v_related_entity_type_id is not null then raise exception 'Only relation fields may declare a related entity type'; end if;
    insert into field_definitions (id, workspace_id, entity_type_id, key, name, slug, type, related_entity_type_id, required, position)
      values (v_field_definition_id, p_workspace_id, v_entity_type_id, v_field->>'key', v_field->>'name', v_field->>'slug', v_field_type, v_related_entity_type_id, coalesce((v_field->>'required')::boolean, false), v_field_position);
    perform private.governance_audit_insert(p_workspace_id, 'field_created', 'field', v_field_definition_id, v_field->>'name', null, null, v_entity_type_id, v_entity_name,
      jsonb_build_object('new', jsonb_build_object('name', v_field->>'name', 'required', coalesce((v_field->>'required')::boolean, false), 'type', v_field_type)));
    if v_field_type = 'text' and v_display_field_definition_id is null then v_display_field_definition_id := v_field_definition_id; v_display_field_name := v_field->>'name'; end if;
  end loop;
  if v_display_field_definition_id is not null then perform private.assign_initial_entity_type_display(p_workspace_id, v_entity_type_id, v_display_field_definition_id); end if;
  perform private.governance_audit_insert(p_workspace_id, 'entity_type_created', 'entity_type', v_entity_type_id, v_entity_name, null, null, null, null,
    jsonb_build_object('new', jsonb_build_object('name', v_entity_name, 'description', v_entity_description, 'display_field_definition_id', v_display_field_definition_id, 'display_field_name', v_display_field_name)));
  return v_entity_type_id;
end;
$$;

create or replace function public.create_entity_types_with_fields_authorized(
  p_workspace_id uuid, p_entities jsonb
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity jsonb; v_field jsonb; v_entity_id uuid; v_field_id uuid; v_local_id text;
  v_related_local_id text; v_related_entity_id uuid; v_entity_ids jsonb := '{}'::jsonb;
  v_result jsonb := '{}'::jsonb; v_display_field_id uuid; v_display_field_name text;
  v_field_position integer; v_field_type text; v_entity_name text; v_entity_description text;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  if exists (select 1 from entity_types where workspace_id = p_workspace_id) then raise exception 'Workspace setup is only available before any entity has been created'; end if;
  if p_entities is null or jsonb_typeof(p_entities) <> 'array' or jsonb_array_length(p_entities) = 0 then raise exception 'p_entities must be a non-empty JSON array'; end if;
  for v_entity in select * from jsonb_array_elements(p_entities) loop
    v_local_id := nullif(trim(v_entity->>'local_id'), '');
    if v_local_id is null or v_local_id !~ '^[a-z][a-z0-9_]*$' then raise exception 'Each entity requires a valid local_id'; end if;
    if v_entity_ids ? v_local_id then raise exception 'Duplicate entity local_id: %', v_local_id; end if;
    if nullif(trim(v_entity->>'name'), '') is null or nullif(trim(v_entity->>'slug'), '') is null then raise exception 'Each entity requires a name and slug'; end if;
    if jsonb_typeof(v_entity->'fields') <> 'array' or jsonb_array_length(v_entity->'fields') = 0 then raise exception 'Each entity requires at least one field'; end if;
    v_entity_id := gen_random_uuid(); v_entity_name := trim(v_entity->>'name'); v_entity_description := nullif(trim(coalesce(v_entity->>'description', '')), '');
    insert into entity_types (id, workspace_id, name, slug, description) values (v_entity_id, p_workspace_id, v_entity_name, trim(v_entity->>'slug'), v_entity_description);
    v_entity_ids := v_entity_ids || jsonb_build_object(v_local_id, v_entity_id::text);
  end loop;
  for v_entity in select * from jsonb_array_elements(p_entities) loop
    v_local_id := v_entity->>'local_id'; v_entity_id := (v_entity_ids->>v_local_id)::uuid; v_entity_name := trim(v_entity->>'name'); v_entity_description := nullif(trim(coalesce(v_entity->>'description', '')), ''); v_display_field_id := null; v_display_field_name := null;
    for v_field in select * from jsonb_array_elements(v_entity->'fields') loop
      v_field_type := v_field->>'type'; v_field_position := nullif(v_field->>'position', '')::integer; v_related_local_id := nullif(trim(v_field->>'related_local_id'), ''); v_related_entity_id := null;
      if nullif(trim(v_field->>'key'), '') is null or nullif(trim(v_field->>'name'), '') is null or nullif(trim(v_field->>'slug'), '') is null then raise exception 'Each field requires a key, name, and slug'; end if;
      if v_field_type not in ('text', 'number', 'date', 'boolean', 'relation') then raise exception 'Unsupported field type: %', v_field_type; end if;
      if v_field_position is null or v_field_position <= 0 then raise exception 'Field position must be positive'; end if;
      if v_field_type = 'relation' then
        if v_related_local_id is null or not (v_entity_ids ? v_related_local_id) then raise exception 'Relation fields must reference a selected entity'; end if;
        v_related_entity_id := (v_entity_ids->>v_related_local_id)::uuid;
      elsif v_related_local_id is not null then raise exception 'Only relation fields may declare related_local_id'; end if;
      v_field_id := gen_random_uuid();
      insert into field_definitions (id, workspace_id, entity_type_id, key, name, slug, type, related_entity_type_id, required, position)
        values (v_field_id, p_workspace_id, v_entity_id, trim(v_field->>'key'), trim(v_field->>'name'), trim(v_field->>'slug'), v_field_type, v_related_entity_id, coalesce((v_field->>'required')::boolean, false), v_field_position);
      perform private.governance_audit_insert(p_workspace_id, 'field_created', 'field', v_field_id, trim(v_field->>'name'), null, null, v_entity_id, v_entity_name,
        jsonb_build_object('new', jsonb_build_object('name', trim(v_field->>'name'), 'required', coalesce((v_field->>'required')::boolean, false), 'type', v_field_type)));
      if v_field_type = 'text' and v_display_field_id is null then v_display_field_id := v_field_id; v_display_field_name := trim(v_field->>'name'); end if;
    end loop;
    if v_display_field_id is not null then perform private.assign_initial_entity_type_display(p_workspace_id, v_entity_id, v_display_field_id); end if;
    perform private.governance_audit_insert(p_workspace_id, 'entity_type_created', 'entity_type', v_entity_id, v_entity_name, null, null, null, null,
      jsonb_build_object('new', jsonb_build_object('name', v_entity_name, 'description', v_entity_description, 'display_field_definition_id', v_display_field_id, 'display_field_name', v_display_field_name)));
    v_result := v_result || jsonb_build_object(v_local_id, v_entity_id::text);
  end loop;
  return v_result;
end;
$$;

