-- Phase 13.2B4b1: semantic governance history for teams, team membership,
-- and team leadership. Primary-manager governance remains deferred.

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
    'workspace_team_member_removed', 'workspace_team_lead_added', 'workspace_team_lead_removed'
  )),
  add constraint governance_audit_events_subject_kind_check check (subject_kind in (
    'field', 'choice_option', 'entity_type', 'workflow', 'process_template',
    'workspace_invitation', 'workspace_member', 'workspace_role', 'workspace_team'
  )),
  add constraint governance_audit_events_subject_hierarchy_check check (
    (subject_kind = 'entity_type' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'field' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind = 'choice_option' and parent_entity_type_id is not null and parent_field_id is not null)
    or (subject_kind = 'workflow' and parent_entity_type_id is null and parent_field_id is null)
    or (subject_kind = 'process_template' and parent_entity_type_id is not null and parent_field_id is null)
    or (subject_kind in ('workspace_invitation', 'workspace_member', 'workspace_role', 'workspace_team')
      and parent_entity_type_id is null and parent_field_id is null)
  );

create or replace function private.workspace_team_governance_snapshot(
  p_workspace_id uuid,
  p_team_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', team.id,
    'name', team.name,
    'description', team.description,
    'archived_at', team.archived_at
  )
  from workspace_teams team
  where team.workspace_id = p_workspace_id
    and team.id = p_team_id;
$$;

revoke all on function private.workspace_team_governance_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role;

-- The six current 0125 bodies are retained intact behind private-in-practice
-- names. The public signatures and grants are restored by the wrappers below.
alter function public.create_workspace_team_authorized(uuid, text, text)
  rename to create_workspace_team_authorized_pre_governance;
alter function public.update_workspace_team_authorized(uuid, uuid, text, text)
  rename to update_workspace_team_authorized_pre_governance;
alter function public.set_workspace_team_archived_authorized(uuid, uuid, boolean)
  rename to set_workspace_team_archived_authorized_pre_governance;
alter function public.delete_workspace_team_if_empty_authorized(uuid, uuid)
  rename to delete_workspace_team_if_empty_authorized_pre_governance;
alter function public.set_workspace_team_membership_authorized(uuid, uuid, uuid, boolean)
  rename to set_workspace_team_membership_authorized_pre_governance;
alter function public.set_workspace_team_lead_authorized(uuid, uuid, uuid, boolean)
  rename to set_workspace_team_lead_authorized_pre_governance;

revoke all on function
  public.create_workspace_team_authorized_pre_governance(uuid, text, text),
  public.update_workspace_team_authorized_pre_governance(uuid, uuid, text, text),
  public.set_workspace_team_archived_authorized_pre_governance(uuid, uuid, boolean),
  public.delete_workspace_team_if_empty_authorized_pre_governance(uuid, uuid),
  public.set_workspace_team_membership_authorized_pre_governance(uuid, uuid, uuid, boolean),
  public.set_workspace_team_lead_authorized_pre_governance(uuid, uuid, uuid, boolean)
from public, anon, authenticated, service_role;

create function public.create_workspace_team_authorized(
  p_workspace_id uuid,
  p_name text,
  p_description text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id uuid;
  v_after jsonb;
begin
  v_team_id := public.create_workspace_team_authorized_pre_governance(
    p_workspace_id, p_name, p_description
  );
  v_after := private.workspace_team_governance_snapshot(p_workspace_id, v_team_id);
  if v_after is null then
    raise exception 'Team governance snapshot was not created';
  end if;

  perform private.governance_audit_insert(
    p_workspace_id, 'workspace_team_created', 'workspace_team', v_team_id,
    v_after ->> 'name', null, null, null, null,
    jsonb_build_object('new', v_after)
  );
  return v_team_id;
end;
$$;

create function public.update_workspace_team_authorized(
  p_workspace_id uuid,
  p_team_id uuid,
  p_name text,
  p_description text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  v_before := private.workspace_team_governance_snapshot(p_workspace_id, p_team_id);
  perform public.update_workspace_team_authorized_pre_governance(
    p_workspace_id, p_team_id, p_name, p_description
  );
  v_after := private.workspace_team_governance_snapshot(p_workspace_id, p_team_id);

  if v_before is distinct from v_after then
    perform private.governance_audit_insert(
      p_workspace_id, 'workspace_team_updated', 'workspace_team', p_team_id,
      v_after ->> 'name', null, null, null, null,
      jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;
end;
$$;

create function public.set_workspace_team_archived_authorized(
  p_workspace_id uuid,
  p_team_id uuid,
  p_archived boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_event_type text;
begin
  v_before := private.workspace_team_governance_snapshot(p_workspace_id, p_team_id);
  perform public.set_workspace_team_archived_authorized_pre_governance(
    p_workspace_id, p_team_id, p_archived
  );
  v_after := private.workspace_team_governance_snapshot(p_workspace_id, p_team_id);

  if v_before is distinct from v_after then
    if (v_before ->> 'archived_at') is null and (v_after ->> 'archived_at') is not null then
      v_event_type := 'workspace_team_archived';
    elsif (v_before ->> 'archived_at') is not null and (v_after ->> 'archived_at') is null then
      v_event_type := 'workspace_team_restored';
    end if;
  end if;

  if v_event_type is not null then
    perform private.governance_audit_insert(
      p_workspace_id, v_event_type, 'workspace_team', p_team_id,
      coalesce(v_after ->> 'name', v_before ->> 'name'), null, null, null, null,
      jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;
end;
$$;

create function public.delete_workspace_team_if_empty_authorized(
  p_workspace_id uuid,
  p_team_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  v_before := private.workspace_team_governance_snapshot(p_workspace_id, p_team_id);
  perform public.delete_workspace_team_if_empty_authorized_pre_governance(
    p_workspace_id, p_team_id
  );

  if v_before is not null then
    perform private.governance_audit_insert(
      p_workspace_id, 'workspace_team_deleted', 'workspace_team', p_team_id,
      v_before ->> 'name', null, null, null, null,
      jsonb_build_object('old', v_before)
    );
  end if;
end;
$$;

create function public.set_workspace_team_membership_authorized(
  p_workspace_id uuid,
  p_team_id uuid,
  p_user_id uuid,
  p_is_member boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team jsonb;
  v_before boolean;
  v_after boolean;
  v_email text;
begin
  v_team := private.workspace_team_governance_snapshot(p_workspace_id, p_team_id);
  select exists (
    select 1 from workspace_team_memberships
    where workspace_id = p_workspace_id and team_id = p_team_id and user_id = p_user_id
  ) into v_before;
  select email::text into v_email from auth.users where id = p_user_id;

  perform public.set_workspace_team_membership_authorized_pre_governance(
    p_workspace_id, p_team_id, p_user_id, p_is_member
  );

  select exists (
    select 1 from workspace_team_memberships
    where workspace_id = p_workspace_id and team_id = p_team_id and user_id = p_user_id
  ) into v_after;

  if v_before is distinct from v_after then
    perform private.governance_audit_insert(
      p_workspace_id,
      case when v_after then 'workspace_team_member_added' else 'workspace_team_member_removed' end,
      'workspace_team', p_team_id, v_team ->> 'name', null, null, null, null,
      jsonb_build_object(
        'team', v_team,
        'member_user_id', p_user_id,
        'member_email', v_email,
        'operation', case when v_after then 'add' else 'remove' end
      )
    );
  end if;
end;
$$;

create function public.set_workspace_team_lead_authorized(
  p_workspace_id uuid,
  p_team_id uuid,
  p_user_id uuid,
  p_is_lead boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team jsonb;
  v_before boolean;
  v_after boolean;
  v_email text;
begin
  v_team := private.workspace_team_governance_snapshot(p_workspace_id, p_team_id);
  select exists (
    select 1 from workspace_team_leads
    where workspace_id = p_workspace_id and team_id = p_team_id and user_id = p_user_id
  ) into v_before;
  select email::text into v_email from auth.users where id = p_user_id;

  perform public.set_workspace_team_lead_authorized_pre_governance(
    p_workspace_id, p_team_id, p_user_id, p_is_lead
  );

  select exists (
    select 1 from workspace_team_leads
    where workspace_id = p_workspace_id and team_id = p_team_id and user_id = p_user_id
  ) into v_after;

  if v_before is distinct from v_after then
    perform private.governance_audit_insert(
      p_workspace_id,
      case when v_after then 'workspace_team_lead_added' else 'workspace_team_lead_removed' end,
      'workspace_team', p_team_id, v_team ->> 'name', null, null, null, null,
      jsonb_build_object(
        'team', v_team,
        'lead_user_id', p_user_id,
        'lead_email', v_email,
        'operation', case when v_after then 'add' else 'remove' end
      )
    );
  end if;
end;
$$;

revoke all on function
  public.create_workspace_team_authorized(uuid, text, text),
  public.update_workspace_team_authorized(uuid, uuid, text, text),
  public.set_workspace_team_archived_authorized(uuid, uuid, boolean),
  public.delete_workspace_team_if_empty_authorized(uuid, uuid),
  public.set_workspace_team_membership_authorized(uuid, uuid, uuid, boolean),
  public.set_workspace_team_lead_authorized(uuid, uuid, uuid, boolean)
from public, anon;

grant execute on function
  public.create_workspace_team_authorized(uuid, text, text),
  public.update_workspace_team_authorized(uuid, uuid, text, text),
  public.set_workspace_team_archived_authorized(uuid, uuid, boolean),
  public.delete_workspace_team_if_empty_authorized(uuid, uuid),
  public.set_workspace_team_membership_authorized(uuid, uuid, uuid, boolean),
  public.set_workspace_team_lead_authorized(uuid, uuid, uuid, boolean)
to authenticated, service_role;
