-- Phase 1 field type-change dependency repair.
--
-- Keeps the original pristine-only conversion policy, but stops treating
-- table-column saved-view references as blocking. Filters, sorts, typed
-- Board/Calendar presentation references, Work Settings mappings, and every
-- pre-existing invariant remain authoritative blockers.

create function private.field_definition_type_change_dependencies_typed(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid,
  p_new_type text default null
)
returns table (
  pristine boolean,
  record_value_count bigint,
  relation_value_count bigint,
  choice_option_count bigint,
  display_field_reference_count bigint,
  quality_review_reference_count bigint,
  people_sensitive_reference_count bigint,
  workflow_reference_count bigint,
  process_reference_count bigint,
  view_column_reference_count bigint,
  view_filter_reference_count bigint,
  view_sort_reference_count bigint,
  view_board_presentation_reference_count bigint,
  view_calendar_presentation_reference_count bigint,
  work_settings_assignment_reference_count bigint,
  work_settings_due_reference_count bigint,
  work_settings_status_reference_count bigint,
  view_column_reference_names text[],
  view_filter_reference_names text[],
  view_sort_reference_names text[],
  view_board_presentation_reference_names text[],
  view_calendar_presentation_reference_names text[]
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  d record;
  v_field field_definitions%rowtype;
  v_effective_new_type text := p_new_type;
begin
  select * into v_field
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_field_definition_id;

  if not found then
    raise exception 'Field definition not found.';
  end if;

  select * into d
  from private.field_definition_type_change_dependencies(
    p_workspace_id,
    p_entity_type_id,
    p_field_definition_id
  );

  record_value_count := d.record_value_count;
  relation_value_count := d.relation_value_count;
  choice_option_count := d.choice_option_count;
  display_field_reference_count := d.display_field_reference_count;
  quality_review_reference_count := d.quality_review_reference_count;
  people_sensitive_reference_count := d.people_sensitive_reference_count;
  workflow_reference_count := d.workflow_reference_count;
  process_reference_count := d.process_reference_count;

  select
    count(distinct view.id),
    coalesce(array_agg(distinct view.name order by view.name), array[]::text[])
  into view_column_reference_count, view_column_reference_names
  from entity_views view
  where view.workspace_id = p_workspace_id
    and view.entity_type_id = p_entity_type_id
    and exists (
      select 1
      from jsonb_array_elements_text(coalesce(view.column_field_definition_ids, '[]'::jsonb)) column_field_definition_id
      where column_field_definition_id = p_field_definition_id::text
    );

  select
    count(distinct view.id),
    coalesce(array_agg(distinct view.name order by view.name), array[]::text[])
  into view_filter_reference_count, view_filter_reference_names
  from entity_views view
  where view.workspace_id = p_workspace_id
    and view.entity_type_id = p_entity_type_id
    and exists (
      select 1
      from jsonb_array_elements(coalesce(view.filters, '[]'::jsonb)) filter
      where filter ->> 'fieldDefinitionId' = p_field_definition_id::text
    );

  select
    count(distinct view.id),
    coalesce(array_agg(distinct view.name order by view.name), array[]::text[])
  into view_sort_reference_count, view_sort_reference_names
  from entity_views view
  where view.workspace_id = p_workspace_id
    and view.entity_type_id = p_entity_type_id
    and exists (
      select 1
      from jsonb_array_elements(coalesce(view.sorts, '[]'::jsonb)) sort
      where sort ->> 'fieldDefinitionId' = p_field_definition_id::text
    );

  select
    count(distinct view.id),
    coalesce(array_agg(distinct view.name order by view.name), array[]::text[])
  into view_board_presentation_reference_count, view_board_presentation_reference_names
  from entity_views view
  where view.workspace_id = p_workspace_id
    and view.entity_type_id = p_entity_type_id
    and view.presentation_mode = 'board'
    and view.presentation_config ->> 'choiceFieldDefinitionId' = p_field_definition_id::text
    and coalesce(v_effective_new_type, case when v_field.type = 'choice' then 'not_choice' else v_field.type end) <> 'choice';

  select
    count(distinct view.id),
    coalesce(array_agg(distinct view.name order by view.name), array[]::text[])
  into view_calendar_presentation_reference_count, view_calendar_presentation_reference_names
  from entity_views view
  where view.workspace_id = p_workspace_id
    and view.entity_type_id = p_entity_type_id
    and view.presentation_mode = 'calendar'
    and view.presentation_config ->> 'dateFieldDefinitionId' = p_field_definition_id::text
    and coalesce(v_effective_new_type, case when v_field.type = 'date' then 'not_date' else v_field.type end) <> 'date';

  select
    count(*) filter (where work_assignment_field_id = p_field_definition_id),
    count(*) filter (where work_due_field_id = p_field_definition_id),
    count(*) filter (where work_status_field_id = p_field_definition_id)
  into
    work_settings_assignment_reference_count,
    work_settings_due_reference_count,
    work_settings_status_reference_count
  from entity_types
  where workspace_id = p_workspace_id
    and id = p_entity_type_id;

  pristine := record_value_count = 0
    and relation_value_count = 0
    and choice_option_count = 0
    and display_field_reference_count = 0
    and quality_review_reference_count = 0
    and people_sensitive_reference_count = 0
    and workflow_reference_count = 0
    and process_reference_count = 0
    and view_filter_reference_count = 0
    and view_sort_reference_count = 0
    and view_board_presentation_reference_count = 0
    and view_calendar_presentation_reference_count = 0
    and work_settings_assignment_reference_count = 0
    and work_settings_due_reference_count = 0
    and work_settings_status_reference_count = 0;

  return next;
end;
$$;

revoke all on function private.field_definition_type_change_dependencies_typed(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.field_definition_type_change_dependencies_typed(uuid, uuid, uuid, text) to service_role;

create function get_field_definition_type_change_preflight_v2_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns table (
  pristine boolean,
  record_value_count bigint,
  relation_value_count bigint,
  choice_option_count bigint,
  display_field_reference_count bigint,
  quality_review_reference_count bigint,
  people_sensitive_reference_count bigint,
  workflow_reference_count bigint,
  process_reference_count bigint,
  view_column_reference_count bigint,
  view_filter_reference_count bigint,
  view_sort_reference_count bigint,
  view_board_presentation_reference_count bigint,
  view_calendar_presentation_reference_count bigint,
  work_settings_assignment_reference_count bigint,
  work_settings_due_reference_count bigint,
  work_settings_status_reference_count bigint,
  view_column_reference_names text[],
  view_filter_reference_names text[],
  view_sort_reference_names text[],
  view_board_presentation_reference_names text[],
  view_calendar_presentation_reference_names text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  if not exists (
    select 1
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_field_definition_id
      and archived_at is null
  ) then
    raise exception 'Field definition not found.';
  end if;

  return query
  select * from private.field_definition_type_change_dependencies_typed(
    p_workspace_id,
    p_entity_type_id,
    p_field_definition_id,
    null
  );
end;
$$;

create function change_field_definition_type_if_safe_v2_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid,
  p_new_type text,
  p_new_related_entity_type_id uuid
)
returns table (
  changed boolean,
  record_value_count bigint,
  relation_value_count bigint,
  choice_option_count bigint,
  display_field_reference_count bigint,
  quality_review_reference_count bigint,
  people_sensitive_reference_count bigint,
  workflow_reference_count bigint,
  process_reference_count bigint,
  view_column_reference_count bigint,
  view_filter_reference_count bigint,
  view_sort_reference_count bigint,
  view_board_presentation_reference_count bigint,
  view_calendar_presentation_reference_count bigint,
  work_settings_assignment_reference_count bigint,
  work_settings_due_reference_count bigint,
  work_settings_status_reference_count bigint,
  view_column_reference_names text[],
  view_filter_reference_names text[],
  view_sort_reference_names text[],
  view_board_presentation_reference_names text[],
  view_calendar_presentation_reference_names text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_field field_definitions%rowtype;
  v_entity entity_types%rowtype;
  v_old_type text;
  v_old_related_entity_type_id uuid;
  d record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  if p_new_type not in ('text', 'number', 'date', 'boolean', 'relation', 'choice', 'workspace_member') then
    raise exception 'Unsupported field type: %', p_new_type;
  end if;

  if p_new_type = 'relation' and p_new_related_entity_type_id is null then
    raise exception 'Relation fields require a related entity type';
  end if;

  if p_new_type <> 'relation' and p_new_related_entity_type_id is not null then
    raise exception 'Only relation fields may declare a related entity type';
  end if;

  if p_new_type = 'relation' and not exists (
    select 1
    from entity_types
    where workspace_id = p_workspace_id
      and id = p_new_related_entity_type_id
      and archived_at is null
  ) then
    raise exception 'Relation fields must target an active object.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  select * into v_entity
  from entity_types
  where workspace_id = p_workspace_id
    and id = p_entity_type_id
  for update;
  if not found then
    raise exception 'Entity type not found.';
  end if;

  select * into v_field
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_field_definition_id
  for update;
  if not found or v_field.archived_at is not null then
    raise exception 'Field definition not found.';
  end if;

  if v_field.type = p_new_type then
    raise exception 'Field is already this type.';
  end if;

  select * into d
  from private.field_definition_type_change_dependencies_typed(
    p_workspace_id,
    p_entity_type_id,
    p_field_definition_id,
    p_new_type
  );

  if d.pristine then
    v_old_type := v_field.type;
    v_old_related_entity_type_id := v_field.related_entity_type_id;

    update field_definitions
    set type = p_new_type,
        related_entity_type_id = p_new_related_entity_type_id,
        updated_at = now()
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_field_definition_id;

    perform private.governance_audit_insert(
      p_workspace_id, 'field_type_changed', 'field', v_field.id, v_field.name, null, null, v_entity.id, v_entity.name,
      jsonb_build_object(
        'old', jsonb_build_object('type', v_old_type, 'relatedEntityTypeId', v_old_related_entity_type_id),
        'new', jsonb_build_object('type', p_new_type, 'relatedEntityTypeId', p_new_related_entity_type_id)
      )
    );
  end if;

  return query select d.pristine, d.record_value_count, d.relation_value_count,
    d.choice_option_count, d.display_field_reference_count,
    d.quality_review_reference_count, d.people_sensitive_reference_count,
    d.workflow_reference_count, d.process_reference_count,
    d.view_column_reference_count, d.view_filter_reference_count,
    d.view_sort_reference_count, d.view_board_presentation_reference_count,
    d.view_calendar_presentation_reference_count,
    d.work_settings_assignment_reference_count,
    d.work_settings_due_reference_count,
    d.work_settings_status_reference_count,
    d.view_column_reference_names, d.view_filter_reference_names,
    d.view_sort_reference_names, d.view_board_presentation_reference_names,
    d.view_calendar_presentation_reference_names;
end;
$$;

revoke all on function get_field_definition_type_change_preflight_v2_authorized(uuid, uuid, uuid) from public;
revoke all on function change_field_definition_type_if_safe_v2_authorized(uuid, uuid, uuid, text, uuid) from public;
grant execute on function get_field_definition_type_change_preflight_v2_authorized(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function change_field_definition_type_if_safe_v2_authorized(uuid, uuid, uuid, text, uuid) to authenticated, service_role;

comment on function private.field_definition_type_change_dependencies_typed(uuid, uuid, uuid, text)
  is 'Typed Phase 1 dependency surface for pristine field type changes. Table-column saved-view references are reported but non-blocking; filters, sorts, Board/Calendar presentation config, Work Settings mappings, and existing value/config/process protections block.';
comment on function get_field_definition_type_change_preflight_v2_authorized(uuid, uuid, uuid)
  is 'schema.manage-checked informational preflight for typed field type-change dependencies. Never authoritative; mutation re-checks under the entity-type advisory lock.';
comment on function change_field_definition_type_if_safe_v2_authorized(uuid, uuid, uuid, text, uuid)
  is 'schema.manage-checked, governance-audited pristine field type change with typed dependency reporting. Re-checks dependencies under entity-type advisory lock and row locks before mutating.';
