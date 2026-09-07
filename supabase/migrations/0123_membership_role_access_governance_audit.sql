-- Phase 13.2B4a: semantic governance history for membership and role access.
-- Invitation subjects use the durable invitation UUID because no membership or
-- user identity is guaranteed to exist before acceptance. Role deletion emits
-- member-level reassignment events because each reassignment changes access.

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
    'process_template_restored', 'process_template_deleted',
    'workspace_member_invited', 'workspace_member_invitation_cancelled',
    'workspace_member_activated', 'workspace_member_deactivated', 'workspace_member_role_changed',
    'workspace_role_created', 'workspace_role_updated', 'workspace_role_deleted'
  )),
  add constraint governance_audit_events_subject_kind_check check (subject_kind in (
    'field', 'choice_option', 'entity_type', 'workflow', 'process_template',
    'workspace_invitation', 'workspace_member', 'workspace_role'
  )),
  add constraint governance_audit_events_subject_hierarchy_check check (
    (subject_kind = 'entity_type' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'field' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind = 'choice_option' and parent_entity_type_id is not null and parent_field_id is not null)
    or (subject_kind = 'workflow' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'process_template' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind in ('workspace_invitation', 'workspace_member', 'workspace_role')
      and parent_entity_type_id is null and parent_field_id is null)
  );

-- Preserve the complete current public implementations and their signatures.
alter function public.create_workspace_role_authorized(uuid, text, text, jsonb)
  rename to create_workspace_role_authorized_pre_governance;
alter function public.update_workspace_role_authorized(uuid, uuid, text, text, jsonb)
  rename to update_workspace_role_authorized_pre_governance;
alter function public.delete_workspace_role_with_reassignment_authorized(uuid, uuid, uuid)
  rename to delete_workspace_role_with_reassignment_authorized_pre_governance;
alter function public.set_workspace_member_role_authorized(uuid, uuid, uuid)
  rename to set_workspace_member_role_authorized_pre_governance;
alter function public.deactivate_workspace_member_authorized(uuid, uuid)
  rename to deactivate_workspace_member_authorized_pre_governance;
alter function public.reactivate_workspace_member_authorized(uuid, uuid)
  rename to reactivate_workspace_member_authorized_pre_governance;
alter function public.create_workspace_invitation_authorized(uuid, text, uuid, boolean)
  rename to create_workspace_invitation_authorized_pre_governance;
alter function public.cancel_workspace_invitation_authorized(uuid, uuid)
  rename to cancel_workspace_invitation_authorized_pre_governance;
alter function public.accept_workspace_invitation_authorized(uuid)
  rename to accept_workspace_invitation_authorized_pre_governance;

revoke all on function public.create_workspace_role_authorized_pre_governance(uuid, text, text, jsonb),
  public.update_workspace_role_authorized_pre_governance(uuid, uuid, text, text, jsonb),
  public.delete_workspace_role_with_reassignment_authorized_pre_governance(uuid, uuid, uuid),
  public.set_workspace_member_role_authorized_pre_governance(uuid, uuid, uuid),
  public.deactivate_workspace_member_authorized_pre_governance(uuid, uuid),
  public.reactivate_workspace_member_authorized_pre_governance(uuid, uuid),
  public.create_workspace_invitation_authorized_pre_governance(uuid, text, uuid, boolean),
  public.cancel_workspace_invitation_authorized_pre_governance(uuid, uuid),
  public.accept_workspace_invitation_authorized_pre_governance(uuid)
  from public, anon, authenticated, service_role;

create function public.create_workspace_invitation_authorized(
  p_workspace_id uuid, p_email text, p_role_id uuid, p_enqueue_email boolean default false
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_token uuid;
  v_invitation workspace_invitations%rowtype;
  v_role workspace_roles%rowtype;
begin
  v_token := public.create_workspace_invitation_authorized_pre_governance(p_workspace_id, p_email, p_role_id, p_enqueue_email);
  select * into v_invitation from workspace_invitations where workspace_id = p_workspace_id and token = v_token;
  select * into v_role from workspace_roles where workspace_id = v_invitation.workspace_id and id = v_invitation.role_id;
  perform private.governance_audit_insert(
    p_workspace_id, 'workspace_member_invited', 'workspace_invitation', v_invitation.id,
    v_invitation.email, null, null, null, null,
    jsonb_build_object('email', v_invitation.email, 'role_id', v_role.id, 'role_name', v_role.name, 'status', v_invitation.status)
  );
  return v_token;
end;
$$;

create function public.cancel_workspace_invitation_authorized(p_workspace_id uuid, p_invitation_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_invitation workspace_invitations%rowtype;
  v_role workspace_roles%rowtype;
begin
  select * into v_invitation from workspace_invitations where workspace_id = p_workspace_id and id = p_invitation_id;
  if not found then
    perform public.cancel_workspace_invitation_authorized_pre_governance(p_workspace_id, p_invitation_id);
    return;
  end if;
  select * into v_role from workspace_roles where workspace_id = v_invitation.workspace_id and id = v_invitation.role_id;
  perform public.cancel_workspace_invitation_authorized_pre_governance(p_workspace_id, p_invitation_id);
  perform private.governance_audit_insert(
    p_workspace_id, 'workspace_member_invitation_cancelled', 'workspace_invitation', v_invitation.id,
    v_invitation.email, null, null, null, null,
    jsonb_build_object('email', v_invitation.email, 'role_id', v_role.id, 'role_name', v_role.name, 'previous_status', v_invitation.status, 'status', 'cancelled')
  );
end;
$$;

create function public.accept_workspace_invitation_authorized(p_token uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_invitation workspace_invitations%rowtype;
  v_before workspace_memberships%rowtype;
  v_after workspace_memberships%rowtype;
  v_old_role workspace_roles%rowtype;
  v_new_role workspace_roles%rowtype;
  v_result uuid;
  v_had_membership boolean := false;
begin
  select * into v_invitation from workspace_invitations where token = p_token;
  if not found then
    return public.accept_workspace_invitation_authorized_pre_governance(p_token);
  end if;
  select * into v_before from workspace_memberships where workspace_id = v_invitation.workspace_id and user_id = auth.uid();
  if found then
    v_had_membership := true;
    select * into v_old_role from workspace_roles where workspace_id = v_before.workspace_id and id = v_before.role_id;
  end if;
  v_result := public.accept_workspace_invitation_authorized_pre_governance(p_token);
  select * into v_after from workspace_memberships where workspace_id = v_invitation.workspace_id and user_id = auth.uid();
  select * into v_new_role from workspace_roles where workspace_id = v_after.workspace_id and id = v_after.role_id;
  if v_invitation.status <> 'accepted'
     and (not v_had_membership or v_before.deactivated_at is not null or v_before.role_id is distinct from v_after.role_id) then
    perform private.governance_audit_insert(
      v_invitation.workspace_id, 'workspace_member_activated', 'workspace_member', auth.uid(),
      (select email::text from auth.users where id = auth.uid()), null, null, null, null,
      jsonb_build_object(
        'invitation_id', v_invitation.id, 'activation_source', 'invitation',
        'previous_role_id', v_old_role.id, 'previous_role_name', v_old_role.name,
        'role_id', v_new_role.id, 'role_name', v_new_role.name,
        'previously_deactivated', coalesce(v_before.deactivated_at is not null, false)
      )
    );
  end if;
  return v_result;
end;
$$;

create function public.deactivate_workspace_member_authorized(p_workspace_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_member workspace_memberships%rowtype;
  v_role workspace_roles%rowtype;
  v_email text;
begin
  select * into v_member from workspace_memberships where workspace_id = p_workspace_id and user_id = p_user_id and deactivated_at is null;
  if found then
    select * into v_role from workspace_roles where workspace_id = p_workspace_id and id = v_member.role_id;
    select email::text into v_email from auth.users where id = p_user_id;
  end if;
  perform public.deactivate_workspace_member_authorized_pre_governance(p_workspace_id, p_user_id);
  perform private.governance_audit_insert(
    p_workspace_id, 'workspace_member_deactivated', 'workspace_member', p_user_id,
    v_email, null, null, null, null,
    jsonb_build_object('email', v_email, 'role_id', v_role.id, 'role_name', v_role.name, 'previously_active', true)
  );
end;
$$;

create function public.reactivate_workspace_member_authorized(p_workspace_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_member workspace_memberships%rowtype;
  v_role workspace_roles%rowtype;
  v_email text;
begin
  select * into v_member from workspace_memberships where workspace_id = p_workspace_id and user_id = p_user_id and deactivated_at is not null;
  if found then
    select * into v_role from workspace_roles where workspace_id = p_workspace_id and id = v_member.role_id;
    select email::text into v_email from auth.users where id = p_user_id;
  end if;
  perform public.reactivate_workspace_member_authorized_pre_governance(p_workspace_id, p_user_id);
  perform private.governance_audit_insert(
    p_workspace_id, 'workspace_member_activated', 'workspace_member', p_user_id,
    v_email, null, null, null, null,
    jsonb_build_object('email', v_email, 'activation_source', 'administration', 'role_id', v_role.id, 'role_name', v_role.name, 'previously_deactivated', true)
  );
end;
$$;

create function public.set_workspace_member_role_authorized(p_workspace_id uuid, p_user_id uuid, p_role_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before workspace_memberships%rowtype;
  v_old_role workspace_roles%rowtype;
  v_new_role workspace_roles%rowtype;
  v_email text;
begin
  select * into v_before from workspace_memberships where workspace_id = p_workspace_id and user_id = p_user_id;
  if found then
    select * into v_old_role from workspace_roles where workspace_id = p_workspace_id and id = v_before.role_id;
    select email::text into v_email from auth.users where id = p_user_id;
  end if;
  select * into v_new_role from workspace_roles where workspace_id = p_workspace_id and id = p_role_id;
  perform public.set_workspace_member_role_authorized_pre_governance(p_workspace_id, p_user_id, p_role_id);
  if v_before.role_id is distinct from p_role_id then
    perform private.governance_audit_insert(
      p_workspace_id, 'workspace_member_role_changed', 'workspace_member', p_user_id,
      v_email, null, null, null, null,
      jsonb_build_object('email', v_email, 'old_role_id', v_old_role.id, 'old_role_name', v_old_role.name, 'new_role_id', v_new_role.id, 'new_role_name', v_new_role.name, 'cause', 'direct_assignment')
    );
  end if;
end;
$$;

create function public.create_workspace_role_authorized(p_workspace_id uuid, p_name text, p_description text, p_capabilities jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role_id uuid;
  v_role workspace_roles%rowtype;
begin
  v_role_id := public.create_workspace_role_authorized_pre_governance(p_workspace_id, p_name, p_description, p_capabilities);
  select * into v_role from workspace_roles where workspace_id = p_workspace_id and id = v_role_id;
  perform private.governance_audit_insert(
    p_workspace_id, 'workspace_role_created', 'workspace_role', v_role.id, v_role.name, null, null, null, null,
    jsonb_build_object('name', v_role.name, 'description', v_role.description, 'is_builtin', v_role.is_builtin,
      'capabilities', coalesce((select jsonb_agg(capability order by capability) from workspace_role_capabilities where workspace_id = v_role.workspace_id and role_id = v_role.id), '[]'::jsonb))
  );
  return v_role_id;
end;
$$;

create function public.update_workspace_role_authorized(p_workspace_id uuid, p_role_id uuid, p_name text, p_description text, p_capabilities jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before workspace_roles%rowtype;
  v_after workspace_roles%rowtype;
  v_before_caps jsonb;
  v_after_caps jsonb;
begin
  select * into v_before from workspace_roles where workspace_id = p_workspace_id and id = p_role_id;
  select coalesce(jsonb_agg(capability order by capability), '[]'::jsonb) into v_before_caps from workspace_role_capabilities where workspace_id = p_workspace_id and role_id = p_role_id;
  perform public.update_workspace_role_authorized_pre_governance(p_workspace_id, p_role_id, p_name, p_description, p_capabilities);
  select * into v_after from workspace_roles where workspace_id = p_workspace_id and id = p_role_id;
  select coalesce(jsonb_agg(capability order by capability), '[]'::jsonb) into v_after_caps from workspace_role_capabilities where workspace_id = p_workspace_id and role_id = p_role_id;
  if v_before.name is distinct from v_after.name or v_before.description is distinct from v_after.description or v_before_caps is distinct from v_after_caps then
    perform private.governance_audit_insert(
      p_workspace_id, 'workspace_role_updated', 'workspace_role', p_role_id, v_after.name, null, null, null, null,
      jsonb_build_object('old_name', v_before.name, 'new_name', v_after.name, 'old_description', v_before.description, 'new_description', v_after.description, 'old_capabilities', v_before_caps, 'new_capabilities', v_after_caps)
    );
  end if;
end;
$$;

create function public.delete_workspace_role_with_reassignment_authorized(p_workspace_id uuid, p_role_id uuid, p_replacement_role_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role workspace_roles%rowtype;
  v_replacement workspace_roles%rowtype;
  v_caps jsonb;
  v_count integer;
  v_operation_id uuid := gen_random_uuid();
  v_member record;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  select * into v_role from workspace_roles where workspace_id = p_workspace_id and id = p_role_id;
  select * into v_replacement from workspace_roles where workspace_id = p_workspace_id and id = p_replacement_role_id;
  select coalesce(jsonb_agg(capability order by capability), '[]'::jsonb) into v_caps from workspace_role_capabilities where workspace_id = p_workspace_id and role_id = p_role_id;
  select count(*) into v_count from workspace_memberships where workspace_id = p_workspace_id and role_id = p_role_id;

  -- Let the preserved implementation own all invalid-input errors. In
  -- particular, never construct an audit row with a null role subject.
  if v_role.id is null or v_replacement.id is null or v_role.id = v_replacement.id then
    perform public.delete_workspace_role_with_reassignment_authorized_pre_governance(p_workspace_id, p_role_id, p_replacement_role_id);
    return;
  end if;

  perform private.governance_audit_insert(
    p_workspace_id, 'workspace_role_deleted', 'workspace_role', p_role_id, v_role.name, null, null, null, null,
    jsonb_build_object('name', v_role.name, 'description', v_role.description, 'is_builtin', v_role.is_builtin, 'capabilities', v_caps,
      'replacement_role_id', v_replacement.id, 'replacement_role_name', v_replacement.name, 'affected_member_count', v_count, 'operation_id', v_operation_id)
  );
  for v_member in select m.user_id, u.email::text as email from workspace_memberships m left join auth.users u on u.id = m.user_id where m.workspace_id = p_workspace_id and m.role_id = p_role_id loop
    perform private.governance_audit_insert(
      p_workspace_id, 'workspace_member_role_changed', 'workspace_member', v_member.user_id, v_member.email, null, null, null, null,
      jsonb_build_object('old_role_id', p_role_id, 'old_role_name', v_role.name, 'new_role_id', v_replacement.id, 'new_role_name', v_replacement.name, 'cause', 'role_deleted', 'deleted_role_id', p_role_id, 'operation_id', v_operation_id)
    );
  end loop;
  perform public.delete_workspace_role_with_reassignment_authorized_pre_governance(p_workspace_id, p_role_id, p_replacement_role_id);
end;
$$;

grant execute on function public.create_workspace_role_authorized(uuid, text, text, jsonb),
  public.update_workspace_role_authorized(uuid, uuid, text, text, jsonb),
  public.delete_workspace_role_with_reassignment_authorized(uuid, uuid, uuid),
  public.set_workspace_member_role_authorized(uuid, uuid, uuid),
  public.deactivate_workspace_member_authorized(uuid, uuid),
  public.reactivate_workspace_member_authorized(uuid, uuid),
  public.create_workspace_invitation_authorized(uuid, text, uuid, boolean),
  public.cancel_workspace_invitation_authorized(uuid, uuid),
  public.accept_workspace_invitation_authorized(uuid)
  to authenticated, service_role;
