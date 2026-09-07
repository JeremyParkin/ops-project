-- Phase 13.2B4b2: semantic governance history for primary-manager changes.
-- Team governance remains in 0126; manager changes use workspace_member
-- subjects keyed by the report user.

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
    'workspace_primary_manager_changed'
  ));

-- Preserve the complete 0125 authoritative body behind a private-in-practice
-- name. The public signature, return shape, validation order, and grants are
-- restored by the audited wrapper below.
alter function public.set_workspace_primary_manager_authorized(uuid, uuid, uuid)
  rename to set_workspace_primary_manager_authorized_pre_governance;

revoke all on function public.set_workspace_primary_manager_authorized_pre_governance(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.set_workspace_primary_manager_authorized(
  p_workspace_id uuid,
  p_report_user_id uuid,
  p_manager_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before_manager_id uuid;
  v_after_manager_id uuid;
  v_report_email text;
  v_before_manager_email text;
  v_after_manager_email text;
  v_operation text;
begin
  select relationship.manager_user_id
  into v_before_manager_id
  from workspace_reporting_relationships relationship
  where relationship.workspace_id = p_workspace_id
    and relationship.report_user_id = p_report_user_id
    and relationship.relationship_kind = 'primary_manager'
  for update;

  if v_before_manager_id is not null then
    select email::text into v_before_manager_email
    from auth.users
    where id = v_before_manager_id;
  end if;
  select email::text into v_report_email
  from auth.users
  where id = p_report_user_id;

  perform public.set_workspace_primary_manager_authorized_pre_governance(
    p_workspace_id, p_report_user_id, p_manager_user_id
  );

  select relationship.manager_user_id
  into v_after_manager_id
  from workspace_reporting_relationships relationship
  where relationship.workspace_id = p_workspace_id
    and relationship.report_user_id = p_report_user_id
    and relationship.relationship_kind = 'primary_manager';

  if v_after_manager_id is not null then
    select email::text into v_after_manager_email
    from auth.users
    where id = v_after_manager_id;
  end if;

  if v_before_manager_id is distinct from v_after_manager_id then
    v_operation := case
      when v_before_manager_id is null then 'set'
      when v_after_manager_id is null then 'clear'
      else 'replace'
    end;

    perform private.governance_audit_insert(
      p_workspace_id,
      'workspace_primary_manager_changed',
      'workspace_member',
      p_report_user_id,
      v_report_email,
      null,
      null,
      null,
      null,
      jsonb_build_object(
        'report_user_id', p_report_user_id,
        'report_email', v_report_email,
        'old_manager_id', v_before_manager_id,
        'old_manager_email', v_before_manager_email,
        'new_manager_id', v_after_manager_id,
        'new_manager_email', v_after_manager_email,
        'operation', v_operation
      )
    );
  end if;
end;
$$;

revoke all on function public.set_workspace_primary_manager_authorized(uuid, uuid, uuid)
  from public, anon;

grant execute on function public.set_workspace_primary_manager_authorized(uuid, uuid, uuid)
  to authenticated, service_role;
