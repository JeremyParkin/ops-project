-- Field reorder (Move Up/Move Down) swapped two field_definitions.position
-- values via three separate app-issued UPDATE statements (a sentinel
-- intermediate position, needed because of the unique(entity_type_id,
-- position) constraint below). Each statement was its own transaction, so a
-- request interrupted between them (a crashed process, a dropped connection)
-- could permanently strand the first field at the sentinel position. Moving
-- all three updates into one PL/pgSQL function makes them one transaction:
-- an interruption during execution now rolls back entirely instead of
-- partially applying. No security definer -- this remains subject to the
-- same field_definitions_schema_write RLS policy (schema.manage) as every
-- other field mutation, exactly like update_field_definition above it.
create or replace function swap_field_definition_positions(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_first_field_id uuid,
  p_second_field_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_first field_definitions%rowtype;
  v_second field_definitions%rowtype;
  v_sentinel constant integer := 2147483647;
begin
  select * into v_first
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_first_field_id;

  if not found then
    raise exception 'Field definition not found';
  end if;

  select * into v_second
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_second_field_id;

  if not found then
    raise exception 'Field definition not found';
  end if;

  update field_definitions
  set position = v_sentinel, updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = v_first.id;

  update field_definitions
  set position = v_first.position, updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = v_second.id;

  update field_definitions
  set position = v_second.position, updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = v_first.id;
end;
$$;

revoke all on function swap_field_definition_positions(uuid, uuid, uuid, uuid) from public;
grant execute on function swap_field_definition_positions(uuid, uuid, uuid, uuid) to authenticated, service_role;
