alter table entity_records
add column if not exists archived_at timestamptz null;

create index if not exists entity_records_archive_lookup_idx
on entity_records (workspace_id, entity_type_id, archived_at);

create or replace function delete_entity_record_if_unreferenced(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns table (
  deleted boolean,
  reference_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_reference_count integer := 0;
begin
  if not exists (
    select 1
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_record_id
  ) then
    raise exception 'Record not found';
  end if;

  select count(*)
    into v_reference_count
  from entity_record_relation_values
  where workspace_id = p_workspace_id
    and target_entity_type_id = p_entity_type_id
    and target_record_id = p_record_id;

  if v_reference_count > 0 then
    return query select false, v_reference_count;
    return;
  end if;

  delete from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  return query select true, 0;
end;
$$;
