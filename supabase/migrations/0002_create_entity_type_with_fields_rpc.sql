alter table field_definitions
  add constraint field_definitions_position_positive check (position > 0);

create or replace function create_entity_type_with_fields(
  p_workspace_id uuid,
  p_entity_name text,
  p_entity_slug text,
  p_entity_description text,
  p_fields jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_entity_type_id uuid := gen_random_uuid();
  v_field jsonb;
  v_field_type text;
  v_field_position integer;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
    raise exception 'p_fields must be a JSON array';
  end if;

  if jsonb_array_length(p_fields) = 0 then
    raise exception 'p_fields must include at least one field';
  end if;

  insert into entity_types (
    id,
    workspace_id,
    name,
    slug,
    description
  )
  values (
    v_entity_type_id,
    p_workspace_id,
    trim(p_entity_name),
    trim(p_entity_slug),
    nullif(trim(coalesce(p_entity_description, '')), '')
  );

  for v_field in select * from jsonb_array_elements(p_fields)
  loop
    v_field_type := v_field->>'type';
    v_field_position := (v_field->>'position')::integer;

    if v_field_type not in ('text', 'number', 'date', 'boolean') then
      raise exception 'Unsupported field type: %', v_field_type;
    end if;

    if v_field_position <= 0 then
      raise exception 'Field position must be positive';
    end if;

    insert into field_definitions (
      id,
      workspace_id,
      entity_type_id,
      key,
      name,
      slug,
      type,
      required,
      position
    )
    values (
      gen_random_uuid(),
      p_workspace_id,
      v_entity_type_id,
      v_field->>'key',
      v_field->>'name',
      v_field->>'slug',
      v_field_type,
      coalesce((v_field->>'required')::boolean, false),
      v_field_position
    );
  end loop;

  return v_entity_type_id;
end;
$$;
