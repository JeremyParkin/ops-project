-- Field archive dependency repair.
--
-- Adds a typed authoritative archive path that can distinguish ordinary
-- "needs confirmation" Work Settings dependencies from true blocks, while
-- preserving archive's existing Saved View lifecycle: views may become stale
-- and repairable, but do not prevent archival.

create or replace function archive_field_definition_with_dependencies_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid,
  p_confirm_work_settings_clear boolean default false
)
returns table (
  archived boolean,
  blocked_reason text,
  message text,
  cleared_work_assignment boolean,
  cleared_work_due boolean,
  cleared_work_status boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  f field_definitions%rowtype;
  e entity_types%rowtype;
  v_work_assignment_ref boolean := false;
  v_work_due_ref boolean := false;
  v_work_status_ref boolean := false;
  v_before_work jsonb;
  v_after_work jsonb;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  select * into f
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_field_definition_id
  for update;
  if not found then
    raise exception 'Field definition not found.';
  end if;

  select * into e
  from entity_types
  where workspace_id = p_workspace_id
    and id = p_entity_type_id
  for update;
  if not found then
    raise exception 'Object not found.';
  end if;

  archived := false;
  blocked_reason := null;
  message := null;
  cleared_work_assignment := false;
  cleared_work_due := false;
  cleared_work_status := false;

  if e.display_field_definition_id = p_field_definition_id then
    blocked_reason := 'display_field';
    message := 'This field is used as the display field for ' || e.name || '. Choose another display field before archiving it.';
    return next;
    return;
  end if;

  v_work_assignment_ref := e.work_assignment_field_id = p_field_definition_id;
  v_work_due_ref := e.work_due_field_id = p_field_definition_id;
  v_work_status_ref := e.work_status_field_id = p_field_definition_id;

  if e.work_enabled and v_work_assignment_ref then
    blocked_reason := 'work_assignment_enabled';
    message := 'This field is ' || e.name || '''s Work Settings assignment field. Select another assignment field or turn off Work before archiving it.';
    return next;
    return;
  end if;

  if v_work_assignment_ref or v_work_due_ref or v_work_status_ref then
    if not p_confirm_work_settings_clear then
      blocked_reason := 'work_settings_confirmation_required';
      if e.work_enabled then
        message := 'This field is used by Work Settings. Confirm to remove the optional Work Settings mapping and archive it.';
      else
        message := 'This field is used by dormant Work Settings configuration. Confirm to remove that mapping and archive it.';
      end if;
      return next;
      return;
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
    into v_before_work
    from entity_types
    where workspace_id = p_workspace_id and id = p_entity_type_id;

    update entity_types
    set work_assignment_field_id = case
          when (not e.work_enabled) and work_assignment_field_id = p_field_definition_id then null
          else work_assignment_field_id
        end,
        work_due_field_id = case
          when work_due_field_id = p_field_definition_id then null
          else work_due_field_id
        end,
        work_status_field_id = case
          when work_status_field_id = p_field_definition_id then null
          else work_status_field_id
        end,
        updated_at = now()
    where workspace_id = p_workspace_id and id = p_entity_type_id;

    if v_work_status_ref then
      delete from entity_type_work_completion_options
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and status_field_id = p_field_definition_id;
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
    into v_after_work
    from entity_types
    where workspace_id = p_workspace_id and id = p_entity_type_id;

    if v_before_work is distinct from v_after_work then
      perform private.governance_audit_insert(
        p_workspace_id,
        'entity_type_work_mapping_configured',
        'entity_type',
        p_entity_type_id,
        e.name,
        null, null, null, null,
        jsonb_build_object('old', v_before_work, 'new', v_after_work)
      );
    end if;

    cleared_work_assignment := v_work_assignment_ref and not e.work_enabled;
    cleared_work_due := v_work_due_ref;
    cleared_work_status := v_work_status_ref;
  end if;

  if f.archived_at is null then
    update field_definitions
    set archived_at = now(), updated_at = now()
    where workspace_id = p_workspace_id and id = p_field_definition_id;

    perform private.governance_audit_insert(
      p_workspace_id,
      'field_archived',
      'field',
      f.id,
      f.name,
      null, null,
      e.id,
      e.name,
      jsonb_build_object('old', jsonb_build_object('archived_at', null), 'new', jsonb_build_object('archived_at', now()))
    );
  end if;

  archived := true;
  message := 'Field archived.';
  return next;
end;
$$;

revoke all on function archive_field_definition_with_dependencies_authorized(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function archive_field_definition_with_dependencies_authorized(uuid, uuid, uuid, boolean) to authenticated, service_role;

create or replace function archive_field_definition_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result record;
begin
  select * into result
  from archive_field_definition_with_dependencies_authorized(
    p_workspace_id,
    p_entity_type_id,
    p_field_definition_id,
    false
  );

  if not result.archived then
    raise exception '%', result.message;
  end if;
end;
$$;

revoke all on function archive_field_definition_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function archive_field_definition_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on function archive_field_definition_with_dependencies_authorized(uuid, uuid, uuid, boolean)
  is 'schema.manage-checked field archival with typed dependency outcomes. Saved View references do not block archive. Confirmed Work Settings repairs clear dependent optional/dormant mapping in the same transaction before archiving.';
