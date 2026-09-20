-- Record Work / Work Settings v1a -- assignment/reassignment notifications.
--
-- Two event types only: record_work_assigned, record_work_reassigned. No
-- record_work_unassigned (unassignment never notifies). No due-soon/
-- overdue notifications in v1a. Both fall through notifications'
-- private.should_create_optional_notification 'else true' branch --
-- mandatory, not user-configurable, matching step_assigned/step_due_soon/
-- step_overdue's existing posture; no entry is added to that function.
--
-- Dedup: after Workspace Member values are written (already true by the
-- time every call site below runs -- apply_workspace_member_record_values
-- has always executed first), private.record_work_notify_if_configured
-- re-queries the persisted configured-assignment value row by its unique
-- (workspace_id, source_record_id, field_definition_id) key and uses that
-- row's own fresh id in the dedup key. entity_record_workspace_member_
-- values rows are deleted and reinserted on every write (0143/0144), never
-- updated in place, so each assignment episode already gets a fresh id for
-- free -- A -> unassigned deletes the row; unassigned -> A reinserts a
-- brand-new one. This gives natural per-episode dedup uniqueness, including
-- A -> unassigned -> A, with no assignment_generation-style counter.
--
-- Wired into the seven workspace-member-aware write paths that already
-- compute the identical old/new snapshot diff for private.workspace_
-- member_append_activity (interactive/automation/process-system create and
-- update, plus the interactive bulk-import wrapper, whose loop already
-- performs this exact same per-record diff -- confirmed by inspection, not
-- assumed, so bulk-import notification support is included rather than
-- deferred). Every function below is reproduced in full from its
-- authoritative current source (0143), with exactly one new line added
-- immediately after the existing workspace_member_append_activity call.

-- Full latest vocabulary (0090) reproduced faithfully, plus two new values.
alter table notifications
  drop constraint if exists notifications_event_type_check;
alter table notifications
  add constraint notifications_event_type_check
  check (event_type in (
    'step_assigned',
    'step_due_soon',
    'step_overdue',
    'record_comment_mentioned',
    'process_step_run_comment_mentioned',
    'record_input_request_created',
    'record_input_request_responded',
    'record_input_request_cancelled',
    'process_step_run_input_request_created',
    'process_step_run_input_request_responded',
    'process_step_run_input_request_cancelled',
    'record_work_assigned',
    'record_work_reassigned'
  ));
-- notifications_collaboration_target_shape_check (0090) is unaffected: its
-- final catch-all arm already requires record_comment_id/process_step_run_
-- comment_id/record_input_request_id/process_step_run_input_request_id to
-- all be null for any event_type not in its explicit eight-value list, and
-- neither new event type is in that list -- verified by inspection, no
-- constraint change needed.

create or replace function private.record_work_notify_if_configured(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_old_members jsonb,
  p_new_members jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  et entity_types%rowtype;
  v_old_user_id uuid;
  v_new_user_id uuid;
  v_value_row_id uuid;
  v_field_name text;
  v_title text;
begin
  select * into et from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  if not found or not et.work_enabled or et.work_assignment_field_id is null then
    return;
  end if;

  v_old_user_id := (
    select (member ->> 'member_user_id')::uuid
    from jsonb_array_elements(coalesce(p_old_members, '[]'::jsonb)) member
    where member ->> 'field_definition_id' = et.work_assignment_field_id::text
    limit 1
  );
  v_new_user_id := (
    select (member ->> 'member_user_id')::uuid
    from jsonb_array_elements(coalesce(p_new_members, '[]'::jsonb)) member
    where member ->> 'field_definition_id' = et.work_assignment_field_id::text
    limit 1
  );

  -- Unassigned, or no change to the configured assignment field
  -- specifically (an unrelated Workspace Member field changing produces no
  -- entry here at all, since only work_assignment_field_id is inspected).
  if v_new_user_id is null or v_old_user_id is not distinct from v_new_user_id then
    return;
  end if;

  -- Active-work check: assigning (or reassigning) into an already-
  -- completed or archived record must not notify.
  if not exists (
    select 1 from entity_records
    where workspace_id = p_workspace_id and id = p_record_id and archived_at is null
  ) then
    return;
  end if;

  if et.work_status_field_id is not null then
    declare
      v_status_field field_definitions%rowtype;
      v_current_status text;
    begin
      select * into v_status_field from field_definitions
      where workspace_id = p_workspace_id and id = et.work_status_field_id;
      if found then
        select values ->> v_status_field.key into v_current_status
        from entity_records
        where workspace_id = p_workspace_id and id = p_record_id;

        if v_current_status is not null and exists (
          select 1 from entity_type_work_completion_options c
          where c.workspace_id = p_workspace_id
            and c.entity_type_id = p_entity_type_id
            and c.option_id::text = v_current_status
        ) then
          return;
        end if;
      end if;
    end;
  end if;

  -- Fresh value-row id: a plain re-query against the already-written
  -- value, not an expansion of the existing snapshot/diff contract.
  select id into v_value_row_id
  from entity_record_workspace_member_values
  where workspace_id = p_workspace_id
    and source_record_id = p_record_id
    and field_definition_id = et.work_assignment_field_id;

  if v_value_row_id is null then
    -- The write this diff described has already been superseded within
    -- this same transaction (a later statement changed it again) --
    -- nothing to notify for a value that no longer exists.
    return;
  end if;

  select name into v_field_name from field_definitions
  where workspace_id = p_workspace_id and id = et.work_assignment_field_id;

  v_title := case
    when v_old_user_id is null then coalesce(v_field_name, 'Assignment') || ': assigned to you'
    else coalesce(v_field_name, 'Assignment') || ': reassigned to you'
  end;

  insert into notifications (
    workspace_id, recipient_user_id, event_type, entity_type_id, entity_record_id,
    title, destination_href, dedup_key
  )
  values (
    p_workspace_id,
    v_new_user_id,
    case when v_old_user_id is null then 'record_work_assigned' else 'record_work_reassigned' end,
    p_entity_type_id,
    p_record_id,
    v_title,
    '/entities/' || p_entity_type_id::text || '/records/' || p_record_id::text,
    'record_work:' || v_value_row_id::text
  )
  on conflict (workspace_id, dedup_key) do nothing;
end;
$$;

revoke all on function private.record_work_notify_if_configured(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function private.record_work_notify_if_configured(uuid, uuid, uuid, jsonb, jsonb) to service_role;

-- 1. Interactive create (workspace-member-aware overload).
create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_workspace_members jsonb,
  p_originating_process_step_run_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_new_members jsonb;
  a record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  if p_originating_process_step_run_id is not null then
    raise exception 'Process provenance requires the trusted process door';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  select * into a from private.record_change_interactive_attribution(p_workspace_id);

  v_record_id := private.record_create_core(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    a.effective_actor_user_id,
    a.real_actor_user_id,
    a.authority_kind
  );

  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    private.workspace_member_field_ids_json(p_workspace_id, p_entity_type_id),
    p_workspace_members,
    false,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, v_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    'record_updated',
    '[]'::jsonb,
    v_new_members,
    a.effective_actor_user_id,
    a.real_actor_user_id,
    a.authority_kind
  );
  perform private.record_work_notify_if_configured(
    p_workspace_id, p_entity_type_id, v_record_id, '[]'::jsonb, v_new_members
  );

  return v_record_id;
end;
$$;

-- 2. Interactive update (workspace-member-aware overload).
create or replace function update_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb,
  p_workspace_member_field_ids jsonb,
  p_workspace_members jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_old_members jsonb;
  v_new_members jsonb;
  a record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  v_old_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  v_record_id := public.update_entity_record_with_relations_authorized(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations
  );

  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_workspace_member_field_ids,
    p_workspace_members,
    true,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    'record_updated',
    v_old_members,
    v_new_members,
    a.effective_actor_user_id,
    a.real_actor_user_id,
    a.authority_kind
  );
  perform private.record_work_notify_if_configured(
    p_workspace_id, p_entity_type_id, p_record_id, v_old_members, v_new_members
  );

  return v_record_id;
end;
$$;

-- 3. Automation-system create.
create or replace function create_entity_record_with_relations_automation_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_workspace_members jsonb,
  p_originating_workflow_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_new_members jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  perform private.assert_automation_cause(
    p_workspace_id,
    p_originating_workflow_id,
    p_entity_type_id,
    p_action_type,
    p_related_field_definition_id
  );
  v_record_id := private.record_create_core(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    null,
    null,
    'automation',
    p_originating_workflow_id
  );
  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    private.workspace_member_field_ids_json(p_workspace_id, p_entity_type_id),
    p_workspace_members,
    false,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, v_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    'record_updated',
    '[]'::jsonb,
    v_new_members,
    null,
    null,
    'automation',
    p_originating_workflow_id
  );
  perform private.record_work_notify_if_configured(
    p_workspace_id, p_entity_type_id, v_record_id, '[]'::jsonb, v_new_members
  );
  return v_record_id;
end;
$$;

-- 4. Automation-system update.
create or replace function update_entity_record_with_relations_automation_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb,
  p_workspace_member_field_ids jsonb,
  p_workspace_members jsonb,
  p_originating_workflow_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_old_members jsonb;
  v_new_members jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  v_old_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  v_record_id := public.update_entity_record_with_relations_automation_system(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations,
    p_originating_workflow_id,
    p_action_type,
    p_related_field_definition_id
  );
  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_workspace_member_field_ids,
    p_workspace_members,
    true,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    'record_updated',
    v_old_members,
    v_new_members,
    null,
    null,
    'automation',
    p_originating_workflow_id
  );
  perform private.record_work_notify_if_configured(
    p_workspace_id, p_entity_type_id, p_record_id, v_old_members, v_new_members
  );
  return v_record_id;
end;
$$;

-- 5. Process-system create.
create or replace function create_entity_record_with_relations_process_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_workspace_members jsonb,
  p_originating_process_step_run_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_new_members jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  perform private.assert_process_cause(
    p_workspace_id,
    p_originating_process_step_run_id,
    p_entity_type_id,
    p_action_type,
    p_related_field_definition_id
  );
  v_record_id := private.record_create_core(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    null,
    null,
    'process',
    null,
    p_originating_process_step_run_id
  );
  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    private.workspace_member_field_ids_json(p_workspace_id, p_entity_type_id),
    p_workspace_members,
    false,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, v_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    'record_updated',
    '[]'::jsonb,
    v_new_members,
    null,
    null,
    'process',
    null,
    p_originating_process_step_run_id
  );
  perform private.record_work_notify_if_configured(
    p_workspace_id, p_entity_type_id, v_record_id, '[]'::jsonb, v_new_members
  );
  return v_record_id;
end;
$$;

-- 6. Process-system update.
create or replace function update_entity_record_with_relations_process_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb,
  p_workspace_member_field_ids jsonb,
  p_workspace_members jsonb,
  p_originating_process_step_run_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_old_members jsonb;
  v_new_members jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  v_old_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  v_record_id := public.update_entity_record_with_relations_process_system(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations,
    p_originating_process_step_run_id,
    p_action_type,
    p_related_field_definition_id
  );
  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_workspace_member_field_ids,
    p_workspace_members,
    true,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    'record_updated',
    v_old_members,
    v_new_members,
    null,
    null,
    'process',
    null,
    p_originating_process_step_run_id
  );
  perform private.record_work_notify_if_configured(
    p_workspace_id, p_entity_type_id, p_record_id, v_old_members, v_new_members
  );
  return v_record_id;
end;
$$;

-- 7. Interactive bulk-import wrapper. Its per-row loop already computes an
-- identical '[]'::jsonb -> v_members diff for workspace_member_append_
-- activity; the notification hook reuses that same call site.
create or replace function public.bulk_create_entity_records_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_import_id uuid,
  p_rows jsonb
)
returns table (imported_row_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_record entity_records%rowtype;
  a record;
  v_relations jsonb;
  v_members jsonb;
begin
  if auth.role() = 'service_role' and auth.uid() is null then
    return query select * from private.bulk_create_entity_records_authorized(
      p_workspace_id, p_entity_type_id, p_import_id, p_rows
    );
    return;
  end if;

  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  return query select * from private.bulk_create_entity_records_authorized(
    p_workspace_id, p_entity_type_id, p_import_id, p_rows
  );

  select record_import_batches.imported_row_count
    into v_count
    from record_import_batches
    where record_import_batches.id = p_import_id;

  for v_record in
    select *
    from entity_records
    where workspace_id = p_workspace_id
      and import_batch_id = p_import_id
  loop
    if not exists (
      select 1
      from record_change_events
      where entity_record_id = v_record.id
        and event_type = 'record_created'
    ) then
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'field_definition_id', field_definition_id,
          'target_entity_type_id', target_entity_type_id,
          'target_record_id', target_record_id
        )),
        '[]'::jsonb
      )
        into v_relations
        from entity_record_relation_values
        where workspace_id = p_workspace_id
          and source_record_id = v_record.id;

      perform private.record_change_insert(
        p_workspace_id,
        p_entity_type_id,
        v_record.id,
        'record_created',
        a.effective_actor_user_id,
        a.real_actor_user_id,
        a.authority_kind,
        null,
        null,
        p_import_id,
        private.record_change_payload(
          p_workspace_id,
          p_entity_type_id,
          v_record.id,
          null,
          v_record.values,
          '[]'::jsonb,
          v_relations
        )
      );
    end if;

    v_members := private.workspace_member_value_snapshot(
      p_workspace_id,
      p_entity_type_id,
      v_record.id
    );
    perform private.workspace_member_append_activity(
      p_workspace_id,
      p_entity_type_id,
      v_record.id,
      'record_updated',
      '[]'::jsonb,
      v_members,
      a.effective_actor_user_id,
      a.real_actor_user_id,
      a.authority_kind
    );
    perform private.record_work_notify_if_configured(
      p_workspace_id, p_entity_type_id, v_record.id, '[]'::jsonb, v_members
    );
  end loop;
end;
$$;

revoke all on function public.bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb)
  to authenticated, service_role;
