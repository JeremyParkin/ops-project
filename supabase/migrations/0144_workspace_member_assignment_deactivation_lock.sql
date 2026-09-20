-- Serialize Workspace Member assignment against membership deactivation.
--
-- Migration 0143 validated `workspace_memberships.deactivated_at` with a
-- plain read while deactivation updates the same row under a workspace-level
-- advisory lock. Record writes lock by entity type, so those two operations
-- could interleave. Locking the referenced membership row before checking its
-- active/deactivated state makes the invariant deterministic. When a record
-- contains multiple Workspace Member fields, distinct memberships are locked
-- in user_id order before per-field validation to avoid lock-order deadlocks:
-- deactivation-before-assignment fails the assignment, while
-- assignment-before-deactivation is a truthful earlier assignment.

create or replace function private.apply_workspace_member_record_values(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_field_ids jsonb,
  p_workspace_members jsonb,
  p_allow_existing_deactivated boolean,
  p_validate_required boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member jsonb;
  v_field_id uuid;
  v_member_user_id uuid;
  v_field field_definitions%rowtype;
  v_deactivated_at timestamptz;
  v_locked_member_user_id uuid;
begin
  if p_workspace_members is null or jsonb_typeof(p_workspace_members) <> 'array' then
    raise exception 'p_workspace_members must be a JSON array';
  end if;

  if p_field_ids is null or jsonb_typeof(p_field_ids) <> 'array' then
    raise exception 'p_workspace_member_field_ids must be a JSON array';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_workspace_members) member
    group by member ->> 'field_definition_id'
    having count(*) > 1
  ) then
    raise exception 'A Workspace Member field can have only one value.';
  end if;

  if p_validate_required then
    for v_field in
      select *
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and type = 'workspace_member'
        and required = true
        and archived_at is null
    loop
      if not exists (
        select 1
        from jsonb_array_elements(p_workspace_members) member
        where member ->> 'field_definition_id' = v_field.id::text
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    end loop;
  end if;

  for v_field_id in
    select trim(both '"' from field_id::text)::uuid
    from jsonb_array_elements(p_field_ids) field_id
  loop
    if not exists (
      select 1
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and id = v_field_id
        and type = 'workspace_member'
    ) then
      raise exception 'Workspace Member values must reference Workspace Member fields on this object.';
    end if;
  end loop;

  begin
    for v_locked_member_user_id in
      select distinct (member ->> 'member_user_id')::uuid
      from jsonb_array_elements(p_workspace_members) member
      order by (member ->> 'member_user_id')::uuid
    loop
      perform 1
      from workspace_memberships
      where workspace_id = p_workspace_id
        and user_id = v_locked_member_user_id
      for update;
    end loop;
  exception when invalid_text_representation then
    raise exception 'Workspace Member values must use valid UUIDs.';
  end;

  for v_member in
    select *
    from jsonb_array_elements(p_workspace_members)
  loop
    begin
      v_field_id := (v_member ->> 'field_definition_id')::uuid;
      v_member_user_id := (v_member ->> 'member_user_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Workspace Member values must use valid UUIDs.';
    end;

    select *
      into v_field
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and id = v_field_id
        and type = 'workspace_member'
        and archived_at is null;

    if not found then
      raise exception 'Workspace Member values must reference active Workspace Member fields on this object.';
    end if;

    if not exists (
      select 1
      from jsonb_array_elements(p_field_ids) field_id
      where trim(both '"' from field_id::text) = v_field_id::text
    ) then
      raise exception 'Workspace Member payload included a field outside p_workspace_member_field_ids.';
    end if;

    select deactivated_at
      into v_deactivated_at
      from workspace_memberships
      where workspace_id = p_workspace_id
        and user_id = v_member_user_id;

    if not found then
      raise exception '% must reference a workspace member.', v_field.name;
    end if;

    if v_deactivated_at is not null and not (
      p_allow_existing_deactivated
      and exists (
        select 1
        from entity_record_workspace_member_values existing
        where existing.workspace_id = p_workspace_id
          and existing.source_entity_type_id = p_entity_type_id
          and existing.source_record_id = p_record_id
          and existing.field_definition_id = v_field_id
          and existing.member_user_id = v_member_user_id
      )
    ) then
      raise exception '% must reference an active workspace member.', v_field.name;
    end if;
  end loop;

  delete from entity_record_workspace_member_values value
  where value.workspace_id = p_workspace_id
    and value.source_entity_type_id = p_entity_type_id
    and value.source_record_id = p_record_id
    and value.field_definition_id in (
      select trim(both '"' from field_id::text)::uuid
      from jsonb_array_elements(p_field_ids) field_id
    );

  for v_member in
    select *
    from jsonb_array_elements(p_workspace_members)
  loop
    v_field_id := (v_member ->> 'field_definition_id')::uuid;
    v_member_user_id := (v_member ->> 'member_user_id')::uuid;

    insert into entity_record_workspace_member_values (
      workspace_id,
      source_entity_type_id,
      source_record_id,
      field_definition_id,
      member_user_id
    )
    values (
      p_workspace_id,
      p_entity_type_id,
      p_record_id,
      v_field_id,
      v_member_user_id
    );
  end loop;
end;
$$;
