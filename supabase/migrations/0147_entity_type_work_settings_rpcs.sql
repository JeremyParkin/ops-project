-- Record Work / Work Settings v1a -- configuration RPCs.
--
-- Two narrow RPCs, deliberately not one combined setter: mapping edits
-- (assignment/due/status/completion) never touch work_enabled, and
-- enable/disable never touches the mapping. This is the smallest reliable
-- way to guarantee a disable action cannot accidentally rewrite or clear
-- the mapping regardless of what a builder-form submission happens to
-- contain -- the enable/disable RPC simply has no mapping parameters to
-- misuse. Mirrors an existing precedent in this codebase: Quality Review
-- already splits its lifecycle toggle from its presentation config into two
-- independent RPCs/forms rather than one combined setter.

-- Full latest vocabulary (0141) reproduced faithfully, plus two new values.
alter table governance_audit_events
  drop constraint if exists governance_audit_events_event_type_check;
alter table governance_audit_events
  add constraint governance_audit_events_event_type_check check (event_type in (
    'field_created', 'field_updated', 'field_archived', 'field_restored', 'field_deleted',
    'field_type_changed',
    'choice_option_created', 'choice_option_updated', 'choice_option_archived', 'choice_option_restored',
    'choice_option_deleted',
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
    'person_entity_type_changed',
    'entity_type_work_mapping_configured', 'entity_type_work_enabled_changed'
  ));

-- 1. Read. schema.manage-gated -- this is builder configuration, not a
-- worker-facing surface (list_assigned_record_work_authorized, added
-- separately, is what ordinary members use and does not expose this).
create or replace function get_entity_type_work_settings_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns table (
  work_enabled boolean,
  work_assignment_field_id uuid,
  work_due_field_id uuid,
  work_status_field_id uuid,
  completion_option_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  return query
  select
    et.work_enabled,
    et.work_assignment_field_id,
    et.work_due_field_id,
    et.work_status_field_id,
    coalesce(
      (select array_agg(c.option_id order by c.created_at)
       from entity_type_work_completion_options c
       where c.workspace_id = p_workspace_id and c.entity_type_id = p_entity_type_id),
      array[]::uuid[]
    )
  from entity_types et
  where et.workspace_id = p_workspace_id and et.id = p_entity_type_id;
end;
$$;

revoke all on function get_entity_type_work_settings_authorized(uuid, uuid) from public, anon;
grant execute on function get_entity_type_work_settings_authorized(uuid, uuid) to authenticated, service_role;

-- 2. Mapping. Writes assignment/due/status/completion only. Never touches
-- work_enabled. p_completion_option_ids is ignored entirely when
-- p_status_field_id is null (no status field means "completion" is
-- meaningless) -- a non-empty array in that case is rejected, not silently
-- dropped, so a caller never has a false impression of what was saved.
create or replace function set_entity_type_work_mapping_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_assignment_field_id uuid,
  p_due_field_id uuid,
  p_status_field_id uuid,
  p_completion_option_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_field field_definitions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_option_id uuid;
  v_already_configured uuid[];
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  if not exists (
    select 1 from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id
    for update
  ) then
    raise exception 'Object not found.';
  end if;

  if p_assignment_field_id is not null then
    select * into v_field from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id
      and id = p_assignment_field_id and archived_at is null;
    if not found then
      raise exception 'Assignment field must be an active field on this object.';
    end if;
    if v_field.type <> 'workspace_member' then
      raise exception 'Assignment field must be a Workspace Member field.';
    end if;
  end if;

  if p_due_field_id is not null then
    select * into v_field from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id
      and id = p_due_field_id and archived_at is null;
    if not found then
      raise exception 'Due date field must be an active field on this object.';
    end if;
    if v_field.type <> 'date' then
      raise exception 'Due date field must be a Date field.';
    end if;
  end if;

  if p_status_field_id is not null then
    select * into v_field from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id
      and id = p_status_field_id and archived_at is null;
    if not found then
      raise exception 'Status field must be an active field on this object.';
    end if;
    if v_field.type <> 'choice' then
      raise exception 'Status field must be a Choice field.';
    end if;
  end if;

  if p_status_field_id is null and p_completion_option_ids is not null
    and array_length(p_completion_option_ids, 1) > 0
  then
    raise exception 'Completion options require a configured status field.';
  end if;

  -- Options already configured for this EntityType (any status field) may
  -- remain even if archived since this call -- archiving a Choice option
  -- never rewrites existing record values, so an already-selected
  -- completion option must stay meaningful. An option not previously
  -- configured must be active to be newly selected, mirroring the
  -- established "preserve vs. assign" distinction record writes already
  -- draw for archived Choice values.
  if p_status_field_id is not null then
    select coalesce(array_agg(c.option_id), array[]::uuid[])
      into v_already_configured
      from entity_type_work_completion_options c
      where c.workspace_id = p_workspace_id and c.entity_type_id = p_entity_type_id;

    foreach v_option_id in array coalesce(p_completion_option_ids, array[]::uuid[])
    loop
      if not exists (
        select 1 from field_choice_options
        where workspace_id = p_workspace_id
          and field_definition_id = p_status_field_id
          and id = v_option_id
      ) then
        raise exception 'Completed-when options must belong to the configured status field.';
      end if;

      if not (v_option_id = any (v_already_configured)) and exists (
        select 1 from field_choice_options
        where workspace_id = p_workspace_id and id = v_option_id and archived_at is not null
      ) then
        raise exception 'A newly selected completion option must be active.';
      end if;
    end loop;
  end if;

  select jsonb_build_object(
    'work_assignment_field_id', work_assignment_field_id,
    'work_due_field_id', work_due_field_id,
    'work_status_field_id', work_status_field_id,
    'completion_option_ids', (
      select coalesce(array_agg(c.option_id order by c.option_id), array[]::uuid[])
      from entity_type_work_completion_options c
      where c.workspace_id = p_workspace_id and c.entity_type_id = p_entity_type_id
    )
  )
  into v_before
  from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;

  update entity_types
  set work_assignment_field_id = p_assignment_field_id,
      work_due_field_id = p_due_field_id,
      work_status_field_id = p_status_field_id,
      updated_at = now()
  where workspace_id = p_workspace_id and id = p_entity_type_id;

  delete from entity_type_work_completion_options
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id;

  if p_status_field_id is not null and p_completion_option_ids is not null then
    insert into entity_type_work_completion_options (workspace_id, entity_type_id, status_field_id, option_id)
    select p_workspace_id, p_entity_type_id, p_status_field_id, option_id
    from unnest(p_completion_option_ids) as option_id;
  end if;

  select jsonb_build_object(
    'work_assignment_field_id', work_assignment_field_id,
    'work_due_field_id', work_due_field_id,
    'work_status_field_id', work_status_field_id,
    'completion_option_ids', (
      select coalesce(array_agg(c.option_id order by c.option_id), array[]::uuid[])
      from entity_type_work_completion_options c
      where c.workspace_id = p_workspace_id and c.entity_type_id = p_entity_type_id
    )
  )
  into v_after
  from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;

  if v_before is distinct from v_after then
    perform private.governance_audit_insert(
      p_workspace_id,
      'entity_type_work_mapping_configured',
      'entity_type',
      p_entity_type_id,
      (select name from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id),
      null, null, null, null,
      jsonb_build_object('old', v_before, 'new', v_after)
    );
  end if;
end;
$$;

revoke all on function set_entity_type_work_mapping_authorized(uuid, uuid, uuid, uuid, uuid, uuid[]) from public, anon;
grant execute on function set_entity_type_work_mapping_authorized(uuid, uuid, uuid, uuid, uuid, uuid[]) to authenticated, service_role;

-- 3. Enable/disable. No mapping parameters at all -- disabling can never
-- rewrite or clear the mapping regardless of a stale/omitted form field,
-- and enabling re-validates the currently stored mapping against current
-- eligible fields/options (defense in depth: the archival block added
-- alongside this RPC should already prevent a mapped field from ever being
-- archived while referenced, but this re-check covers any mapping that
-- predates that protection or any other drift).
create or replace function set_entity_type_work_enabled_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  et entity_types%rowtype;
  v_field field_definitions%rowtype;
  v_option_id uuid;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  select * into et from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
  for update;
  if not found then
    raise exception 'Object not found.';
  end if;

  if et.work_enabled = p_enabled then
    return; -- already in the desired state -- no-op, no governance event
  end if;

  if p_enabled then
    if et.work_assignment_field_id is null then
      raise exception 'An assignment field must be configured before Work can be enabled.';
    end if;

    select * into v_field from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id
      and id = et.work_assignment_field_id and archived_at is null and type = 'workspace_member';
    if not found then
      raise exception 'The configured assignment field is no longer an active Workspace Member field.';
    end if;

    if et.work_due_field_id is not null then
      select * into v_field from field_definitions
      where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id
        and id = et.work_due_field_id and archived_at is null and type = 'date';
      if not found then
        raise exception 'The configured due date field is no longer an active Date field.';
      end if;
    end if;

    if et.work_status_field_id is not null then
      select * into v_field from field_definitions
      where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id
        and id = et.work_status_field_id and archived_at is null and type = 'choice';
      if not found then
        raise exception 'The configured status field is no longer an active Choice field.';
      end if;

      for v_option_id in
        select option_id from entity_type_work_completion_options
        where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id
      loop
        if not exists (
          select 1 from field_choice_options
          where workspace_id = p_workspace_id
            and field_definition_id = et.work_status_field_id
            and id = v_option_id
        ) then
          raise exception 'A configured completion option is no longer valid for the status field.';
        end if;
      end loop;
    end if;
  end if;

  update entity_types
  set work_enabled = p_enabled, updated_at = now()
  where workspace_id = p_workspace_id and id = p_entity_type_id;

  perform private.governance_audit_insert(
    p_workspace_id,
    'entity_type_work_enabled_changed',
    'entity_type',
    p_entity_type_id,
    et.name,
    null, null, null, null,
    jsonb_build_object('old', jsonb_build_object('work_enabled', et.work_enabled), 'new', jsonb_build_object('work_enabled', p_enabled))
  );
end;
$$;

revoke all on function set_entity_type_work_enabled_authorized(uuid, uuid, boolean) from public, anon;
grant execute on function set_entity_type_work_enabled_authorized(uuid, uuid, boolean) to authenticated, service_role;
