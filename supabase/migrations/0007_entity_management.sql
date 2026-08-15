alter table entity_types
add column if not exists archived_at timestamptz null;

create index if not exists entity_types_archive_lookup_idx
on entity_types (workspace_id, archived_at, created_at);

create or replace function delete_entity_type_if_safe(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns table (
  deleted boolean,
  record_count integer,
  relation_field_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_record_count integer := 0;
  v_relation_field_count integer := 0;
begin
  if not exists (
    select 1
    from entity_types
    where workspace_id = p_workspace_id
      and id = p_entity_type_id
  ) then
    raise exception 'Entity type not found';
  end if;

  select count(*)
    into v_record_count
  from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id;

  select count(*)
    into v_relation_field_count
  from field_definitions
  where workspace_id = p_workspace_id
    and related_entity_type_id = p_entity_type_id;

  if v_record_count > 0 or v_relation_field_count > 0 then
    return query select false, v_record_count, v_relation_field_count;
    return;
  end if;

  delete from entity_types
  where workspace_id = p_workspace_id
    and id = p_entity_type_id;

  return query select true, 0, 0;
end;
$$;
