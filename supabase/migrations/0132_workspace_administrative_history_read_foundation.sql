-- Phase 13.2E: closed read-policy and normalized Workspace Administrative
-- History projection over the existing append-only stores.

alter table workspace_role_capabilities
  drop constraint if exists workspace_role_capabilities_capability_check;

alter table workspace_role_capabilities
  add constraint workspace_role_capabilities_capability_check check (capability in (
    'workspace.manage_members', 'workspace.manage_roles', 'workspace.manage_organization', 'workspace.manage_settings',
    'schema.manage', 'automation.manage', 'records.operate', 'processes.operate', 'operations.view',
    'workspace.impersonate_users', 'workspace.manage_integrations', 'people_data.view_all', 'workspace.audit.read'
  ));

insert into workspace_role_capabilities (workspace_id, role_id, capability)
select role.workspace_id, role.id, 'workspace.audit.read'
from workspace_roles role
where role.is_builtin = true
  and not exists (
    select 1 from workspace_role_capabilities existing
    where existing.workspace_id = role.workspace_id
      and existing.role_id = role.id
      and existing.capability = 'workspace.audit.read'
  );

-- These two RPCs independently validate capability identifiers. Their current
-- validation and mutation behavior is retained; only the catalog is extended.
create or replace function create_workspace_role_authorized(
  p_workspace_id uuid, p_name text, p_description text, p_capabilities jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role_id uuid := gen_random_uuid(); v_capability text;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;
  insert into workspace_roles (id, workspace_id, name, description)
  values (v_role_id, p_workspace_id, trim(p_name), nullif(trim(p_description), ''));
  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members','workspace.manage_roles','workspace.manage_organization','workspace.manage_settings',
      'schema.manage','automation.manage','records.operate','processes.operate','operations.view',
      'workspace.impersonate_users','workspace.manage_integrations','people_data.view_all','workspace.audit.read'
    ) then raise exception 'Invalid capability'; end if;
    insert into workspace_role_capabilities (workspace_id, role_id, capability)
    values (p_workspace_id, v_role_id, v_capability);
  end loop;
  return v_role_id;
end;
$$;

create or replace function list_workspace_administrative_history_authorized(
  p_workspace_id uuid,
  p_limit integer default 50,
  p_after_occurred_at timestamptz default null,
  p_after_source_family text default null,
  p_after_source_event_id uuid default null,
  p_category text default null,
  p_event_type text default null,
  p_actor_user_id uuid default null,
  p_subject_kind text default null,
  p_subject_id uuid default null,
  p_start_at timestamptz default null,
  p_end_at timestamptz default null
)
returns table (
  event_id text, source_family text, source_event_id uuid, occurred_at timestamptz,
  event_type text, category text, subject_kind text, subject_id uuid, subject_label text,
  actor_user_id uuid, effective_user_id uuid, real_user_id uuid, authority_kind text,
  summary_key text, details jsonb, correlation_id text
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then
    if auth.uid() is null then raise exception 'Authentication required'; end if;
    perform private.require_workspace_capability(p_workspace_id, 'workspace.audit.read');
    if exists (
      select 1 from impersonation_sessions
      where workspace_id = p_workspace_id and real_actor_user_id = auth.uid() and ended_at is null
    ) then raise exception 'Workspace Administrative History is unavailable while impersonating'; end if;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Administrative history limit must be between 1 and 100';
  end if;
  if (p_after_occurred_at is null) <> (p_after_source_family is null)
     or (p_after_occurred_at is null) <> (p_after_source_event_id is null) then
    raise exception 'Administrative history cursor is incomplete';
  end if;

  return query
  with governance_allowlist(event_type, category) as (values
    ('entity_type_created','Schema'),('entity_type_updated','Schema'),('entity_type_archived','Schema'),('entity_type_restored','Schema'),('entity_type_deleted','Schema'),
    ('field_created','Schema'),('field_updated','Schema'),('field_archived','Schema'),('field_restored','Schema'),('field_deleted','Schema'),
    ('choice_option_created','Schema'),('choice_option_updated','Schema'),('choice_option_archived','Schema'),('choice_option_restored','Schema'),
    ('workflow_created','Schema'),('workflow_updated','Schema'),('workflow_enabled','Schema'),('workflow_disabled','Schema'),('workflow_deleted','Schema'),
    ('process_template_created','Schema'),('process_template_updated','Schema'),('process_template_archived','Schema'),('process_template_restored','Schema'),('process_template_deleted','Schema'),
    ('workspace_member_invited','Access'),('workspace_member_invitation_cancelled','Access'),('workspace_member_activated','Access'),('workspace_member_deactivated','Access'),('workspace_member_role_changed','Access'),
    ('workspace_role_created','Access'),('workspace_role_updated','Access'),('workspace_role_deleted','Access'),
    ('workspace_team_created','Organization'),('workspace_team_updated','Organization'),('workspace_team_archived','Organization'),('workspace_team_restored','Organization'),('workspace_team_deleted','Organization'),('workspace_team_member_added','Organization'),('workspace_team_member_removed','Organization'),('workspace_team_lead_added','Organization'),('workspace_team_lead_removed','Organization'),('workspace_primary_manager_changed','Organization'),
    ('person_entity_type_changed','People & Identity'),
    ('people_sensitive_access_configured','Sensitive Configuration'),('quality_review_lifecycle_configured','Sensitive Configuration'),('quality_review_presentation_configured','Sensitive Configuration')
  ), source_rows as (
    select
      'governance'::text as source_family, g.id as source_event_id, g.created_at as occurred_at,
      g.event_type, a.category, g.subject_kind, g.subject_id, g.subject_name_snapshot as subject_label,
      coalesce(g.real_actor_user_id, g.effective_actor_user_id) as actor_user_id,
      g.effective_actor_user_id as effective_user_id, g.real_actor_user_id as real_user_id,
      g.authority_kind, g.changes as changes, '{}'::jsonb as metadata,
      nullif(g.changes->>'operation_id', '') as correlation_id
    from governance_audit_events g join governance_allowlist a on a.event_type = g.event_type
    where g.workspace_id = p_workspace_id
    union all
    select
      'workspace_event'::text, e.id, e.created_at, e.event_type,
      case when e.event_type in ('person_linked','person_unlinked') then 'People & Identity' else 'Support / Impersonation' end,
      case when e.event_type in ('person_linked','person_unlinked') then 'person' else 'user' end,
      case when e.event_type in ('person_linked','person_unlinked') then (e.metadata->>'person_record_id')::uuid else (e.metadata->>'effective_user_id')::uuid end,
      case when e.event_type in ('person_linked','person_unlinked') then e.metadata->>'person_label_snapshot' else null end,
      e.actor_user_id, (e.metadata->>'effective_user_id')::uuid, e.real_actor_user_id,
      case when e.real_actor_user_id is not null then 'impersonated' else 'human' end,
      '{}'::jsonb, e.metadata, e.metadata->>'session_id'
    from workspace_events e
    where e.workspace_id = p_workspace_id
      and e.event_type in ('person_linked','person_unlinked','impersonation_started','impersonation_ended')
  ), normalized as (
    select
      source_family || ':' || source_event_id::text as event_id,
      source_family, source_event_id, occurred_at, event_type, category,
      subject_kind, subject_id, subject_label, actor_user_id, effective_user_id, real_user_id,
      authority_kind,
      event_type as summary_key,
      private.workspace_administrative_history_details(event_type, changes, metadata) as details,
      correlation_id
    from source_rows
  )
  select n.*
  from normalized n
  where (p_category is null or n.category = p_category)
    and (p_event_type is null or n.event_type = p_event_type)
    and (p_actor_user_id is null or n.actor_user_id = p_actor_user_id)
    and (p_subject_kind is null or n.subject_kind = p_subject_kind)
    and (p_subject_id is null or n.subject_id = p_subject_id)
    and (p_start_at is null or n.occurred_at >= p_start_at)
    and (p_end_at is null or n.occurred_at < p_end_at)
    and (p_after_occurred_at is null or n.occurred_at < p_after_occurred_at or (
      n.occurred_at = p_after_occurred_at and (n.source_family < p_after_source_family or (
        n.source_family = p_after_source_family and n.source_event_id < p_after_source_event_id
      ))
    ))
  order by n.occurred_at desc, n.source_family desc, n.source_event_id desc
  limit p_limit;
end;
$$;

revoke all on function list_workspace_administrative_history_authorized(uuid, integer, timestamptz, text, uuid, text, text, uuid, text, uuid, timestamptz, timestamptz) from public, anon, service_role;
grant execute on function list_workspace_administrative_history_authorized(uuid, integer, timestamptz, text, uuid, text, text, uuid, text, uuid, timestamptz, timestamptz) to authenticated;

create or replace function update_workspace_role_authorized(
  p_workspace_id uuid, p_role_id uuid, p_name text, p_description text, p_capabilities jsonb
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_capability text; v_caller_role uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  select role_id into v_caller_role from workspace_memberships
  where workspace_id = p_workspace_id and user_id = auth.uid() for update;
  if v_caller_role = p_role_id then raise exception 'You cannot edit the capabilities of your own role'; end if;
  if not exists (select 1 from workspace_roles where workspace_id = p_workspace_id and id = p_role_id) then
    raise exception 'Role not found';
  end if;
  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;
  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members','workspace.manage_roles','workspace.manage_organization','workspace.manage_settings',
      'schema.manage','automation.manage','records.operate','processes.operate','operations.view',
      'workspace.impersonate_users','workspace.manage_integrations','people_data.view_all','workspace.audit.read'
    ) then raise exception 'Invalid capability'; end if;
  end loop;
  update workspace_roles set name = trim(p_name), description = nullif(trim(p_description), ''), updated_at = now()
  where workspace_id = p_workspace_id and id = p_role_id;
  delete from workspace_role_capabilities where workspace_id = p_workspace_id and role_id = p_role_id;
  insert into workspace_role_capabilities (workspace_id, role_id, capability)
  select p_workspace_id, p_role_id, value from jsonb_array_elements_text(p_capabilities) value;
  perform private.assert_workspace_administrator(p_workspace_id);
end;
$$;

create or replace function private.workspace_administrative_history_details(
  p_event_type text, p_changes jsonb, p_metadata jsonb
)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_event_type in ('person_linked', 'person_unlinked') then jsonb_strip_nulls(jsonb_build_object(
      'user_id', coalesce(p_metadata->>'linked_user_id', p_metadata->>'unlinked_user_id'),
      'email', coalesce(p_metadata->>'linked_email', p_metadata->>'unlinked_email'),
      'person_record_id', p_metadata->>'person_record_id', 'person_label', p_metadata->>'person_label_snapshot',
      'person_entity_type_id', p_metadata->>'person_entity_type_id',
      'person_entity_type_name', p_metadata->>'person_entity_type_name_snapshot'
    ))
    when p_event_type in ('impersonation_started', 'impersonation_ended') then jsonb_strip_nulls(jsonb_build_object(
      'session_id', p_metadata->>'session_id', 'effective_user_id', p_metadata->>'effective_user_id',
      'reason', p_metadata->>'reason'
    ))
    when p_event_type in ('workspace_member_invited', 'workspace_member_invitation_cancelled') then jsonb_strip_nulls(jsonb_build_object(
      'email', p_changes->>'email', 'role_id', p_changes->>'role_id', 'role_name', p_changes->>'role_name',
      'status', coalesce(p_changes->>'status', 'cancelled'), 'previous_status', p_changes->>'previous_status'
    ))
    when p_event_type in ('workspace_member_activated', 'workspace_member_deactivated') then jsonb_strip_nulls(jsonb_build_object(
      'email', p_changes->>'email', 'role_id', p_changes->>'role_id', 'role_name', p_changes->>'role_name',
      'previously_active', p_changes->'previously_active', 'previously_deactivated', p_changes->'previously_deactivated'
    ))
    when p_event_type = 'workspace_member_role_changed' then jsonb_strip_nulls(jsonb_build_object(
      'old_role_id', p_changes->>'old_role_id', 'old_role_name', p_changes->>'old_role_name',
      'new_role_id', p_changes->>'new_role_id', 'new_role_name', p_changes->>'new_role_name', 'cause', p_changes->>'cause'
    ))
    when p_event_type in ('workspace_role_created', 'workspace_role_updated', 'workspace_role_deleted') then jsonb_strip_nulls(jsonb_build_object(
      'old_name', p_changes->>'old_name', 'new_name', p_changes->>'new_name',
      'old_description', p_changes->>'old_description', 'new_description', p_changes->>'new_description',
      'old_capabilities', p_changes->'old_capabilities', 'new_capabilities', p_changes->'new_capabilities',
      'added_capabilities', p_changes->'added_capabilities', 'removed_capabilities', p_changes->'removed_capabilities',
      'cause', p_changes->>'cause', 'operation_id', p_changes->>'operation_id'
    ))
    when p_event_type = 'workspace_primary_manager_changed' then jsonb_strip_nulls(jsonb_build_object(
      'old_manager_id', p_changes->>'old_manager_id', 'old_manager_email', p_changes->>'old_manager_email',
      'new_manager_id', p_changes->>'new_manager_id', 'new_manager_email', p_changes->>'new_manager_email',
      'operation', p_changes->>'operation'
    ))
    else jsonb_strip_nulls(jsonb_build_object('old', p_changes->'old', 'new', p_changes->'new'))
  end
$$;

revoke all on function private.workspace_administrative_history_details(text, jsonb, jsonb)
  from public, anon, authenticated, service_role;

comment on function list_workspace_administrative_history_authorized(
  uuid, integer, timestamptz, text, uuid, text, text, uuid, text, uuid, timestamptz, timestamptz
) is 'Curated Workspace Administrative History projection. Only explicitly allowlisted governance and identity/impersonation events are exposed; raw history stores remain closed.';
