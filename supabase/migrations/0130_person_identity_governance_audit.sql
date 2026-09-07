-- Phase 13.2D1: Person designation governance and durable identity-link
-- snapshots. Person link/unlink remains a workspace_events event family;
-- this migration does not duplicate those operations in governance history.

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
    'workspace_role_created', 'workspace_role_updated', 'workspace_role_deleted',
    'workspace_team_created', 'workspace_team_updated', 'workspace_team_archived',
    'workspace_team_restored', 'workspace_team_deleted', 'workspace_team_member_added',
    'workspace_team_member_removed', 'workspace_team_lead_added', 'workspace_team_lead_removed',
    'workspace_primary_manager_changed',
    'people_sensitive_access_configured',
    'quality_review_lifecycle_configured', 'quality_review_presentation_configured',
    'person_entity_type_changed'
  )),
  add constraint governance_audit_events_subject_kind_check check (subject_kind in (
    'field', 'choice_option', 'entity_type', 'workflow', 'process_template',
    'workspace_invitation', 'workspace_member', 'workspace_role', 'workspace_team',
    'workspace'
  )),
  add constraint governance_audit_events_subject_hierarchy_check check (
    (subject_kind = 'entity_type' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'field' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind = 'choice_option' and parent_entity_type_id is not null and parent_field_id is not null)
    or (subject_kind = 'workflow' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'process_template' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind in ('workspace_invitation', 'workspace_member', 'workspace_role', 'workspace_team', 'workspace')
      and parent_entity_type_id is null and parent_field_id is null)
  );

-- Preserve the complete latest designation validation boundary from 0100/0099
-- behind an inaccessible core. The wrapper adds only transactional history.
alter function public.set_person_entity_type_authorized(uuid, uuid)
  rename to set_person_entity_type_authorized_pre_governance;

revoke all on function public.set_person_entity_type_authorized_pre_governance(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.set_person_entity_type_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workspace_name text;
  v_before_id uuid;
  v_before_name text;
  v_after_id uuid;
  v_after_name text;
  v_operation text;
begin
  select workspace.name, workspace.person_entity_type_id
  into v_workspace_name, v_before_id
  from workspaces workspace
  where workspace.id = p_workspace_id
  for update;

  if v_before_id is not null then
    select entity_type.name into v_before_name
    from entity_types entity_type
    where entity_type.workspace_id = p_workspace_id
      and entity_type.id = v_before_id;
  end if;

  perform public.set_person_entity_type_authorized_pre_governance(
    p_workspace_id, p_entity_type_id
  );

  select workspace.person_entity_type_id into v_after_id
  from workspaces workspace
  where workspace.id = p_workspace_id;

  if v_after_id is not null then
    select entity_type.name into v_after_name
    from entity_types entity_type
    where entity_type.workspace_id = p_workspace_id
      and entity_type.id = v_after_id;
  end if;

  if v_before_id is distinct from v_after_id then
    v_operation := case
      when v_before_id is null then 'designate'
      when v_after_id is null then 'clear'
      else 'replace'
    end;

    perform private.governance_audit_insert(
      p_workspace_id,
      'person_entity_type_changed',
      'workspace',
      p_workspace_id,
      coalesce(v_workspace_name, 'Workspace'),
      null,
      null,
      null,
      null,
      jsonb_build_object(
        'workspace_id', p_workspace_id,
        'operation', v_operation,
        'old_person_entity_type', case when v_before_id is null then null else jsonb_build_object(
          'id', v_before_id, 'name', v_before_name
        ) end,
        'new_person_entity_type', case when v_after_id is null then null else jsonb_build_object(
          'id', v_after_id, 'name', v_after_name
        ) end
      )
    );
  end if;
end;
$$;

revoke all on function public.set_person_entity_type_authorized(uuid, uuid)
  from public, anon;
grant execute on function public.set_person_entity_type_authorized(uuid, uuid)
  to authenticated, service_role;

-- The existing link/unlink events are the canonical history for these
-- operations. Copy the latest 0099 bodies into inaccessible cores, removing
-- only their best-effort event blocks; the public wrappers below write the
-- same event types with additive frozen identity snapshots and no swallowed
-- errors.
alter function public.set_person_link_authorized(uuid, uuid, uuid)
  rename to set_person_link_authorized_pre_governance;
alter function public.remove_person_link_authorized(uuid, uuid)
  rename to remove_person_link_authorized_pre_governance;

revoke all on function public.set_person_link_authorized_pre_governance(uuid, uuid, uuid),
  public.remove_person_link_authorized_pre_governance(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.set_person_link_authorized_pre_governance(
  p_workspace_id uuid,
  p_entity_record_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_person_entity_type_id uuid;
  v_record entity_records%rowtype;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(p_workspace_id, 'workspace.manage_members');

  select workspace.person_entity_type_id into v_person_entity_type_id
  from workspaces workspace
  where workspace.id = p_workspace_id;
  if v_person_entity_type_id is null then
    raise exception 'No Person type is designated for this workspace';
  end if;

  select * into v_record
  from entity_records
  where workspace_id = p_workspace_id and id = p_entity_record_id;
  if not found then raise exception 'Record not found'; end if;
  if v_record.entity_type_id <> v_person_entity_type_id then
    raise exception 'This record is not a Person record';
  end if;
  if v_record.archived_at is not null then
    raise exception 'Cannot link an archived record';
  end if;

  if not exists (
    select 1 from workspace_memberships
    where workspace_id = p_workspace_id and user_id = p_user_id and deactivated_at is null
  ) then
    raise exception 'Target is not a current member of this workspace';
  end if;
  if exists (
    select 1 from entity_record_person_links
    where workspace_id = p_workspace_id and entity_record_id = p_entity_record_id
  ) then
    raise exception 'This record is already linked to a workspace member';
  end if;
  if exists (
    select 1 from entity_record_person_links
    where workspace_id = p_workspace_id and user_id = p_user_id
  ) then
    raise exception 'This workspace member is already linked to a record';
  end if;

  insert into entity_record_person_links (
    workspace_id, entity_type_id, entity_record_id, user_id, linked_by_user_id
  ) values (
    p_workspace_id, v_person_entity_type_id, p_entity_record_id, p_user_id, auth.uid()
  );
end;
$$;

create or replace function public.remove_person_link_authorized_pre_governance(
  p_workspace_id uuid,
  p_entity_record_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link entity_record_person_links%rowtype;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(p_workspace_id, 'workspace.manage_members');

  select * into v_link
  from entity_record_person_links
  where workspace_id = p_workspace_id and entity_record_id = p_entity_record_id;
  if not found then raise exception 'This record is not currently linked'; end if;

  delete from entity_record_person_links
  where workspace_id = p_workspace_id and entity_record_id = p_entity_record_id;
end;
$$;

create function public.set_person_link_authorized(
  p_workspace_id uuid,
  p_entity_record_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_person_entity_type_id uuid;
  v_person_entity_type_name text;
  v_person_label text;
  v_linked_email text;
begin
  select workspace.person_entity_type_id into v_person_entity_type_id
  from workspaces workspace
  where workspace.id = p_workspace_id;
  select entity_type.name into v_person_entity_type_name
  from entity_types entity_type
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = v_person_entity_type_id;
  select private.api_record_label(p_workspace_id, v_person_entity_type_id, p_entity_record_id)
  into v_person_label;
  select email::text into v_linked_email from auth.users where id = p_user_id;

  perform public.set_person_link_authorized_pre_governance(
    p_workspace_id, p_entity_record_id, p_user_id
  );

  insert into workspace_events (
    id, workspace_id, actor_user_id, event_type, entity_type_id, entity_record_id, metadata
  ) values (
    gen_random_uuid(), p_workspace_id, auth.uid(), 'person_linked',
    v_person_entity_type_id, p_entity_record_id,
    jsonb_build_object(
      'linked_user_id', p_user_id,
      'linked_email', v_linked_email,
      'person_record_id', p_entity_record_id,
      'person_label_snapshot', v_person_label,
      'person_entity_type_id', v_person_entity_type_id,
      'person_entity_type_name_snapshot', v_person_entity_type_name
    )
  );
end;
$$;

create function public.remove_person_link_authorized(
  p_workspace_id uuid,
  p_entity_record_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link entity_record_person_links%rowtype;
  v_person_entity_type_name text;
  v_person_label text;
  v_unlinked_email text;
begin
  select * into v_link
  from entity_record_person_links
  where workspace_id = p_workspace_id and entity_record_id = p_entity_record_id;
  select entity_type.name into v_person_entity_type_name
  from entity_types entity_type
  where entity_type.workspace_id = p_workspace_id
    and entity_type.id = v_link.entity_type_id;
  select private.api_record_label(p_workspace_id, v_link.entity_type_id, p_entity_record_id)
  into v_person_label;
  select email::text into v_unlinked_email from auth.users where id = v_link.user_id;

  perform public.remove_person_link_authorized_pre_governance(
    p_workspace_id, p_entity_record_id
  );

  insert into workspace_events (
    id, workspace_id, actor_user_id, event_type, entity_type_id, entity_record_id, metadata
  ) values (
    gen_random_uuid(), p_workspace_id, auth.uid(), 'person_unlinked',
    v_link.entity_type_id, p_entity_record_id,
    jsonb_build_object(
      'unlinked_user_id', v_link.user_id,
      'unlinked_email', v_unlinked_email,
      'person_record_id', p_entity_record_id,
      'person_label_snapshot', v_person_label,
      'person_entity_type_id', v_link.entity_type_id,
      'person_entity_type_name_snapshot', v_person_entity_type_name
    )
  );
end;
$$;

revoke all on function public.set_person_link_authorized(uuid, uuid, uuid),
  public.remove_person_link_authorized(uuid, uuid)
  from public, anon;
grant execute on function public.set_person_link_authorized(uuid, uuid, uuid),
  public.remove_person_link_authorized(uuid, uuid)
  to authenticated, service_role;

comment on function public.set_person_entity_type_authorized(uuid, uuid)
  is 'Designates the workspace Person EntityType and records one bounded person_entity_type_changed governance event for each meaningful designate, replace, or clear. schema.manage, real-actor-only, blocked while impersonating.';

comment on function public.set_person_link_authorized(uuid, uuid, uuid)
  is 'Links an active workspace member to an active record of the designated Person EntityType and records one transactional person_linked workspace event with bounded frozen identity snapshots.';

comment on function public.remove_person_link_authorized(uuid, uuid)
  is 'Unlinks a Person record from its workspace member and records one transactional person_unlinked workspace event with bounded pre-delete identity snapshots.';
