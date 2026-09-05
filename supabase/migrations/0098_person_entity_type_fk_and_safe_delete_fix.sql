-- Corrective migration for 0097. Applied migrations are immutable -- 0097
-- itself is untouched by this file.
--
-- Defect: 0097 defined workspaces_person_entity_type_fk as a composite FK
--   foreign key (id, person_entity_type_id) references entity_types (workspace_id, id)
--   on delete set null
-- Confirmed by direct inspection of the applied 0097 SQL -- the description
-- given matched exactly, not assumed. For a composite FK, Postgres's
-- ON DELETE SET NULL (MATCH SIMPLE, the default) nulls *every* local column
-- of the FK on the matching referencing row, not just the column that
-- conceptually "points at" the deleted row. Here the local columns are
-- (workspaces.id, workspaces.person_entity_type_id) -- so the instant any
-- entity_types row currently designated as some workspace's Person type is
-- deleted, Postgres would attempt to null *both* columns on that
-- workspaces row, including workspaces.id, which is the table's primary
-- key and NOT NULL. That update can never succeed; the deletion would fail
-- with a raw, confusing constraint violation rather than either (a) a
-- clean, deliberate block, or (b) the graceful "clear the designation"
-- behavior SET NULL was presumably chosen to express. In practice this
-- could only ever fire while deleting a zero-record entity type (any type
-- with records is already blocked by delete_entity_type_if_safe's own
-- record_count check), but "only reachable in a narrow case" does not make
-- a guaranteed-to-fail, wrong-shaped constraint action acceptable.
--
-- Fix: replace the FK's delete action with RESTRICT -- structurally
-- identical composite FK (cross-workspace designation remains impossible),
-- but the currently-designated Person EntityType simply cannot be deleted
-- at all while it holds that designation, with no attempt to null
-- anything. The designation is never silently cleared as a side effect;
-- it must be explicitly cleared first (already required whenever any
-- entity_record_person_links row exists, per 0097's
-- set_person_entity_type_authorized; RESTRICT extends the same
-- explicit-first-then-mutate discipline to the case where zero links exist
-- yet but the type is still the live designation).
alter table workspaces
  drop constraint workspaces_person_entity_type_fk;
alter table workspaces
  add constraint workspaces_person_entity_type_fk
  foreign key (id, person_entity_type_id)
  references entity_types (workspace_id, id)
  on delete restrict;

-- delete_entity_type_if_safe(_authorized): the RESTRICT above means
-- attempting to hard-delete the currently designated Person EntityType now
-- fails with a raw FK violation instead of the wrong-shaped SET NULL
-- failure -- better, but still not the friendly, countable "here is why
-- this can't be deleted" shape every other safe-delete reason in this
-- function already gets. Full latest bodies (0027_process_templates_and_
-- runs.sql for the base function; 0048_metadata_workflow_capability_
-- policies.sql for the authorized wrapper, a create-or-replace over the
-- same 0027 return shape) copied faithfully below, widened with one new
-- counted reference -- person_type_designation_count -- alongside the
-- existing record/relation-field/workflow-target/process-template counts.
-- Nothing else about the function changes. Return shape changes (a new
-- output column), so both functions are dropped and recreated, exactly as
-- 0027 itself did for the same reason.
drop function if exists delete_entity_type_if_safe_authorized(uuid, uuid);
drop function if exists delete_entity_type_if_safe(uuid, uuid);

create function delete_entity_type_if_safe(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns table (
  deleted boolean,
  record_count integer,
  relation_field_count integer,
  workflow_target_count integer,
  process_template_count integer,
  person_type_designation_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_record_count integer := 0;
  v_relation_field_count integer := 0;
  v_workflow_target_count integer := 0;
  v_process_template_count integer := 0;
  v_person_type_designation_count integer := 0;
begin
  if not exists (
    select 1
    from entity_types
    where workspace_id = p_workspace_id
      and id = p_entity_type_id
  ) then
    raise exception 'Entity type not found';
  end if;

  select count(*)
    into v_record_count
  from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id;

  select count(*)
    into v_relation_field_count
  from field_definitions
  where workspace_id = p_workspace_id
    and related_entity_type_id = p_entity_type_id;

  select count(*)
    into v_workflow_target_count
  from workflows workflow
  where workflow.workspace_id = p_workspace_id
    and exists (
      select 1
      from jsonb_array_elements(workflow.actions) action
      where action ->> 'actionType' = 'create_record'
        and action ->> 'actionTargetEntityTypeId' = p_entity_type_id::text
    );

  select count(*)
    into v_process_template_count
  from process_templates
  where workspace_id = p_workspace_id
    and applies_to_entity_type_id = p_entity_type_id;

  select count(*)
    into v_person_type_designation_count
  from workspaces
  where id = p_workspace_id
    and person_entity_type_id = p_entity_type_id;

  if v_record_count > 0
    or v_relation_field_count > 0
    or v_workflow_target_count > 0
    or v_process_template_count > 0
    or v_person_type_designation_count > 0 then
    return query select
      false, v_record_count, v_relation_field_count,
      v_workflow_target_count, v_process_template_count,
      v_person_type_designation_count;
    return;
  end if;

  delete from entity_types
  where workspace_id = p_workspace_id
    and id = p_entity_type_id;

  return query select true, 0, 0, 0, 0, 0;
end;
$$;

create function delete_entity_type_if_safe_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns table (
  deleted boolean,
  record_count integer,
  relation_field_count integer,
  workflow_target_count integer,
  process_template_count integer,
  person_type_designation_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  return query select * from delete_entity_type_if_safe(p_workspace_id, p_entity_type_id);
end;
$$;

revoke all on function delete_entity_type_if_safe(uuid, uuid) from public, authenticated;
grant execute on function delete_entity_type_if_safe(uuid, uuid) to service_role;

revoke all on function delete_entity_type_if_safe_authorized(uuid, uuid) from public, anon;
grant execute on function delete_entity_type_if_safe_authorized(uuid, uuid) to authenticated, service_role;

comment on function delete_entity_type_if_safe(uuid, uuid)
  is 'Safely hard-deletes an entity type. Blocks deletion when it has records, incoming relation fields, workflow create-record targets, applicable process templates, or is the workspace''s designated Person type.';
