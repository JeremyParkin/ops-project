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
begin
  if p_type not in ('text', 'number', 'date', 'boolean', 'relation') then
    raise exception 'Unsupported field type: %', p_type;
  end if;

  if p_type = 'relation' and p_related_entity_type_id is null then
    raise exception 'Relation fields require a related entity type';
  end if;

  if p_type <> 'relation' and p_related_entity_type_id is not null then
    raise exception 'Only relation fields may declare a related entity type';
  end if;

  -- Concurrency guard for assigning the next field position. The lock key is
  -- derived from the entity type UUID text, so concurrent additions to the same
  -- entity serialize while additions to different entities can proceed.
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  select coalesce(max(position), 0) + 1
    into v_next_position
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id;

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
    p_entity_type_id,
    p_key,
    trim(p_name),
    trim(p_slug),
    p_type,
    p_related_entity_type_id,
    p_required,
    v_next_position
  );

  return v_field_definition_id;
end;
$$;
