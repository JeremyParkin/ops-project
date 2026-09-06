-- Corrective migration for 0110/0111/0112. Earlier migrations are immutable.
-- The history wrapper must authorize against the effective impersonated user,
-- matching the established record-mutation capability boundary.

create or replace function public.create_entity_record_with_relations_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_values jsonb, p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a record;
  v_id uuid;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');
  if p_originating_process_step_run_id is not null then
    raise exception 'Process provenance requires the trusted process door';
  end if;
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  v_id := private.record_create_core(
    p_workspace_id, p_entity_type_id, p_values, p_relations,
    a.effective_actor_user_id, a.real_actor_user_id, a.authority_kind
  );
  return v_id;
end;
$$;

create or replace function public.update_entity_record_with_relations_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid, p_values jsonb,
  p_relation_field_ids jsonb, p_relations jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a record;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  return private.record_update_core(
    p_workspace_id, p_entity_type_id, p_record_id, p_values,
    p_relation_field_ids, p_relations,
    a.effective_actor_user_id, a.real_actor_user_id, a.authority_kind
  );
end;
$$;

revoke all on function public.create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
revoke all on function public.update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb) to authenticated, service_role;
