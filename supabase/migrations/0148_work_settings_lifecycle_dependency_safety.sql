-- Record Work / Work Settings v1a -- lifecycle/dependency safety.
--
-- Extends the existing three-place dependency checklist (hard field delete,
-- pristine field-type recovery, Choice option hard delete) with Work
-- Settings references, plus a new fourth protection this feature requires
-- for the first time in this codebase: blocking field ARCHIVAL.
--
-- Archival is blocked (unlike every prior configured-field precedent --
-- people-sensitive subject/author, Quality Review status/draft/finalized --
-- none of which block archival today) because those only ever need
-- read-time correctness, which archival never disturbs (they resolve
-- values by field ID directly, never filtered on the field's own
-- archived_at). Work Settings is different in kind: 0144's
-- apply_workspace_member_record_values requires archived_at is null to
-- accept a new value, so archiving the assignment field would silently
-- make an enabled Work Settings configuration permanently unable to accept
-- any further assignment/reassignment -- exactly the "operationally
-- unusable" outcome this migration exists to prevent.
--
-- All checks apply whether work_enabled is true or false: the FK already
-- protects the mapping unconditionally (0146), so these friendly checks
-- follow the same posture for consistency -- a dormant mapping is still a
-- real, persisted dependency.
--
-- Every function below is reproduced in full from its authoritative
-- current source before modification, per the established immutable-
-- migration convention: 0116 (archive), 0143 (delete_field_definition_if_
-- safe, field_definition_type_change_dependencies), 0137 (delete_field_
-- choice_option_if_safe / its _authorized wrapper). No return-shape change
-- is made to delete_field_definition_if_safe or field_definition_type_
-- change_dependencies (the new check folds into an existing bucket,
-- exactly the technique 0143 itself used for its own workspace_member
-- extension of these same two functions), so their respective wrapper
-- functions (delete_field_definition_if_safe_authorized, change_field_
-- definition_type_if_safe_authorized) need no changes and are not touched.
-- delete_field_choice_option_if_safe and its _authorized wrapper DO gain a
-- new named column (work_completion_reference_count) since folding a
-- Work-Settings-specific reason into the existing quality_review_
-- reference_count bucket would be actively misleading -- both are
-- therefore dropped and recreated together, the only pair in this
-- migration with a return-shape change.

-- 1. Archival block (source: 0116).
create or replace function archive_field_definition_authorized(p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f field_definitions%rowtype; e entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into f from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found.'; end if;
  select * into e from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  if exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id and id = p_entity_type_id
      and (
        work_assignment_field_id = p_field_definition_id
        or work_due_field_id = p_field_definition_id
        or work_status_field_id = p_field_definition_id
      )
  ) then
    raise exception 'This field is used by Work Settings and cannot be archived while configured. Update Work Settings first.';
  end if;
  if f.archived_at is null then
    update field_definitions set archived_at = now(), updated_at = now() where workspace_id = p_workspace_id and id = p_field_definition_id;
    perform private.governance_audit_insert(p_workspace_id, 'field_archived', 'field', f.id, f.name, null, null, e.id, e.name,
      jsonb_build_object('old', jsonb_build_object('archived_at', null), 'new', jsonb_build_object('archived_at', now())));
  end if;
end;
$$;

-- 2. Hard field delete (source: 0143). Reproduced in full, folding a new
-- Work Settings reference check into display_field_reference_count -- the
-- existing bucket for "this field is referenced by a column directly on
-- its own entity_types row," which is exactly what work_assignment_field_
-- id/work_due_field_id/work_status_field_id are. No new column, no return-
-- shape change, no wrapper cascade -- same technique 0143 itself used to
-- fold Workspace Member values into relation_value_count.
create or replace function delete_field_definition_if_safe(
  p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid
)
returns table (
  deleted boolean, record_value_count bigint, relation_value_count bigint, workflow_reference_count bigint,
  display_field_reference_count bigint, view_reference_count bigint, process_branch_reference_count bigint
)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_field field_definitions%rowtype;
  v_template_token text;
  v_process_branch_reference_count bigint := 0;
  v_workspace_member_value_count bigint := 0;
  v_work_settings_reference_count bigint := 0;
begin
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found.'; end if;

  select count(*) into record_value_count from entity_records
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and values ? v_field.key;
  select count(*) into relation_value_count from entity_record_relation_values
  where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and field_definition_id = p_field_definition_id;
  select count(*) into v_workspace_member_value_count from entity_record_workspace_member_values
  where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and field_definition_id = p_field_definition_id;
  relation_value_count := relation_value_count + v_workspace_member_value_count;
  select count(*) into display_field_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id and display_field_definition_id = p_field_definition_id;
  select count(*) into v_work_settings_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
    and (
      work_assignment_field_id = p_field_definition_id
      or work_due_field_id = p_field_definition_id
      or work_status_field_id = p_field_definition_id
    );
  display_field_reference_count := display_field_reference_count + v_work_settings_reference_count;
  v_template_token := '{{field:' || p_field_definition_id::text || '}}';
  select count(*) into workflow_reference_count from workflows workflow
  where workflow.workspace_id = p_workspace_id and (
    exists (select 1 from jsonb_array_elements_text(coalesce(workflow.action_config #> '{triggerConfig,watchedFieldDefinitionIds}', '[]'::jsonb)) watched(field_definition_id) where watched.field_definition_id = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(coalesce(workflow.action_config -> 'conditions', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(workflow.actions) action where action ->> 'relatedFieldDefinitionId' = p_field_definition_id::text or exists (
      select 1 from jsonb_array_elements(coalesce(action -> 'fieldMappings', '[]'::jsonb)) mapping
      where mapping ->> 'targetFieldDefinitionId' = p_field_definition_id::text
        or mapping #>> '{source,sourceFieldDefinitionId}' = p_field_definition_id::text
        or coalesce(mapping #>> '{source,template}', '') like '%' || v_template_token || '%'
    ))
  );
  select count(*) into view_reference_count from entity_views view
  where view.workspace_id = p_workspace_id and view.entity_type_id = p_entity_type_id and (
    exists (select 1 from jsonb_array_elements(coalesce(view.filters, '[]'::jsonb)) filter where filter ->> 'fieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(coalesce(view.sorts, '[]'::jsonb)) sort where sort ->> 'fieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements_text(coalesce(view.column_field_definition_ids, '[]'::jsonb)) column_field_definition_id where column_field_definition_id = p_field_definition_id::text)
  );
  select count(*) into v_process_branch_reference_count
  from process_edges edge join process_templates template on template.workspace_id = edge.workspace_id and template.id = edge.process_template_id
  where edge.workspace_id = p_workspace_id and template.applies_to_entity_type_id = p_entity_type_id
    and exists (select 1 from jsonb_array_elements(coalesce(edge.condition_config, '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text);
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_step_run_routes route
  join process_step_runs source_step on source_step.workspace_id = route.workspace_id and source_step.id = route.source_step_run_id
  join process_runs run on run.workspace_id = route.workspace_id and run.id = route.process_run_id
  where route.workspace_id = p_workspace_id and run.origin_entity_type_id = p_entity_type_id and run.status = 'active' and source_step.status in ('pending', 'active')
    and exists (select 1 from jsonb_array_elements(coalesce(route.condition_config, '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text);
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_nodes node join process_templates template on template.workspace_id = node.workspace_id and template.id = node.process_template_id
  where node.workspace_id = p_workspace_id and node.node_type = 'condition_wait' and (
    (template.applies_to_entity_type_id = p_entity_type_id and exists (select 1 from jsonb_array_elements(coalesce(node.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or (node.config #>> '{condition_wait_rule,target,target_entity_type_id}' = p_entity_type_id::text and exists (select 1 from jsonb_array_elements(coalesce(node.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or node.config #>> '{condition_wait_rule,target,relation_field_definition_id}' = p_field_definition_id::text
  );
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_step_runs step join process_runs run on run.workspace_id = step.workspace_id and run.id = step.process_run_id
  where step.workspace_id = p_workspace_id and step.node_type = 'condition_wait' and step.status in ('pending', 'active') and run.status = 'active' and (
    (run.origin_entity_type_id = p_entity_type_id and exists (select 1 from jsonb_array_elements(coalesce(step.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or (step.config #>> '{condition_wait_rule,target,target_entity_type_id}' = p_entity_type_id::text and exists (select 1 from jsonb_array_elements(coalesce(step.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or step.config #>> '{condition_wait_rule,target,relation_field_definition_id}' = p_field_definition_id::text
  );
  process_branch_reference_count := v_process_branch_reference_count;
  if record_value_count = 0 and relation_value_count = 0 and workflow_reference_count = 0 and display_field_reference_count = 0 and view_reference_count = 0 and v_process_branch_reference_count = 0 then
    delete from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id;
    deleted := true;
  else
    deleted := false;
  end if;
  return next;
end;
$$;

-- 3. Pristine field-type recovery dependencies (source: 0143). Reproduced
-- in full, folding a new Work Settings reference check into pristine --
-- same technique 0143 itself used for workspace_member here. No new
-- column, no return-shape change, no wrapper cascade
-- (change_field_definition_type_if_safe_authorized is unaffected).
create or replace function private.field_definition_type_change_dependencies(
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
  view_reference_count bigint,
  workflow_reference_count bigint,
  process_reference_count bigint
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  d record;
  v_workspace_member_value_count bigint := 0;
  v_work_settings_reference_count bigint := 0;
begin
  select * into d
  from private.field_definition_type_change_dependencies_pre_workspace_member(
    p_workspace_id,
    p_entity_type_id,
    p_field_definition_id
  );

  select count(*) into v_workspace_member_value_count
  from entity_record_workspace_member_values
  where workspace_id = p_workspace_id
    and source_entity_type_id = p_entity_type_id
    and field_definition_id = p_field_definition_id;

  select count(*) into v_work_settings_reference_count
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
    and (
      work_assignment_field_id = p_field_definition_id
      or work_due_field_id = p_field_definition_id
      or work_status_field_id = p_field_definition_id
    );

  record_value_count := d.record_value_count;
  relation_value_count := d.relation_value_count + v_workspace_member_value_count;
  choice_option_count := d.choice_option_count;
  display_field_reference_count := d.display_field_reference_count;
  quality_review_reference_count := d.quality_review_reference_count;
  people_sensitive_reference_count := d.people_sensitive_reference_count;
  view_reference_count := d.view_reference_count;
  workflow_reference_count := d.workflow_reference_count;
  process_reference_count := d.process_reference_count;
  pristine := d.pristine and v_workspace_member_value_count = 0 and v_work_settings_reference_count = 0;

  return next;
end;
$$;

-- 4. Choice option hard delete (source: 0137). A genuinely new, honestly-
-- named reason (folding into quality_review_reference_count would be
-- misleading), so both this function and its _authorized wrapper are
-- dropped and recreated with the added column -- the only return-shape
-- change in this migration, fully traced: these are the function's only
-- two definitions/callers in the migration chain.
drop function if exists delete_field_choice_option_if_safe(uuid, uuid, uuid);
drop function if exists delete_field_choice_option_if_safe_authorized(uuid, uuid, uuid);

create function delete_field_choice_option_if_safe(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid
)
returns table (
  deleted boolean,
  record_value_count bigint,
  view_reference_count bigint,
  quality_review_reference_count bigint,
  work_completion_reference_count bigint
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_field field_definitions%rowtype;
  v_option field_choice_options%rowtype;
begin
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id
    and id = p_field_definition_id
    and type = 'choice';

  if not found then
    raise exception 'Choice field not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_field.entity_type_id::text, 0));

  select * into v_option from field_choice_options
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_option_id
  for update;

  if not found then
    raise exception 'Choice option not found';
  end if;

  if v_option.archived_at is null then
    raise exception 'Choice option must be archived before it can be permanently deleted.';
  end if;

  select count(*) into record_value_count from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = v_field.entity_type_id
    and values ->> v_field.key = p_option_id::text;

  select count(*) into view_reference_count from entity_views view
  where view.workspace_id = p_workspace_id
    and view.entity_type_id = v_field.entity_type_id
    and exists (
      select 1 from jsonb_array_elements(coalesce(view.filters, '[]'::jsonb)) f
      where f ->> 'fieldDefinitionId' = p_field_definition_id::text
        and f ->> 'value' = p_option_id::text
    );

  select count(*) into quality_review_reference_count from entity_types et
  where et.workspace_id = p_workspace_id
    and (et.quality_review_draft_option_id = p_option_id or et.quality_review_finalized_option_id = p_option_id);

  select count(*) into work_completion_reference_count from entity_type_work_completion_options c
  where c.workspace_id = p_workspace_id
    and c.status_field_id = p_field_definition_id
    and c.option_id = p_option_id;

  if record_value_count = 0 and view_reference_count = 0 and quality_review_reference_count = 0 and work_completion_reference_count = 0 then
    delete from field_choice_options
    where workspace_id = p_workspace_id and id = p_option_id;
    deleted := true;
  else
    deleted := false;
  end if;

  return next;
end;
$$;

revoke all on function delete_field_choice_option_if_safe(uuid, uuid, uuid) from public, authenticated;
grant execute on function delete_field_choice_option_if_safe(uuid, uuid, uuid) to service_role;

create function delete_field_choice_option_if_safe_authorized(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid
)
returns table (
  deleted boolean,
  record_value_count bigint,
  view_reference_count bigint,
  quality_review_reference_count bigint,
  work_completion_reference_count bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o field_choice_options%rowtype;
  f field_definitions%rowtype;
  e entity_types%rowtype;
  result record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  select * into o from field_choice_options
  where workspace_id = p_workspace_id and field_definition_id = p_field_definition_id and id = p_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;

  select * into f from field_definitions where workspace_id = p_workspace_id and id = p_field_definition_id;
  select * into e from entity_types where workspace_id = p_workspace_id and id = f.entity_type_id;

  select * into result from public.delete_field_choice_option_if_safe(p_workspace_id, p_field_definition_id, p_option_id);

  if result.deleted then
    perform private.governance_audit_insert(
      p_workspace_id, 'choice_option_deleted', 'choice_option', o.id, o.label,
      f.id, f.name, e.id, e.name,
      jsonb_build_object('old', jsonb_build_object('label', o.label), 'new', null)
    );
  end if;

  return query select result.deleted, result.record_value_count, result.view_reference_count, result.quality_review_reference_count, result.work_completion_reference_count;
end;
$$;

revoke all on function delete_field_choice_option_if_safe_authorized(uuid, uuid, uuid) from public;
grant execute on function delete_field_choice_option_if_safe_authorized(uuid, uuid, uuid) to authenticated, service_role;
