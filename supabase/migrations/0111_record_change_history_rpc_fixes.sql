-- Corrective migration for 0110. 0110 is immutable and remains applied.
-- Restore service-role fixture/bootstrap access to the canonical record doors,
-- and disambiguate the archive wrapper's output column from its PL/pgSQL
-- return variable.

grant execute on function public.create_entity_record_with_relations(uuid, uuid, jsonb, jsonb, uuid) to service_role;
grant execute on function public.update_entity_record_with_relations(uuid, uuid, uuid, jsonb, jsonb, jsonb) to service_role;

create or replace function public.set_entity_records_archived_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_ids uuid[], p_archived boolean
)
returns table (updated_record_count integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before jsonb := '{}'::jsonb;
  v_id uuid;
  v_old timestamptz;
  v_new timestamptz;
  a record;
  v_count integer;
begin
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  for v_id in select distinct unnest(p_record_ids) loop
    select archived_at into v_old
    from entity_records
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = v_id
    for update;
    v_before := v_before || jsonb_build_object(v_id::text, v_old);
  end loop;

  select result.updated_record_count into v_count
  from private.set_entity_records_archived_authorized(
    p_workspace_id, p_entity_type_id, p_record_ids, p_archived
  ) as result;

  for v_id in select distinct unnest(p_record_ids) loop
    select archived_at into v_new
    from entity_records
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = v_id;
    if (v_before ->> v_id::text)::timestamptz is distinct from v_new then
      perform private.record_change_insert(
        p_workspace_id, p_entity_type_id, v_id,
        case when p_archived then 'record_archived' else 'record_restored' end,
        a.effective_actor_user_id, a.real_actor_user_id, a.authority_kind,
        null, null, null,
        jsonb_build_object(
          'archived_at', jsonb_build_object(
            'old_value', v_before -> v_id::text,
            'new_value', to_jsonb(v_new)
          )
        )
      );
    end if;
  end loop;
  return query select v_count;
end;
$$;

revoke all on function public.set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean) from public, anon;
grant execute on function public.set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean) to authenticated, service_role;
