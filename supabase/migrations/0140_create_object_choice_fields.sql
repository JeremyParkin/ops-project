-- Create Object field-type parity: allow initial Choice fields and options
-- through the existing authoritative EntityType creation RPC.
--
-- The public create_entity_type_with_fields wrapper, signature, grants, and
-- schema.manage boundary remain unchanged. This migration only extends the
-- core JSON field contract:
--   { key, name, slug, type: 'choice', position, required?, choice_options? }
-- where choice_options, when present, is an array of
--   { label, color? }
-- Options are inserted in the same transaction as the EntityType and initial
-- FieldDefinitions. Any validation or constraint failure rolls back the
-- whole operation.

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
  v_choice_options jsonb;
  v_choice_option jsonb;
  v_choice_option_id uuid;
  v_choice_option_label text;
  v_choice_option_color text;
  v_choice_option_position integer;
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
  values (
    v_entity_type_id,
    p_workspace_id,
    v_entity_name,
    trim(p_entity_slug),
    v_entity_description
  );

  for v_field in select * from jsonb_array_elements(p_fields)
  loop
    v_field_definition_id := gen_random_uuid();
    v_field_type := v_field->>'type';
    v_field_position := (v_field->>'position')::integer;
    v_related_entity_type_id := nullif(v_field->>'related_entity_type_id', '')::uuid;
    v_choice_options := v_field->'choice_options';

    if v_field_type not in ('text', 'number', 'date', 'boolean', 'relation', 'choice') then
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

    if v_field_type <> 'choice' and v_choice_options is not null then
      raise exception 'Only choice fields may declare choice_options';
    end if;

    if v_field_type = 'choice'
      and v_choice_options is not null
      and jsonb_typeof(v_choice_options) <> 'array' then
      raise exception 'choice_options must be a JSON array';
    end if;

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
      v_entity_type_id,
      v_field->>'key',
      v_field->>'name',
      v_field->>'slug',
      v_field_type,
      v_related_entity_type_id,
      coalesce((v_field->>'required')::boolean, false),
      v_field_position
    );

    perform private.governance_audit_insert(
      p_workspace_id,
      'field_created',
      'field',
      v_field_definition_id,
      v_field->>'name',
      null,
      null,
      v_entity_type_id,
      v_entity_name,
      jsonb_build_object('new', jsonb_build_object(
        'name', v_field->>'name',
        'required', coalesce((v_field->>'required')::boolean, false),
        'type', v_field_type
      ))
    );

    if v_field_type = 'choice' and v_choice_options is not null then
      v_choice_option_position := 0;

      for v_choice_option in select * from jsonb_array_elements(v_choice_options)
      loop
        v_choice_option_position := v_choice_option_position + 1;
        v_choice_option_id := gen_random_uuid();

        if jsonb_typeof(v_choice_option) <> 'object' then
          raise exception 'Each choice option must be a JSON object';
        end if;

        v_choice_option_label := trim(coalesce(v_choice_option->>'label', ''));
        v_choice_option_color := nullif(v_choice_option->>'color', '');

        if v_choice_option_label = '' then
          raise exception 'Choice option label is required';
        end if;

        if v_choice_option_color is not null
          and v_choice_option_color not in (
            'gray', 'red', 'amber', 'emerald', 'blue', 'violet',
            'orange', 'teal', 'cyan', 'indigo', 'rose', 'lime'
          ) then
          raise exception 'Unsupported choice option color: %', v_choice_option_color;
        end if;

        if v_choice_option ? 'archived_at' then
          raise exception 'Initial choice options cannot be archived';
        end if;

        insert into field_choice_options (
          id,
          workspace_id,
          field_definition_id,
          label,
          color,
          position
        )
        values (
          v_choice_option_id,
          p_workspace_id,
          v_field_definition_id,
          v_choice_option_label,
          v_choice_option_color,
          v_choice_option_position
        );

        perform private.governance_audit_insert(
          p_workspace_id,
          'choice_option_created',
          'choice_option',
          v_choice_option_id,
          v_choice_option_label,
          v_field_definition_id,
          v_field->>'name',
          v_entity_type_id,
          v_entity_name,
          jsonb_build_object('new', jsonb_build_object('label', v_choice_option_label))
        );
      end loop;
    end if;

    if v_field_type = 'text' and v_display_field_definition_id is null then
      v_display_field_definition_id := v_field_definition_id;
      v_display_field_name := v_field->>'name';
    end if;
  end loop;

  if v_display_field_definition_id is not null then
    perform private.assign_initial_entity_type_display(
      p_workspace_id,
      v_entity_type_id,
      v_display_field_definition_id
    );
  end if;

  perform private.governance_audit_insert(
    p_workspace_id,
    'entity_type_created',
    'entity_type',
    v_entity_type_id,
    v_entity_name,
    null,
    null,
    null,
    null,
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
