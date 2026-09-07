-- Phase 13.2B3a: semantic governance history for Workflow configuration.
-- Workflows intentionally retain authenticated direct DML under automation.manage
-- RLS, so the trigger is the single capture boundary for create/update/delete.

alter table governance_audit_events
  drop constraint if exists governance_audit_events_event_type_check,
  drop constraint if exists governance_audit_events_subject_kind_check,
  drop constraint if exists governance_audit_events_subject_hierarchy_check;

alter table governance_audit_events
  add constraint governance_audit_events_event_type_check check (event_type in (
    'field_created', 'field_updated', 'field_archived', 'field_restored', 'field_deleted',
    'choice_option_created', 'choice_option_updated', 'choice_option_archived', 'choice_option_restored',
    'entity_type_created', 'entity_type_updated', 'entity_type_archived', 'entity_type_restored', 'entity_type_deleted',
    'workflow_created', 'workflow_updated', 'workflow_enabled', 'workflow_disabled', 'workflow_deleted'
  )),
  add constraint governance_audit_events_subject_kind_check check (subject_kind in ('field', 'choice_option', 'entity_type', 'workflow')),
  add constraint governance_audit_events_subject_hierarchy_check check (
    (subject_kind = 'entity_type' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'field' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind = 'choice_option' and parent_entity_type_id is not null and parent_field_id is not null)
    or (subject_kind = 'workflow' and parent_entity_type_id is null and parent_field_id is null)
  );

create or replace function private.workflow_governance_snapshot(
  p_workspace_id uuid,
  p_trigger_entity_type_id uuid,
  p_trigger_type text,
  p_action_config jsonb,
  p_actions jsonb
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_trigger_name text;
  v_watched_fields jsonb := '[]'::jsonb;
  v_conditions jsonb := coalesce(p_action_config->'conditions', '[]'::jsonb);
  v_actions jsonb := '[]'::jsonb;
  v_action jsonb;
  v_index integer := 0;
  v_target_name text;
  v_relation_name text;
  v_process_name text;
begin
  select name into v_trigger_name from entity_types
  where workspace_id = p_workspace_id and id = p_trigger_entity_type_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', field.id, 'name', field.name
  ) order by field.position), '[]'::jsonb)
  into v_watched_fields
  from field_definitions field
  where field.workspace_id = p_workspace_id
    and field.id in (
      select (value #>> '{}')::uuid
      from jsonb_array_elements(coalesce(p_action_config->'triggerConfig'->'watchedFieldDefinitionIds', '[]'::jsonb))
    );

  for v_action in select value from jsonb_array_elements(coalesce(p_actions, '[]'::jsonb)) loop
    v_index := v_index + 1;
    v_target_name := null;
    v_relation_name := null;
    v_process_name := null;
    if nullif(v_action->>'actionTargetEntityTypeId', '') is not null then
      select name into v_target_name from entity_types where workspace_id = p_workspace_id and id = (v_action->>'actionTargetEntityTypeId')::uuid;
    end if;
    if nullif(v_action->>'relatedFieldDefinitionId', '') is not null then
      select name into v_relation_name from field_definitions where workspace_id = p_workspace_id and id = (v_action->>'relatedFieldDefinitionId')::uuid;
    end if;
    if nullif(v_action->>'processTemplateId', '') is not null then
      select name into v_process_name from process_templates where workspace_id = p_workspace_id and id = (v_action->>'processTemplateId')::uuid;
    end if;
    v_actions := v_actions || jsonb_build_array(jsonb_build_object(
      'index', v_index,
      'action_type', v_action->>'actionType',
      'target_entity_type_id', nullif(v_action->>'actionTargetEntityTypeId', ''),
      'target_entity_type_name', v_target_name,
      'related_field_definition_id', nullif(v_action->>'relatedFieldDefinitionId', ''),
      'related_field_name', v_relation_name,
      'process_template_id', nullif(v_action->>'processTemplateId', ''),
      'process_template_name', v_process_name,
      'field_mapping_count', jsonb_array_length(coalesce(v_action->'fieldMappings', '[]'::jsonb))
    ));
  end loop;

  return jsonb_build_object(
    'trigger_type', p_trigger_type,
    'trigger_entity_type', jsonb_build_object('id', p_trigger_entity_type_id, 'name', v_trigger_name),
    'watched_fields', v_watched_fields,
    'conditions', v_conditions,
    'actions', v_actions
  );
end;
$$;

revoke all on function private.workflow_governance_snapshot(uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.capture_workflow_governance_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old_snapshot jsonb;
  v_new_snapshot jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_event_type text;
begin
  if tg_op = 'DELETE' then
    -- Explicit Workflow deletion has its workspace and referenced objects
    -- available. Cascades from EntityType/workspace deletion do not, so they
    -- are structural cleanup rather than user-level Workflow deletion.
    if not exists (select 1 from workspaces where id = old.workspace_id) then return old; end if;
    if not exists (select 1 from entity_types where workspace_id = old.workspace_id and id = old.trigger_entity_type_id) then return old; end if;
    v_old_snapshot := private.workflow_governance_snapshot(old.workspace_id, old.trigger_entity_type_id, old.trigger_type, old.action_config, old.actions);
    perform private.governance_audit_insert(old.workspace_id, 'workflow_deleted', 'workflow', old.id, old.name, null, null, null, null,
      jsonb_build_object('old', v_old_snapshot, 'new', null));
    return old;
  end if;

  if tg_op = 'INSERT' then
    v_new_snapshot := private.workflow_governance_snapshot(new.workspace_id, new.trigger_entity_type_id, new.trigger_type, new.action_config, new.actions);
    perform private.governance_audit_insert(new.workspace_id, 'workflow_created', 'workflow', new.id, new.name, null, null, null, null,
      jsonb_build_object('new', v_new_snapshot));
    return new;
  end if;

  if old.name is distinct from new.name then
    v_changes := v_changes || jsonb_build_object('name', jsonb_build_object('old', old.name, 'new', new.name));
  end if;
  if old.trigger_type is distinct from new.trigger_type or old.trigger_entity_type_id is distinct from new.trigger_entity_type_id
    or old.action_config is distinct from new.action_config or old.actions is distinct from new.actions then
    v_old_snapshot := private.workflow_governance_snapshot(old.workspace_id, old.trigger_entity_type_id, old.trigger_type, old.action_config, old.actions);
    v_new_snapshot := private.workflow_governance_snapshot(new.workspace_id, new.trigger_entity_type_id, new.trigger_type, new.action_config, new.actions);
    v_changes := v_changes || jsonb_build_object('configuration', jsonb_build_object('old', v_old_snapshot, 'new', v_new_snapshot));
  end if;
  if old.enabled is distinct from new.enabled then
    v_changes := v_changes || jsonb_build_object('enabled', jsonb_build_object('old', old.enabled, 'new', new.enabled));
  end if;

  if v_changes = '{}'::jsonb then return new; end if;
  if v_changes ? 'configuration' or v_changes ? 'name' then
    v_event_type := 'workflow_updated';
  elsif new.enabled then
    v_event_type := 'workflow_enabled';
  else
    v_event_type := 'workflow_disabled';
  end if;
  perform private.governance_audit_insert(new.workspace_id, v_event_type, 'workflow', new.id, new.name, null, null, null, null, v_changes);
  return new;
end;
$$;

revoke all on function private.capture_workflow_governance_change()
  from public, anon, authenticated, service_role;

drop trigger if exists workflows_governance_audit on workflows;
create trigger workflows_governance_audit
  after insert or update of name, enabled, trigger_type, trigger_entity_type_id, action_config, actions or delete on workflows
  for each row execute function private.capture_workflow_governance_change();
