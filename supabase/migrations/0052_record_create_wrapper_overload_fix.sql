-- 0046 accidentally reintroduced a four-argument overload after process
-- action nodes established the canonical five-argument record-create wrapper.
-- Keep one signature so PostgREST can resolve authenticated calls reliably.

drop function if exists create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb);

create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return create_entity_record_with_relations(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    p_originating_process_step_run_id
  );
end;
$$;

revoke all on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
