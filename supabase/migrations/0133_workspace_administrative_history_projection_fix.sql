-- 0133: qualify projection source columns after 0132 was applied.
-- The historical 0132 projection collides with RETURNS TABLE output variables
-- when normalized reads from source_rows. Keep one canonical private helper and
-- make the source-row boundary explicit without changing the public contract.

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
      sr.source_family || ':' || sr.source_event_id::text as event_id,
      sr.source_family, sr.source_event_id, sr.occurred_at, sr.event_type, sr.category,
      sr.subject_kind, sr.subject_id, sr.subject_label, sr.actor_user_id, sr.effective_user_id, sr.real_user_id,
      sr.authority_kind,
      sr.event_type as summary_key,
      private.workspace_administrative_history_details(sr.event_type, sr.changes, sr.metadata) as details,
      sr.correlation_id
    from source_rows sr
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
