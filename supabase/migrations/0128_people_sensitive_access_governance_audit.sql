-- Phase 13.2C1: semantic governance history for People-sensitive access
-- configuration. EntityType lifecycle metadata auditing remains separate.

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
    'people_sensitive_access_configured'
  ));

-- Preserve the complete current 0105 implementation behind an inaccessible
-- core. The public signature, validation order, return shape, and grants are
-- restored by the audited wrapper below.
alter function public.set_entity_type_people_sensitive_access_authorized(
  uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean
) rename to set_entity_type_people_sensitive_access_authorized_pre_governance;

revoke all on function public.set_entity_type_people_sensitive_access_authorized_pre_governance(
  uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean
) from public, anon, authenticated, service_role;

create function public.set_entity_type_people_sensitive_access_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_people_sensitive boolean,
  p_subject_person_field_id uuid,
  p_author_person_field_id uuid,
  p_subject_can_view boolean,
  p_manager_can_view boolean,
  p_author_can_view boolean
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
  v_author_name text;
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

  select subject_field.name, author_field.name
  into v_subject_name, v_author_name
  from entity_types entity_type
  left join field_definitions subject_field
    on subject_field.workspace_id = entity_type.workspace_id
    and subject_field.entity_type_id = entity_type.id
    and subject_field.id = entity_type.subject_person_field_id
  left join field_definitions author_field
    on author_field.workspace_id = entity_type.workspace_id
    and author_field.entity_type_id = entity_type.id
    and author_field.id = entity_type.author_person_field_id
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id
  for update of entity_type;

  select jsonb_build_object(
    'people_sensitive', entity_type.people_sensitive,
    'subject_person_field', jsonb_build_object(
      'id', entity_type.subject_person_field_id,
      'name', v_subject_name
    ),
    'author_person_field', jsonb_build_object(
      'id', entity_type.author_person_field_id,
      'name', v_author_name
    ),
    'subject_can_view', entity_type.subject_can_view,
    'manager_can_view', entity_type.manager_can_view,
    'author_can_view', entity_type.author_can_view
  )
  into v_before
  from entity_types entity_type
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  perform public.set_entity_type_people_sensitive_access_authorized_pre_governance(
    p_workspace_id,
    p_entity_type_id,
    p_people_sensitive,
    p_subject_person_field_id,
    p_author_person_field_id,
    p_subject_can_view,
    p_manager_can_view,
    p_author_can_view
  );

  select subject_field.name, author_field.name
  into v_subject_name, v_author_name
  from entity_types entity_type
  left join field_definitions subject_field
    on subject_field.workspace_id = entity_type.workspace_id
    and subject_field.entity_type_id = entity_type.id
    and subject_field.id = entity_type.subject_person_field_id
  left join field_definitions author_field
    on author_field.workspace_id = entity_type.workspace_id
    and author_field.entity_type_id = entity_type.id
    and author_field.id = entity_type.author_person_field_id
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  select jsonb_build_object(
    'people_sensitive', entity_type.people_sensitive,
    'subject_person_field', jsonb_build_object(
      'id', entity_type.subject_person_field_id,
      'name', v_subject_name
    ),
    'author_person_field', jsonb_build_object(
      'id', entity_type.author_person_field_id,
      'name', v_author_name
    ),
    'subject_can_view', entity_type.subject_can_view,
    'manager_can_view', entity_type.manager_can_view,
    'author_can_view', entity_type.author_can_view
  )
  into v_after
  from entity_types entity_type
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = p_entity_type_id;

  if v_before is distinct from v_after then
    perform private.governance_audit_insert(
      p_workspace_id,
      'people_sensitive_access_configured',
      'entity_type',
      p_entity_type_id,
      (select name from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id),
      null,
      null,
      null,
      null,
      jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;
end;
$$;

revoke all on function public.set_entity_type_people_sensitive_access_authorized(
  uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.set_entity_type_people_sensitive_access_authorized(
  uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean
) to authenticated, service_role;

comment on function public.set_entity_type_people_sensitive_access_authorized(
  uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean
)
  is 'Configures Phase 12.2 sensitive-access metadata and records one bounded Phase 13.2C1 governance event for each meaningful save. schema.manage, real-actor-only, blocked while impersonating. The pre-governance core preserves the complete validation and transition contract; generic EntityType metadata auditing remains separate.';
