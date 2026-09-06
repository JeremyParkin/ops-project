-- Phase 13.1: trusted record-change history and deterministic mutation doors.
-- The existing record functions remain the canonical validation/data-integrity
-- implementation. These private cores add attribution and capture around
-- them; no caller-controlled authority is accepted.

create table record_change_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type_id uuid not null,
  entity_record_id uuid not null,
  entity_type_name_snapshot text not null,
  event_type text not null check (event_type in ('record_created', 'record_updated', 'record_archived', 'record_restored')),
  effective_actor_user_id uuid,
  real_actor_user_id uuid,
  authority_kind text not null check (authority_kind in ('human', 'impersonated', 'automation', 'process')),
  originating_workflow_id uuid,
  originating_process_step_run_id uuid,
  import_batch_id uuid,
  changes jsonb not null,
  created_at timestamptz not null default now(),
  check ((authority_kind = 'human' and effective_actor_user_id is not null and real_actor_user_id is null)
    or (authority_kind = 'impersonated' and effective_actor_user_id is not null and real_actor_user_id is not null and effective_actor_user_id <> real_actor_user_id)
    or (authority_kind in ('automation', 'process') and effective_actor_user_id is null and real_actor_user_id is null))
);

create index record_change_events_record_idx
  on record_change_events (workspace_id, entity_type_id, entity_record_id, created_at desc, id desc);
create index record_change_events_workspace_idx
  on record_change_events (workspace_id, created_at desc, id desc);
create unique index record_change_events_process_create_once_idx
  on record_change_events (workspace_id, originating_process_step_run_id)
  where event_type = 'record_created' and originating_process_step_run_id is not null;

alter table record_change_events enable row level security;
revoke all on table record_change_events from public, anon, authenticated, service_role;

create or replace function private.reject_record_change_history_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Record change history is append-only';
  end if;
  -- Direct deletes while the workspace exists are forbidden. A workspace
  -- cascade is allowed only after the parent row has disappeared.
  if exists (select 1 from public.workspaces where id = old.workspace_id) then
    raise exception 'Record change history is append-only';
  end if;
  return old;
end;
$$;

create trigger record_change_events_append_only
  before update or delete on record_change_events
  for each row execute function private.reject_record_change_history_mutation();

create or replace function private.record_change_interactive_attribution(p_workspace_id uuid)
returns table (effective_actor_user_id uuid, real_actor_user_id uuid, authority_kind text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_effective uuid := private.current_effective_user(p_workspace_id);
  v_real uuid := auth.uid();
begin
  if v_effective is null then raise exception 'Interactive actor is required'; end if;
  if v_real is not null and v_real <> v_effective then
    return query select v_effective, v_real, 'impersonated'::text;
  end if;
  return query select v_effective, null::uuid, 'human'::text;
end;
$$;

create or replace function private.record_change_label(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid, p_values jsonb
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text; v_label text;
begin
  select fd.key into v_key
  from entity_types et join field_definitions fd on fd.id = et.display_field_definition_id
  where et.workspace_id = p_workspace_id and et.id = p_entity_type_id;
  if v_key is null then
    select fd.key into v_key from field_definitions fd
    where fd.workspace_id = p_workspace_id and fd.entity_type_id = p_entity_type_id
      and fd.type = 'text' and fd.archived_at is null order by fd.position limit 1;
  end if;
  v_label := case when v_key is null then null else p_values ->> v_key end;
  return coalesce(nullif(trim(v_label), ''), left(p_record_id::text, 8));
end;
$$;

create or replace function private.record_change_payload(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid,
  p_old_values jsonb, p_new_values jsonb,
  p_old_relations jsonb, p_new_relations jsonb
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fields jsonb := '[]'::jsonb;
  v_relations jsonb := '[]'::jsonb;
  v_field field_definitions%rowtype;
  v_old jsonb; v_new jsonb; v_old_id uuid; v_new_id uuid;
  v_old_label text; v_new_label text;
begin
  for v_field in select * from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and archived_at is null
    order by position loop
    if v_field.type = 'relation' then
      begin
        v_old_id := (select value->>'target_record_id' from jsonb_array_elements(coalesce(p_old_relations, '[]'::jsonb)) value where value->>'field_definition_id' = v_field.id::text limit 1)::uuid;
      exception when invalid_text_representation then v_old_id := null; end;
      begin
        v_new_id := (select value->>'target_record_id' from jsonb_array_elements(coalesce(p_new_relations, '[]'::jsonb)) value where value->>'field_definition_id' = v_field.id::text limit 1)::uuid;
      exception when invalid_text_representation then v_new_id := null; end;
      if v_old_id is distinct from v_new_id then
        select private.record_change_label(p_workspace_id, v_field.related_entity_type_id, v_old_id, r.values)
          into v_old_label from entity_records r where r.workspace_id = p_workspace_id and r.id = v_old_id;
        select private.record_change_label(p_workspace_id, v_field.related_entity_type_id, v_new_id, r.values)
          into v_new_label from entity_records r where r.workspace_id = p_workspace_id and r.id = v_new_id;
        v_relations := v_relations || jsonb_build_array(jsonb_build_object(
          'field_definition_id', v_field.id, 'field_key', v_field.key, 'field_name_snapshot', v_field.name,
          'old_target_record_id', v_old_id, 'old_target_label_snapshot', v_old_label,
          'new_target_record_id', v_new_id, 'new_target_label_snapshot', v_new_label));
      end if;
    else
      v_old := coalesce(p_old_values, '{}'::jsonb) -> v_field.key;
      v_new := coalesce(p_new_values, '{}'::jsonb) -> v_field.key;
      if v_old is distinct from v_new then
        v_fields := v_fields || jsonb_build_array(jsonb_build_object(
          'field_definition_id', v_field.id, 'field_key', v_field.key, 'field_name_snapshot', v_field.name,
          'field_type', v_field.type, 'old_value', v_old, 'new_value', v_new,
          'old_choice_label_snapshot', (select label from field_choice_options where field_definition_id = v_field.id and id::text = v_old #>> '{}'),
          'old_choice_color_snapshot', (select color from field_choice_options where field_definition_id = v_field.id and id::text = v_old #>> '{}'),
          'new_choice_label_snapshot', (select label from field_choice_options where field_definition_id = v_field.id and id::text = v_new #>> '{}'),
          'new_choice_color_snapshot', (select color from field_choice_options where field_definition_id = v_field.id and id::text = v_new #>> '{}')));
      end if;
    end if;
  end loop;
  return jsonb_build_object('fields', v_fields, 'relations', v_relations);
end;
$$;

create or replace function private.record_change_insert(
  p_workspace_id uuid, p_entity_type_id uuid, p_entity_record_id uuid,
  p_event_type text, p_effective_actor uuid, p_real_actor uuid, p_authority_kind text,
  p_workflow_id uuid, p_process_step_run_id uuid, p_import_batch_id uuid, p_changes jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := gen_random_uuid(); v_name text;
begin
  select name into v_name from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  if v_name is null then v_name := 'Deleted object'; end if;
  insert into record_change_events
    (id, workspace_id, entity_type_id, entity_record_id, entity_type_name_snapshot, event_type,
     effective_actor_user_id, real_actor_user_id, authority_kind, originating_workflow_id,
     originating_process_step_run_id, import_batch_id, changes)
  values (v_id, p_workspace_id, p_entity_type_id, p_entity_record_id, v_name, p_event_type,
     p_effective_actor, p_real_actor, p_authority_kind, p_workflow_id,
     p_process_step_run_id, p_import_batch_id, coalesce(p_changes, '{}'::jsonb))
  on conflict do nothing;
  return v_id;
end;
$$;

create or replace function private.record_create_core(
  p_workspace_id uuid, p_entity_type_id uuid, p_values jsonb, p_relations jsonb,
  p_effective_actor uuid, p_real_actor uuid, p_authority_kind text,
  p_workflow_id uuid default null, p_process_step_run_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_actual_values jsonb; v_actual_relations jsonb;
begin
  v_id := public.create_entity_record_with_relations(p_workspace_id, p_entity_type_id, p_values, p_relations, p_process_step_run_id);
  select values into v_actual_values from entity_records where workspace_id = p_workspace_id and id = v_id;
  select coalesce(jsonb_agg(jsonb_build_object('field_definition_id', field_definition_id, 'target_entity_type_id', target_entity_type_id, 'target_record_id', target_record_id)), '[]'::jsonb)
    into v_actual_relations from entity_record_relation_values where workspace_id = p_workspace_id and source_record_id = v_id;
  perform private.record_change_insert(p_workspace_id, p_entity_type_id, v_id, 'record_created', p_effective_actor, p_real_actor, p_authority_kind, p_workflow_id, p_process_step_run_id, null,
    private.record_change_payload(p_workspace_id, p_entity_type_id, v_id, null, v_actual_values, '[]'::jsonb, v_actual_relations));
  return v_id;
end;
$$;

create or replace function private.record_update_core(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid, p_values jsonb,
  p_relation_field_ids jsonb, p_relations jsonb, p_effective_actor uuid, p_real_actor uuid,
  p_authority_kind text, p_workflow_id uuid default null, p_process_step_run_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old_values jsonb; v_old_relations jsonb; v_new_values jsonb; v_new_relations jsonb; v_changes jsonb; v_id uuid;
begin
  select values into v_old_values from entity_records where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id for update;
  select coalesce(jsonb_agg(jsonb_build_object('field_definition_id', field_definition_id, 'target_entity_type_id', target_entity_type_id, 'target_record_id', target_record_id)), '[]'::jsonb)
    into v_old_relations from entity_record_relation_values where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and source_record_id = p_record_id;
  v_id := public.update_entity_record_with_relations(p_workspace_id, p_entity_type_id, p_record_id, p_values, p_relation_field_ids, p_relations);
  select values into v_new_values from entity_records where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id;
  select coalesce(jsonb_agg(jsonb_build_object('field_definition_id', field_definition_id, 'target_entity_type_id', target_entity_type_id, 'target_record_id', target_record_id)), '[]'::jsonb)
    into v_new_relations from entity_record_relation_values where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and source_record_id = p_record_id;
  v_changes := private.record_change_payload(p_workspace_id, p_entity_type_id, p_record_id, v_old_values, v_new_values, v_old_relations, v_new_relations);
  if jsonb_array_length(v_changes->'fields') > 0 or jsonb_array_length(v_changes->'relations') > 0 then
    perform private.record_change_insert(p_workspace_id, p_entity_type_id, p_record_id, 'record_updated', p_effective_actor, p_real_actor, p_authority_kind, p_workflow_id, p_process_step_run_id, null, v_changes);
  end if;
  return v_id;
end;
$$;

create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_values jsonb, p_relations jsonb, p_originating_process_step_run_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare a record; v_id uuid;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  if p_originating_process_step_run_id is not null then raise exception 'Process provenance requires the trusted process door'; end if;
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  v_id := private.record_create_core(p_workspace_id, p_entity_type_id, p_values, p_relations, a.effective_actor_user_id, a.real_actor_user_id, a.authority_kind);
  return v_id;
end;
$$;

create or replace function update_entity_record_with_relations_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid, p_values jsonb, p_relation_field_ids jsonb, p_relations jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare a record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  return private.record_update_core(p_workspace_id, p_entity_type_id, p_record_id, p_values, p_relation_field_ids, p_relations, a.effective_actor_user_id, a.real_actor_user_id, a.authority_kind);
end;
$$;

create or replace function private.assert_automation_cause(p_workspace_id uuid, p_workflow_id uuid, p_entity_type_id uuid, p_action_type text, p_related_field_definition_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from workflows w, jsonb_array_elements(w.actions) a
    where w.workspace_id = p_workspace_id and w.id = p_workflow_id
      and ((p_action_type = 'create_record' and a->>'actionType' = 'create_record' and a->>'actionTargetEntityTypeId' = p_entity_type_id::text)
        or (p_action_type = 'update_record' and a->>'actionType' = 'update_record' and w.trigger_entity_type_id = p_entity_type_id)
        or (p_action_type = 'update_related_record' and a->>'actionType' = 'update_related_record'
          and a->>'relatedFieldDefinitionId' = p_related_field_definition_id::text
          and exists (select 1 from field_definitions fd where fd.workspace_id = p_workspace_id and fd.id = p_related_field_definition_id and fd.archived_at is null and fd.related_entity_type_id = p_entity_type_id)))
  ) then
    raise exception 'Workflow cause is not compatible with this record target';
  end if;
  if exists (select 1 from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id and people_sensitive) then
    raise exception 'Deterministic actions cannot mutate people-sensitive records';
  end if;
end;
$$;

create or replace function private.assert_process_cause(p_workspace_id uuid, p_step_run_id uuid, p_entity_type_id uuid, p_action_type text, p_related_field_definition_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from process_step_runs s join process_runs r on r.id = s.process_run_id and r.workspace_id = s.workspace_id
    where s.workspace_id = p_workspace_id and s.id = p_step_run_id and s.node_type = 'action'
      and s.config->'action_config'->>'action_type' = p_action_type
      and (s.status = 'active' or (p_action_type = 'create_record' and exists (select 1 from entity_records er where er.workspace_id = p_workspace_id and er.originating_process_step_run_id = p_step_run_id)))
      and ((p_action_type = 'create_record' and s.config->'action_config'->>'action_target_entity_type_id' = p_entity_type_id::text)
        or (p_action_type = 'update_record' and r.origin_entity_type_id = p_entity_type_id)
        or (p_action_type = 'update_related_record' and s.config->'action_config'->>'related_field_definition_id' = p_related_field_definition_id::text
          and exists (select 1 from field_definitions fd where fd.workspace_id = p_workspace_id and fd.id = p_related_field_definition_id and fd.archived_at is null and fd.related_entity_type_id = p_entity_type_id)))) then
    raise exception 'Process cause is not compatible with this record mutation';
  end if;
  if exists (select 1 from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id and people_sensitive) then
    raise exception 'Deterministic actions cannot mutate people-sensitive records';
  end if;
end;
$$;

create or replace function create_entity_record_with_relations_automation_system(
  p_workspace_id uuid, p_entity_type_id uuid, p_values jsonb, p_relations jsonb, p_originating_workflow_id uuid, p_action_type text, p_related_field_definition_id uuid
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.assert_automation_cause(p_workspace_id, p_originating_workflow_id, p_entity_type_id, p_action_type, p_related_field_definition_id);
  return private.record_create_core(p_workspace_id, p_entity_type_id, p_values, p_relations, null, null, 'automation', p_originating_workflow_id);
end;
$$;

create or replace function update_entity_record_with_relations_automation_system(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid, p_values jsonb, p_relation_field_ids jsonb, p_relations jsonb, p_originating_workflow_id uuid, p_action_type text, p_related_field_definition_id uuid
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.assert_automation_cause(p_workspace_id, p_originating_workflow_id, p_entity_type_id, p_action_type, p_related_field_definition_id);
  return private.record_update_core(p_workspace_id, p_entity_type_id, p_record_id, p_values, p_relation_field_ids, p_relations, null, null, 'automation', p_originating_workflow_id);
end;
$$;

create or replace function create_entity_record_with_relations_process_system(
  p_workspace_id uuid, p_entity_type_id uuid, p_values jsonb, p_relations jsonb, p_originating_process_step_run_id uuid, p_action_type text, p_related_field_definition_id uuid
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.assert_process_cause(p_workspace_id, p_originating_process_step_run_id, p_entity_type_id, p_action_type, p_related_field_definition_id);
  return private.record_create_core(p_workspace_id, p_entity_type_id, p_values, p_relations, null, null, 'process', null, p_originating_process_step_run_id);
end;
$$;

create or replace function update_entity_record_with_relations_process_system(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid, p_values jsonb, p_relation_field_ids jsonb, p_relations jsonb, p_originating_process_step_run_id uuid, p_action_type text, p_related_field_definition_id uuid
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.assert_process_cause(p_workspace_id, p_originating_process_step_run_id, p_entity_type_id, p_action_type, p_related_field_definition_id);
  return private.record_update_core(p_workspace_id, p_entity_type_id, p_record_id, p_values, p_relation_field_ids, p_relations, null, null, 'process', null, p_originating_process_step_run_id);
end;
$$;

revoke all on function public.create_entity_record_with_relations(uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.update_entity_record_with_relations(uuid, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function create_entity_record_with_relations_automation_system(uuid, uuid, jsonb, jsonb, uuid, text, uuid), update_entity_record_with_relations_automation_system(uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, text, uuid), create_entity_record_with_relations_process_system(uuid, uuid, jsonb, jsonb, uuid, text, uuid), update_entity_record_with_relations_process_system(uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, text, uuid) from public, anon, authenticated;
grant execute on function create_entity_record_with_relations_automation_system(uuid, uuid, jsonb, jsonb, uuid, text, uuid), update_entity_record_with_relations_automation_system(uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, text, uuid), create_entity_record_with_relations_process_system(uuid, uuid, jsonb, jsonb, uuid, text, uuid), update_entity_record_with_relations_process_system(uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, text, uuid) to service_role;

comment on table record_change_events is 'Append-only generic record history. Identity columns are intentionally soft so history survives domain deletion.';

-- Move the existing bulk/archive implementations behind private names so the
-- public wrappers can capture history in the same transaction without
-- duplicating their validation bodies.
alter function public.bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb) set schema private;
alter function public.set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean) set schema private;

create or replace function bulk_create_entity_records_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_import_id uuid, p_rows jsonb
)
returns table (imported_row_count integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer; v_record entity_records%rowtype; a record; v_relations jsonb;
begin
  -- Service-role bulk calls are fixture/bootstrap plumbing in this repo and
  -- have no truthful human actor. Production imports enter through the
  -- authenticated path below; bootstrap calls retain their pre-13.1
  -- behavior rather than fabricating audit attribution.
  if auth.role() = 'service_role' and auth.uid() is null then
    return query select * from private.bulk_create_entity_records_authorized(p_workspace_id, p_entity_type_id, p_import_id, p_rows);
    return;
  end if;
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  return query select * from private.bulk_create_entity_records_authorized(p_workspace_id, p_entity_type_id, p_import_id, p_rows);
  select imported_row_count into v_count from record_import_batches where id = p_import_id;
  for v_record in select * from entity_records where workspace_id = p_workspace_id and import_batch_id = p_import_id loop
    if not exists (select 1 from record_change_events where entity_record_id = v_record.id and event_type = 'record_created') then
      select coalesce(jsonb_agg(jsonb_build_object('field_definition_id', field_definition_id, 'target_entity_type_id', target_entity_type_id, 'target_record_id', target_record_id)), '[]'::jsonb)
        into v_relations from entity_record_relation_values where workspace_id = p_workspace_id and source_record_id = v_record.id;
      perform private.record_change_insert(p_workspace_id, p_entity_type_id, v_record.id, 'record_created', a.effective_actor_user_id, a.real_actor_user_id, a.authority_kind, null, null, p_import_id,
        private.record_change_payload(p_workspace_id, p_entity_type_id, v_record.id, null, v_record.values, '[]'::jsonb, v_relations));
    end if;
  end loop;
end;
$$;

create or replace function set_entity_records_archived_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_ids uuid[], p_archived boolean
)
returns table (updated_record_count integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_before jsonb := '{}'::jsonb; v_id uuid; v_old timestamptz; v_new timestamptz; a record; v_count integer;
begin
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  for v_id in select distinct unnest(p_record_ids) loop
    select archived_at into v_old from entity_records where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = v_id for update;
    v_before := v_before || jsonb_build_object(v_id::text, v_old);
  end loop;
  select updated_record_count into v_count from private.set_entity_records_archived_authorized(p_workspace_id, p_entity_type_id, p_record_ids, p_archived);
  for v_id in select distinct unnest(p_record_ids) loop
    select archived_at into v_new
    from entity_records
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = v_id;
    if (v_before ->> v_id::text)::timestamptz is distinct from v_new then
      perform private.record_change_insert(p_workspace_id, p_entity_type_id, v_id,
        case when p_archived then 'record_archived' else 'record_restored' end,
        a.effective_actor_user_id, a.real_actor_user_id, a.authority_kind, null, null, null,
        jsonb_build_object('archived_at', jsonb_build_object('old_value', v_before -> v_id::text, 'new_value', to_jsonb(v_new))));
    end if;
  end loop;
  return query select v_count;
end;
$$;

-- The existing Workflow guard covered explicit create/update targets. Resolve
-- update_related_record's target through its configured relation field too.
create or replace function private.reject_people_sensitive_workflow_target()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.entity_types et where et.workspace_id = new.workspace_id and et.id = new.trigger_entity_type_id and et.people_sensitive) then
    raise exception 'Workflows cannot trigger on people-sensitive entity types';
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.actions) action
    join public.entity_types et on et.workspace_id = new.workspace_id and (
      action ->> 'actionTargetEntityTypeId' = et.id::text
      or exists (select 1 from public.field_definitions fd where fd.workspace_id = new.workspace_id and fd.id = (action ->> 'relatedFieldDefinitionId')::uuid and fd.related_entity_type_id = et.id)
    ) where et.people_sensitive
  ) then raise exception 'Workflows cannot target people-sensitive entity types'; end if;
  return new;
end;
$$;

create or replace function private.reject_people_sensitive_process_action_target()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from public.process_templates t join public.entity_types et
      on et.workspace_id = t.workspace_id and et.id = t.applies_to_entity_type_id
    where t.workspace_id = new.workspace_id and t.id = new.process_template_id and et.people_sensitive
  ) then raise exception 'Process Templates cannot target people-sensitive entity types'; end if;
  if exists (
    select 1 from public.process_templates t
    join public.entity_types et on et.workspace_id = t.workspace_id and (
      new.config -> 'action_config' ->> 'action_target_entity_type_id' = et.id::text
      or exists (select 1 from public.field_definitions fd where fd.workspace_id = t.workspace_id and fd.id = (new.config -> 'action_config' ->> 'related_field_definition_id')::uuid and fd.related_entity_type_id = et.id)
    )
    where t.workspace_id = new.workspace_id and t.id = new.process_template_id and et.people_sensitive
  ) then raise exception 'Process action nodes cannot target people-sensitive entity types'; end if;
  return new;
end;
$$;

drop trigger if exists process_nodes_reject_sensitive_action_target on process_nodes;
create trigger process_nodes_reject_sensitive_action_target
  before insert or update on process_nodes
  for each row execute function private.reject_people_sensitive_process_action_target();

revoke all on function bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb), set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean) from public, anon;
grant execute on function bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb), set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean) to authenticated, service_role;

alter function public.list_record_activity_authorized(uuid, uuid, uuid, integer) set schema private;

create or replace function list_record_activity_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_entity_record_id uuid, p_limit integer default 20
)
returns table (
  id uuid, event_type text, created_at timestamptz, actor_user_id uuid, actor_label text,
  process_run_id uuid, process_run_name text, process_step_run_id uuid, step_name text,
  assignee_label text, approval_outcome_label text, is_recurrence_started boolean,
  cancellation_reason text, from_assignee_label text, to_assignee_label text,
  changes jsonb, authority_kind text, real_actor_label text, entity_type_name_snapshot text
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'Activity limit must be between 1 and 100'; end if;
  if not private.can_view_people_sensitive_record(p_workspace_id, p_entity_type_id, p_entity_record_id, private.current_effective_user(p_workspace_id)) then return; end if;
  return query
  select * from (
    select old.id, old.event_type, old.created_at, old.actor_user_id, old.actor_label,
      old.process_run_id, old.process_run_name, old.process_step_run_id, old.step_name,
      old.assignee_label, old.approval_outcome_label, old.is_recurrence_started,
      old.cancellation_reason, old.from_assignee_label, old.to_assignee_label,
      null::jsonb as changes, null::text as authority_kind, null::text as real_actor_label,
      null::text as entity_type_name_snapshot
    from private.list_record_activity_authorized(p_workspace_id, p_entity_type_id, p_entity_record_id, p_limit) old
    union all
    select h.id, h.event_type, h.created_at, h.effective_actor_user_id,
      case when h.authority_kind = 'automation' then 'Automation'
           when h.authority_kind = 'process' then 'Process action'
           else coalesce(actor.email, 'Unknown user') end,
      null::uuid, null::text, h.originating_process_step_run_id, null::text,
      null::text, null::text, false, null::text, null::text, null::text,
      h.changes, h.authority_kind, real_actor.email, h.entity_type_name_snapshot
    from record_change_events h
    left join auth.users actor on actor.id = h.effective_actor_user_id
    left join auth.users real_actor on real_actor.id = h.real_actor_user_id
    where h.workspace_id = p_workspace_id and h.entity_type_id = p_entity_type_id and h.entity_record_id = p_entity_record_id
  ) activity
  order by activity.created_at desc, activity.id desc
  limit p_limit;
end;
$$;

revoke all on function list_record_activity_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_record_activity_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;

-- Private helpers are callable by the security-definer wrappers only. The
-- private schema itself is not an execution boundary.
revoke all on function
  private.bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb),
  private.set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean),
  private.list_record_activity_authorized(uuid, uuid, uuid, integer),
  private.record_change_interactive_attribution(uuid),
  private.record_change_label(uuid, uuid, uuid, jsonb),
  private.record_change_payload(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb),
  private.record_change_insert(uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, uuid, jsonb),
  private.record_create_core(uuid, uuid, jsonb, jsonb, uuid, uuid, text, uuid, uuid),
  private.record_update_core(uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, uuid, text, uuid, uuid),
  private.assert_automation_cause(uuid, uuid, uuid, text, uuid),
  private.assert_process_cause(uuid, uuid, uuid, text, uuid),
  private.reject_record_change_history_mutation(),
  private.reject_people_sensitive_workflow_target(),
  private.reject_people_sensitive_process_action_target()
from public, anon, authenticated, service_role;

-- All authenticated archive/restore writes must pass through the history-
-- writing RPC. Service-role fixture cleanup retains its elevated authority.
revoke update (archived_at, updated_at) on table entity_records from authenticated;
