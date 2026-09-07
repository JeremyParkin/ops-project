-- Phase 13.2B3b: semantic governance history for Process Templates.
-- Preserve the existing graph-save implementation by placing capture at the
-- outer authorized RPC boundary. Node and edge rows are implementation detail
-- of one user-level template save and are not audited independently.

alter table governance_audit_events
  drop constraint if exists governance_audit_events_event_type_check,
  drop constraint if exists governance_audit_events_subject_kind_check,
  drop constraint if exists governance_audit_events_subject_hierarchy_check;

alter table governance_audit_events
  add constraint governance_audit_events_event_type_check check (event_type in (
    'field_created', 'field_updated', 'field_archived', 'field_restored', 'field_deleted',
    'choice_option_created', 'choice_option_updated', 'choice_option_archived', 'choice_option_restored',
    'entity_type_created', 'entity_type_updated', 'entity_type_archived', 'entity_type_restored', 'entity_type_deleted',
    'workflow_created', 'workflow_updated', 'workflow_enabled', 'workflow_disabled', 'workflow_deleted',
    'process_template_created', 'process_template_updated', 'process_template_archived',
    'process_template_restored', 'process_template_deleted'
  )),
  add constraint governance_audit_events_subject_kind_check check (subject_kind in (
    'field', 'choice_option', 'entity_type', 'workflow', 'process_template'
  )),
  add constraint governance_audit_events_subject_hierarchy_check check (
    (subject_kind = 'entity_type' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'field' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind = 'choice_option' and parent_entity_type_id is not null and parent_field_id is not null)
    or (subject_kind = 'workflow' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'process_template' and parent_entity_type_id is not null and parent_field_id is null)
  );

create or replace function private.process_template_governance_snapshot(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', template.id,
    'name', template.name,
    'description', template.description,
    'applies_to_entity_type', jsonb_build_object(
      'id', template.applies_to_entity_type_id,
      'name', entity_type.name
    ),
    'archived_at', template.archived_at,
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', node.id,
        'name', node.name,
        'node_type', node.node_type,
        'position', node.position,
        'assignee_user_id', node.assignee_user_id,
        'config', node.config
      ) order by node.position, node.id)
      from process_nodes node
      where node.workspace_id = template.workspace_id
        and node.process_template_id = template.id
    ), '[]'::jsonb),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source_node_id', edge.source_node_id,
        'target_node_id', edge.target_node_id,
        'is_default', edge.is_default,
        'is_parallel', edge.is_parallel,
        'condition_config', edge.condition_config,
        'approval_outcome_id', edge.approval_outcome_id,
        'approval_outcome_label', edge.approval_outcome_label
      ) order by edge.source_node_id, edge.target_node_id, edge.id)
      from process_edges edge
      where edge.workspace_id = template.workspace_id
        and edge.process_template_id = template.id
    ), '[]'::jsonb)
  )
  from process_templates template
  join entity_types entity_type
    on entity_type.workspace_id = template.workspace_id
   and entity_type.id = template.applies_to_entity_type_id
  where template.workspace_id = p_workspace_id
    and template.id = p_process_template_id;
$$;

revoke all on function private.process_template_governance_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Preserve the complete current implementation and its established internal
-- function chain. These renamed functions remain private implementation
-- details; the replacement wrappers below retain the public signatures.
alter function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb)
  rename to save_process_template_authorized_pre_governance;
alter function public.archive_process_template_authorized(uuid, uuid)
  rename to archive_process_template_authorized_pre_governance;
alter function public.restore_process_template_authorized(uuid, uuid)
  rename to restore_process_template_authorized_pre_governance;
alter function public.delete_process_template_if_safe_authorized(uuid, uuid)
  rename to delete_process_template_if_safe_authorized_pre_governance;

revoke all on function public.save_process_template_authorized_pre_governance(uuid, uuid, text, text, uuid, jsonb),
  public.archive_process_template_authorized_pre_governance(uuid, uuid),
  public.restore_process_template_authorized_pre_governance(uuid, uuid),
  public.delete_process_template_if_safe_authorized_pre_governance(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.save_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_name text,
  p_description text,
  p_applies_to_entity_type_id uuid,
  p_steps jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_event_type text;
  v_subject_name text;
  v_parent_entity_type_id uuid;
  v_parent_entity_type_name text;
begin
  if p_process_template_id is not null then
    v_before := private.process_template_governance_snapshot(p_workspace_id, p_process_template_id);
  end if;

  v_template_id := public.save_process_template_authorized_pre_governance(
    p_workspace_id, p_process_template_id, p_name, p_description,
    p_applies_to_entity_type_id, p_steps
  );

  v_after := private.process_template_governance_snapshot(p_workspace_id, v_template_id);
  if v_after is null then
    raise exception 'Process template governance snapshot was not created';
  end if;

  select name, applies_to_entity_type_id
  into v_subject_name, v_parent_entity_type_id
  from process_templates
  where workspace_id = p_workspace_id and id = v_template_id;
  select name into v_parent_entity_type_name
  from entity_types
  where workspace_id = p_workspace_id and id = v_parent_entity_type_id;

  if v_before is null then
    v_event_type := 'process_template_created';
    perform private.governance_audit_insert(
      p_workspace_id, v_event_type, 'process_template', v_template_id,
      v_subject_name, null, null, v_parent_entity_type_id,
      v_parent_entity_type_name, jsonb_build_object('new', v_after)
    );
  elsif v_before is distinct from v_after then
    perform private.governance_audit_insert(
      p_workspace_id, 'process_template_updated', 'process_template', v_template_id,
      v_subject_name, null, null, v_parent_entity_type_id,
      v_parent_entity_type_name, jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;

  return v_template_id;
end;
$$;

create function public.archive_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_subject_name text;
  v_parent_entity_type_id uuid;
  v_parent_entity_type_name text;
begin
  v_before := private.process_template_governance_snapshot(p_workspace_id, p_process_template_id);
  perform public.archive_process_template_authorized_pre_governance(p_workspace_id, p_process_template_id);
  v_after := private.process_template_governance_snapshot(p_workspace_id, p_process_template_id);

  if v_before is distinct from v_after and (v_before ->> 'archived_at') is null
    and (v_after ->> 'archived_at') is not null then
    select name, applies_to_entity_type_id into v_subject_name, v_parent_entity_type_id
    from process_templates where workspace_id = p_workspace_id and id = p_process_template_id;
    select name into v_parent_entity_type_name from entity_types
    where workspace_id = p_workspace_id and id = v_parent_entity_type_id;
    perform private.governance_audit_insert(
      p_workspace_id, 'process_template_archived', 'process_template',
      p_process_template_id, v_subject_name, null, null, v_parent_entity_type_id,
      v_parent_entity_type_name, jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;
end;
$$;

create function public.restore_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_subject_name text;
  v_parent_entity_type_id uuid;
  v_parent_entity_type_name text;
begin
  v_before := private.process_template_governance_snapshot(p_workspace_id, p_process_template_id);
  perform public.restore_process_template_authorized_pre_governance(p_workspace_id, p_process_template_id);
  v_after := private.process_template_governance_snapshot(p_workspace_id, p_process_template_id);

  if v_before is distinct from v_after and (v_before ->> 'archived_at') is not null
    and (v_after ->> 'archived_at') is null then
    select name, applies_to_entity_type_id into v_subject_name, v_parent_entity_type_id
    from process_templates where workspace_id = p_workspace_id and id = p_process_template_id;
    select name into v_parent_entity_type_name from entity_types
    where workspace_id = p_workspace_id and id = v_parent_entity_type_id;
    perform private.governance_audit_insert(
      p_workspace_id, 'process_template_restored', 'process_template',
      p_process_template_id, v_subject_name, null, null, v_parent_entity_type_id,
      v_parent_entity_type_name, jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;
end;
$$;

create function public.delete_process_template_if_safe_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns table (
  deleted boolean,
  run_count integer,
  workflow_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_subject_name text;
  v_parent_entity_type_id uuid;
  v_parent_entity_type_name text;
  v_result record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');
  v_before := private.process_template_governance_snapshot(p_workspace_id, p_process_template_id);

  select * into v_result
  from public.delete_process_template_if_safe_authorized_pre_governance(
    p_workspace_id, p_process_template_id
  );

  if v_result.deleted and v_before is not null then
    v_subject_name := v_before ->> 'name';
    v_parent_entity_type_id := (v_before -> 'applies_to_entity_type' ->> 'id')::uuid;
    v_parent_entity_type_name := v_before -> 'applies_to_entity_type' ->> 'name';
    perform private.governance_audit_insert(
      p_workspace_id, 'process_template_deleted', 'process_template',
      p_process_template_id, v_subject_name, null, null, v_parent_entity_type_id,
      v_parent_entity_type_name, jsonb_build_object('old', v_before)
    );
  end if;

  return query select v_result.deleted, v_result.run_count, v_result.workflow_count;
end;
$$;

revoke all on function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb),
  public.archive_process_template_authorized(uuid, uuid),
  public.restore_process_template_authorized(uuid, uuid),
  public.delete_process_template_if_safe_authorized(uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb),
  public.archive_process_template_authorized(uuid, uuid),
  public.restore_process_template_authorized(uuid, uuid),
  public.delete_process_template_if_safe_authorized(uuid, uuid)
  to authenticated, service_role;

comment on function public.delete_process_template_if_safe_authorized(uuid, uuid)
  is 'Automation-manage-gated safe deletion for process templates. Blocks deletion when process runs or workflow start_process actions reference the template and records one semantic governance event on success.';
