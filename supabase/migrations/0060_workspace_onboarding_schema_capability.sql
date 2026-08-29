-- create_entity_types_with_fields_authorized (0026) was written before the
-- roles/capabilities system existed (0045) and was only ever member-checked --
-- at the time, "membership" was the only authority concept available. Since
-- 0045 made workspace_memberships.role_id mandatory (every membership,
-- backfilled or new, carries an explicitly assigned role with explicit
-- capabilities), "a member with no assigned capabilities" is no longer a
-- state any membership can be in. There is also no app-mediated "create a
-- workspace" flow: a workspace's first role(s) and membership(s) are created
-- entirely by manual SQL from whoever stands the workspace up, so that
-- person already necessarily decides capabilities for the first member(s) --
-- and since creating any further role requires workspace.manage_roles,
-- withholding schema.manage from every initial member would leave the
-- workspace no more usable than today's onboarding gap, not safer. The
-- membership-only check here was simply never updated to the capability
-- system every other schema-write path already uses (entity_types_schema_write
-- / field_definitions_schema_write both require schema.manage). This
-- migration closes that gap: onboarding now requires schema.manage like
-- every other schema-creation path, with no other behavior change.
create or replace function create_entity_types_with_fields_authorized(
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
  v_field_position integer;
  v_field_type text;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  if exists (
    select 1
    from entity_types
    where workspace_id = p_workspace_id
  ) then
    raise exception 'Workspace setup is only available before any entity has been created';
  end if;

  if p_entities is null
    or jsonb_typeof(p_entities) <> 'array'
    or jsonb_array_length(p_entities) = 0 then
    raise exception 'p_entities must be a non-empty JSON array';
  end if;

  -- Create all entity IDs first so relation fields can reference any selected
  -- starter entity regardless of the order in which its fields are inserted.
  for v_entity in select * from jsonb_array_elements(p_entities)
  loop
    v_local_id := nullif(trim(v_entity->>'local_id'), '');

    if v_local_id is null or v_local_id !~ '^[a-z][a-z0-9_]*$' then
      raise exception 'Each entity requires a valid local_id';
    end if;

    if v_entity_ids ? v_local_id then
      raise exception 'Duplicate entity local_id: %', v_local_id;
    end if;

    if nullif(trim(v_entity->>'name'), '') is null
      or nullif(trim(v_entity->>'slug'), '') is null then
      raise exception 'Each entity requires a name and slug';
    end if;

    if jsonb_typeof(v_entity->'fields') <> 'array'
      or jsonb_array_length(v_entity->'fields') = 0 then
      raise exception 'Each entity requires at least one field';
    end if;

    v_entity_id := gen_random_uuid();
    insert into entity_types (id, workspace_id, name, slug, description)
    values (
      v_entity_id,
      p_workspace_id,
      trim(v_entity->>'name'),
      trim(v_entity->>'slug'),
      nullif(trim(coalesce(v_entity->>'description', '')), '')
    );

    v_entity_ids := v_entity_ids || jsonb_build_object(v_local_id, v_entity_id::text);
  end loop;

  for v_entity in select * from jsonb_array_elements(p_entities)
  loop
    v_local_id := v_entity->>'local_id';
    v_entity_id := (v_entity_ids->>v_local_id)::uuid;
    v_display_field_id := null;

    for v_field in select * from jsonb_array_elements(v_entity->'fields')
    loop
      v_field_type := v_field->>'type';
      v_field_position := nullif(v_field->>'position', '')::integer;
      v_related_local_id := nullif(trim(v_field->>'related_local_id'), '');
      v_related_entity_id := null;

      if nullif(trim(v_field->>'key'), '') is null
        or nullif(trim(v_field->>'name'), '') is null
        or nullif(trim(v_field->>'slug'), '') is null then
        raise exception 'Each field requires a key, name, and slug';
      end if;

      if v_field_type not in ('text', 'number', 'date', 'boolean', 'relation') then
        raise exception 'Unsupported field type: %', v_field_type;
      end if;

      if v_field_position is null or v_field_position <= 0 then
        raise exception 'Field position must be positive';
      end if;

      if v_field_type = 'relation' then
        if v_related_local_id is null or not (v_entity_ids ? v_related_local_id) then
          raise exception 'Relation fields must reference a selected entity';
        end if;
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
        v_related_entity_id, coalesce((v_field->>'required')::boolean, false),
        v_field_position
      );

      if v_field_type = 'text' and v_display_field_id is null then
        v_display_field_id := v_field_id;
      end if;
    end loop;

    if v_display_field_id is not null then
      update entity_types
      set display_field_definition_id = v_display_field_id,
          updated_at = now()
      where workspace_id = p_workspace_id and id = v_entity_id;
    end if;

    v_result := v_result || jsonb_build_object(v_local_id, v_entity_id::text);
  end loop;

  return v_result;
end;
$$;

comment on function create_entity_types_with_fields_authorized(uuid, jsonb)
  is 'schema.manage-checked, atomic bulk entity/field creation for first-run workspace setup.';
