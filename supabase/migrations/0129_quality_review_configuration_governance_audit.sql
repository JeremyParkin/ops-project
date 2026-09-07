-- Phase 13.2C2: semantic governance history for Quality Review configuration.
-- Runtime review lifecycle remains in workspace_events.

alter table governance_audit_events
  drop constraint if exists governance_audit_events_event_type_check;

alter table governance_audit_events
  add constraint governance_audit_events_event_type_check check (event_type in (
    'field_created', 'field_updated', 'field_archived', 'field_restored', 'field_deleted',
    'choice_option_created', 'choice_option_updated', 'choice_option_archived', 'choice_option_restored',
    'entity_type_created', 'entity_type_updated', 'entity_type_archived', 'entity_type_restored', 'entity_type_deleted',
    'workflow_created', 'workflow_updated', 'workflow_enabled', 'workflow_disabled', 'workflow_deleted',
    'process_template_created', 'process_template_updated', 'process_template_archived',
    'process_template_restored', 'process_template_deleted',
    'workspace_member_invited', 'workspace_member_invitation_cancelled',
    'workspace_member_activated', 'workspace_member_deactivated', 'workspace_member_role_changed',
    'workspace_role_created', 'workspace_role_updated', 'workspace_role_deleted',
    'workspace_team_created', 'workspace_team_updated', 'workspace_team_archived',
    'workspace_team_restored', 'workspace_team_deleted', 'workspace_team_member_added',
    'workspace_team_member_removed', 'workspace_team_lead_added', 'workspace_team_lead_removed',
    'workspace_primary_manager_changed',
    'people_sensitive_access_configured',
    'quality_review_lifecycle_configured',
    'quality_review_presentation_configured'
  ));

alter function public.set_entity_type_quality_review_lifecycle_authorized(
  uuid, uuid, boolean, uuid, uuid, uuid
) rename to set_entity_type_quality_review_lifecycle_authorized_pre_governance;

revoke all on function public.set_entity_type_quality_review_lifecycle_authorized_pre_governance(
  uuid, uuid, boolean, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

alter function public.set_entity_type_quality_review_presentation_authorized(
  uuid, uuid, uuid, uuid
) rename to set_entity_type_quality_review_presentation_authorized_pre_governance;

revoke all on function public.set_entity_type_quality_review_presentation_authorized_pre_governance(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create function public.set_entity_type_quality_review_lifecycle_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_quality_review boolean,
  p_status_field_id uuid,
  p_draft_option_id uuid,
  p_finalized_option_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_status_field_name text;
  v_draft_label text;
  v_finalized_label text;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  select status_field.name,
         draft_option.label,
         finalized_option.label
  into v_status_field_name, v_draft_label, v_finalized_label
  from entity_types entity_type
  left join field_definitions status_field
    on status_field.workspace_id = entity_type.workspace_id
    and status_field.entity_type_id = entity_type.id
    and status_field.id = entity_type.quality_review_status_field_id
  left join field_choice_options draft_option
    on draft_option.workspace_id = entity_type.workspace_id
    and draft_option.field_definition_id = entity_type.quality_review_status_field_id
    and draft_option.id = entity_type.quality_review_draft_option_id
  left join field_choice_options finalized_option
    on finalized_option.workspace_id = entity_type.workspace_id
    and finalized_option.field_definition_id = entity_type.quality_review_status_field_id
    and finalized_option.id = entity_type.quality_review_finalized_option_id
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id
  for update of entity_type;

  select jsonb_build_object(
    'quality_review', entity_type.quality_review,
    'status_field', jsonb_build_object(
      'id', entity_type.quality_review_status_field_id,
      'name', v_status_field_name
    ),
    'draft_option', jsonb_build_object(
      'id', entity_type.quality_review_draft_option_id,
      'label', v_draft_label
    ),
    'finalized_option', jsonb_build_object(
      'id', entity_type.quality_review_finalized_option_id,
      'label', v_finalized_label
    )
  )
  into v_before
  from entity_types entity_type
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  perform public.set_entity_type_quality_review_lifecycle_authorized_pre_governance(
    p_workspace_id, p_entity_type_id, p_quality_review, p_status_field_id,
    p_draft_option_id, p_finalized_option_id
  );

  select status_field.name,
         draft_option.label,
         finalized_option.label
  into v_status_field_name, v_draft_label, v_finalized_label
  from entity_types entity_type
  left join field_definitions status_field
    on status_field.workspace_id = entity_type.workspace_id
    and status_field.entity_type_id = entity_type.id
    and status_field.id = entity_type.quality_review_status_field_id
  left join field_choice_options draft_option
    on draft_option.workspace_id = entity_type.workspace_id
    and draft_option.field_definition_id = entity_type.quality_review_status_field_id
    and draft_option.id = entity_type.quality_review_draft_option_id
  left join field_choice_options finalized_option
    on finalized_option.workspace_id = entity_type.workspace_id
    and finalized_option.field_definition_id = entity_type.quality_review_status_field_id
    and finalized_option.id = entity_type.quality_review_finalized_option_id
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  select jsonb_build_object(
    'quality_review', entity_type.quality_review,
    'status_field', jsonb_build_object(
      'id', entity_type.quality_review_status_field_id,
      'name', v_status_field_name
    ),
    'draft_option', jsonb_build_object(
      'id', entity_type.quality_review_draft_option_id,
      'label', v_draft_label
    ),
    'finalized_option', jsonb_build_object(
      'id', entity_type.quality_review_finalized_option_id,
      'label', v_finalized_label
    )
  )
  into v_after
  from entity_types entity_type
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  if v_before is distinct from v_after then
    perform private.governance_audit_insert(
      p_workspace_id, 'quality_review_lifecycle_configured', 'entity_type',
      p_entity_type_id,
      (select name from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id),
      null, null, null, null,
      jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;
end;
$$;

create function public.set_entity_type_quality_review_presentation_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_date_field_id uuid,
  p_result_field_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_date_field_name text;
  v_result_field_name text;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  select date_field.name, result_field.name
  into v_date_field_name, v_result_field_name
  from entity_types entity_type
  left join field_definitions date_field
    on date_field.workspace_id = entity_type.workspace_id
    and date_field.entity_type_id = entity_type.id
    and date_field.id = entity_type.quality_review_date_field_id
  left join field_definitions result_field
    on result_field.workspace_id = entity_type.workspace_id
    and result_field.entity_type_id = entity_type.id
    and result_field.id = entity_type.quality_review_result_field_id
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id
  for update of entity_type;

  select jsonb_build_object(
    'review_date_field', jsonb_build_object(
      'id', entity_type.quality_review_date_field_id,
      'name', v_date_field_name
    ),
    'overall_result_field', jsonb_build_object(
      'id', entity_type.quality_review_result_field_id,
      'name', v_result_field_name
    )
  )
  into v_before
  from entity_types entity_type
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  perform public.set_entity_type_quality_review_presentation_authorized_pre_governance(
    p_workspace_id, p_entity_type_id, p_date_field_id, p_result_field_id
  );

  select date_field.name, result_field.name
  into v_date_field_name, v_result_field_name
  from entity_types entity_type
  left join field_definitions date_field
    on date_field.workspace_id = entity_type.workspace_id
    and date_field.entity_type_id = entity_type.id
    and date_field.id = entity_type.quality_review_date_field_id
  left join field_definitions result_field
    on result_field.workspace_id = entity_type.workspace_id
    and result_field.entity_type_id = entity_type.id
    and result_field.id = entity_type.quality_review_result_field_id
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  select jsonb_build_object(
    'review_date_field', jsonb_build_object(
      'id', entity_type.quality_review_date_field_id,
      'name', v_date_field_name
    ),
    'overall_result_field', jsonb_build_object(
      'id', entity_type.quality_review_result_field_id,
      'name', v_result_field_name
    )
  )
  into v_after
  from entity_types entity_type
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  if v_before is distinct from v_after then
    perform private.governance_audit_insert(
      p_workspace_id, 'quality_review_presentation_configured', 'entity_type',
      p_entity_type_id,
      (select name from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id),
      null, null, null, null,
      jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;
end;
$$;

revoke all on function public.set_entity_type_quality_review_lifecycle_authorized(
  uuid, uuid, boolean, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.set_entity_type_quality_review_lifecycle_authorized(
  uuid, uuid, boolean, uuid, uuid, uuid
) to authenticated, service_role;

revoke all on function public.set_entity_type_quality_review_presentation_authorized(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.set_entity_type_quality_review_presentation_authorized(
  uuid, uuid, uuid, uuid
) to authenticated, service_role;
