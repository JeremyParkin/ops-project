-- Phase 13.1 corrective migration: the 0110 import wrapper declares a
-- RETURNS TABLE column named imported_row_count. Qualify the source column
-- in the wrapper's history-capture lookup so PostgreSQL does not confuse it
-- with that implicit PL/pgSQL output variable.

create or replace function public.bulk_create_entity_records_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_import_id uuid, p_rows jsonb
)
returns table (imported_row_count integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count integer;
  v_record entity_records%rowtype;
  a record;
  v_relations jsonb;
begin
  if auth.role() = 'service_role' and auth.uid() is null then
    return query select * from private.bulk_create_entity_records_authorized(
      p_workspace_id, p_entity_type_id, p_import_id, p_rows
    );
    return;
  end if;

  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  return query select * from private.bulk_create_entity_records_authorized(
    p_workspace_id, p_entity_type_id, p_import_id, p_rows
  );

  select record_import_batches.imported_row_count
    into v_count
    from record_import_batches
    where record_import_batches.id = p_import_id;

  for v_record in
    select *
    from entity_records
    where workspace_id = p_workspace_id
      and import_batch_id = p_import_id
  loop
    if not exists (
      select 1
      from record_change_events
      where entity_record_id = v_record.id
        and event_type = 'record_created'
    ) then
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'field_definition_id', field_definition_id,
          'target_entity_type_id', target_entity_type_id,
          'target_record_id', target_record_id
        )),
        '[]'::jsonb
      )
        into v_relations
        from entity_record_relation_values
        where workspace_id = p_workspace_id
          and source_record_id = v_record.id;

      perform private.record_change_insert(
        p_workspace_id,
        p_entity_type_id,
        v_record.id,
        'record_created',
        a.effective_actor_user_id,
        a.real_actor_user_id,
        a.authority_kind,
        null,
        null,
        p_import_id,
        private.record_change_payload(
          p_workspace_id,
          p_entity_type_id,
          v_record.id,
          null,
          v_record.values,
          '[]'::jsonb,
          v_relations
        )
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb)
  to authenticated, service_role;
