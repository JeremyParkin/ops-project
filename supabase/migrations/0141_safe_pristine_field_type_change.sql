-- Phase: safe pristine-only field-type recovery.
--
-- Product problem: field type has always been immutable after creation
-- (docs/PROJECT_CONTEXT.md's own "No field type changes" limitation), and
-- dogfood surfaced a real recovery gap for a builder who picks the wrong
-- type before any data/config depends on it. This migration adds a single
-- narrow, authoritative recovery path: an in-place type change permitted
-- ONLY when the backend proves, under lock, that the field is genuinely
-- pristine -- no record values (including archived), no relation rows, no
-- Choice options, no display-field designation, no Quality Review or
-- people-sensitive designation, no saved-view reference, no workflow
-- reference, no Process Template/live-run reference. Any other field is
-- left completely alone: no replacement workflow, no value migration, no
-- new UI beyond a truthful blocked-reason report. Existing Add Field /
-- Archive capabilities are unchanged.
--
-- This migration also closes three concurrency gaps discovered while
-- proving the above safe, without which "pristine" could not be an
-- authoritative claim (a dependency could otherwise appear between the
-- check and the mutation):
--   1. Choice-option create/update/archive/restore took no lock at all.
--   2. Process Template save took no lock relevant to field references.
--   3. Workflow create/update is raw authenticated table DML with no RPC
--      boundary at all (existing architecture, per 0100's own comment:
--      "Workflows are still direct-table writes... with no RPC boundary to
--      add a check to -- a BEFORE INSERT OR UPDATE trigger is the only
--      place this can be enforced"). A workflow can reference more than
--      one entity type (its trigger entity type, plus each ordered
--      action's own target entity type), so the fix enumerates every
--      distinct entity type the new row references and takes the shared
--      lock for each, in sorted order -- reusing the exact safe,
--      exception-free JSONB-to-entity_types join pattern already proven
--      live in this migration's neighbor, private.reject_people_sensitive_
--      workflow_target (0100): a text comparison against entity_types.id,
--      never a cast of caller-supplied JSONB to uuid, so a malformed or
--      foreign action-target id simply joins to nothing and is silently
--      skipped for locking purposes -- never a new exception, never a new
--      tenancy policy. Record/relation writes and saved-view writes
--      already participate in this exact lock protocol (0080 onward,
--      0137) and needed no change.
--
-- Everything below is additive. No existing migration is edited.

-- ============================================================================
-- 1. Governance: new event type for a successful pristine type change.
--
-- Deliberately its own event type, not a reuse of field_updated: every
-- other governance event in this system is one type per semantically
-- distinct operation (field_archived/restored/deleted are separate;
-- choice_option_archived/restored/deleted are separate), specifically so
-- an administrator scanning history can tell "someone renamed a field"
-- apart from "someone changed a field's type" -- a materially larger,
-- rarer, more consequential action. Full list rebuilt from the CURRENT
-- live definition (0138, the corrected one -- not 0137, which is exactly
-- how this project's own prior stale-constraint mistake happened), with
-- only 'field_type_changed' added, verified programmatically (see the
-- verification note in the implementation report, not repeated here).
-- ============================================================================

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
    'person_entity_type_changed'
  ));

-- ============================================================================
-- 2. Workflow advisory-lock trigger.
--
-- New trigger, additive; the existing workflows_automation_write RLS
-- policy (0048, automation.manage), the raw-DML write architecture, and
-- the existing workflows_reject_sensitive_target trigger (0100) are all
-- completely untouched. DELETE deliberately does not participate: removing
-- a workflow can only ever reduce a field's reference count, never
-- introduce a dependency, so it cannot cause the race this exists to
-- close (the identical reasoning already applies to every other writer in
-- this migration).
-- ============================================================================

create or replace function private.lock_workflow_referenced_entity_types()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entity_type_id uuid;
begin
  for v_entity_type_id in
    select distinct referenced.entity_type_id
    from (
      select new.trigger_entity_type_id as entity_type_id
      union
      select et.id as entity_type_id
      from jsonb_array_elements(new.actions) action
      join public.entity_types et
        on et.workspace_id = new.workspace_id
        and action ->> 'actionTargetEntityTypeId' = et.id::text
    ) referenced
    order by referenced.entity_type_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_entity_type_id::text, 0));
  end loop;

  return new;
end;
$$;

drop trigger if exists workflows_lock_referenced_entity_types on workflows;
create trigger workflows_lock_referenced_entity_types
  before insert or update on workflows
  for each row execute function private.lock_workflow_referenced_entity_types();

comment on function private.lock_workflow_referenced_entity_types()
  is 'Takes the shared entity-type advisory lock (hashtextextended(entity_type_id, 0)) for the trigger entity type and every ordered action target entity type a workflow row references, deduplicated and sorted, before the row is written -- closes the race where a new/edited workflow could introduce a field reference between a field-type-change RPC''s pristine check and its commit. Uses the same text-comparison join as workflows_reject_sensitive_target (0100) specifically so a malformed or foreign action-target id is silently skipped, never a new exception or tenancy policy.';

-- ============================================================================
-- 3. Choice-option writer lock hardening.
--
-- add/update/archive/restore_field_choice_option_core (renamed from their
-- original unsuffixed names by 0116; bodies unchanged since 0080) took no
-- lock of any kind. Each is redefined below with its existing body fully
-- preserved and only the minimum addition needed: resolve the field's
-- owning entity_type_id first, then take the same shared advisory lock
-- before mutating. Every existing validation message and behavior is
-- unchanged. swap_field_choice_option_positions (reorder) is deliberately
-- NOT touched: it can only ever operate on options that already exist,
-- which means the field is already non-pristine by definition before a
-- reorder is possible, so it can never be the write that makes a field
-- transition from pristine to non-pristine, and it takes no lock today for
-- this new lock to conflict with.
-- ============================================================================

create or replace function add_field_choice_option_core(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_label text,
  p_color text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_option_id uuid := gen_random_uuid();
  v_next_position integer;
  v_entity_type_id uuid;
begin
  select entity_type_id
    into v_entity_type_id
  from field_definitions
  where workspace_id = p_workspace_id
    and id = p_field_definition_id
    and type = 'choice';

  if not found then
    raise exception 'Choice field not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_entity_type_id::text, 0));

  select coalesce(max(position), 0) + 1
    into v_next_position
  from field_choice_options
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id;

  insert into field_choice_options (
    id, workspace_id, field_definition_id, label, color, position
  )
  values (
    v_option_id, p_workspace_id, p_field_definition_id, trim(p_label), p_color, v_next_position
  );

  return v_option_id;
end;
$$;

create or replace function update_field_choice_option_core(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid,
  p_label text,
  p_color text
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_entity_type_id uuid;
begin
  select entity_type_id
    into v_entity_type_id
  from field_definitions
  where workspace_id = p_workspace_id
    and id = p_field_definition_id;

  if not found then
    raise exception 'Choice option not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_entity_type_id::text, 0));

  update field_choice_options
  set label = trim(p_label),
      color = p_color,
      updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;
end;
$$;

create or replace function archive_field_choice_option_core(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_entity_type_id uuid;
begin
  select entity_type_id
    into v_entity_type_id
  from field_definitions
  where workspace_id = p_workspace_id
    and id = p_field_definition_id;

  if not found then
    raise exception 'Choice option not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_entity_type_id::text, 0));

  update field_choice_options
  set archived_at = now(), updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;
end;
$$;

create or replace function restore_field_choice_option_core(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_entity_type_id uuid;
begin
  select entity_type_id
    into v_entity_type_id
  from field_definitions
  where workspace_id = p_workspace_id
    and id = p_field_definition_id;

  if not found then
    raise exception 'Choice option not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_entity_type_id::text, 0));

  -- No collision guard needed here: the global (active-or-archived) label
  -- uniqueness index already guarantees no active option could ever have
  -- been created with this option's label while it was archived.
  update field_choice_options
  set archived_at = null, updated_at = now()
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_option_id;

  if not found then
    raise exception 'Choice option not found';
  end if;
end;
$$;

-- ============================================================================
-- 4. Process Template writer lock hardening.
--
-- save_process_template_authorized (0047) is a thin automation.manage
-- capability wrapper delegating to save_process_template_authorized_member
-- (the full condition-wait-processing body, unchanged since 0038). A
-- Process Template applies to exactly one entity type
-- (p_applies_to_entity_type_id, already a direct parameter -- no
-- enumeration needed, unlike workflows), so the lock is added to the small
-- wrapper only; the member function's complete body is untouched.
-- ============================================================================

create or replace function save_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_name text,
  p_description text,
  p_applies_to_entity_type_id uuid,
  p_steps jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');
  perform pg_advisory_xact_lock(hashtextextended(p_applies_to_entity_type_id::text, 0));
  return save_process_template_authorized_member(p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, p_steps);
end; $$;

-- ============================================================================
-- 5. Shared dependency-checking core for field type change.
--
-- SECURITY INVOKER, service_role-only -- mirrors the layered pattern
-- already established for delete_field_choice_option_if_safe (0137) and
-- delete_field_definition_if_safe: even if this were ever reachable
-- directly, it does no writes and is personally subject to ordinary table
-- grants. Both the read-only preflight and the authoritative mutation RPC
-- call this same function, so there is exactly one place the dependency
-- surface is defined. record_value_count, relation_value_count,
-- display_field_reference_count, view_reference_count, and
-- workflow_reference_count/process_reference_count reuse the exact query
-- shapes proven in delete_field_definition_if_safe (0038) -- record values
-- and process branches already count archived records/completed
-- steps-in-active-runs the same way deletion safety does. choice_option_
-- count, quality_review_reference_count, and people_sensitive_reference_
-- count are new: deletion safety never needed them (field_choice_options
-- cascade-deletes via FK, and QR/people-sensitive designation is guarded
-- separately by 0100/0105's own archive-blocking triggers), but a type
-- change needs them explicitly, since nothing else stops a field that is
-- still QR- or people-sensitive-designated, or that still has Choice
-- option rows (active or archived), from having its type mutated
-- underneath that designation/those rows.
-- ============================================================================

create function private.field_definition_type_change_dependencies(
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
  v_field field_definitions%rowtype;
  v_template_token text;
  v_process_reference_count bigint := 0;
begin
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id;

  if not found then
    raise exception 'Field definition not found.';
  end if;

  -- Primitive record values, active and archived alike (a record's stored
  -- values are never rewritten by archiving it).
  select count(*) into record_value_count from entity_records
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and values ? v_field.key;

  select count(*) into relation_value_count from entity_record_relation_values
  where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and field_definition_id = p_field_definition_id;

  select count(*) into choice_option_count from field_choice_options
  where workspace_id = p_workspace_id and field_definition_id = p_field_definition_id;

  select count(*) into display_field_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id and display_field_definition_id = p_field_definition_id;

  select count(*) into quality_review_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id and quality_review_status_field_id = p_field_definition_id;

  select count(*) into people_sensitive_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
    and (subject_person_field_id = p_field_definition_id or author_person_field_id = p_field_definition_id);

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

  select count(*) into v_process_reference_count
  from process_edges edge join process_templates template on template.workspace_id = edge.workspace_id and template.id = edge.process_template_id
  where edge.workspace_id = p_workspace_id and template.applies_to_entity_type_id = p_entity_type_id
    and exists (select 1 from jsonb_array_elements(coalesce(edge.condition_config, '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text);
  select v_process_reference_count + count(*) into v_process_reference_count
  from process_step_run_routes route
  join process_step_runs source_step on source_step.workspace_id = route.workspace_id and source_step.id = route.source_step_run_id
  join process_runs run on run.workspace_id = route.workspace_id and run.id = route.process_run_id
  where route.workspace_id = p_workspace_id and run.origin_entity_type_id = p_entity_type_id and run.status = 'active' and source_step.status in ('pending', 'active')
    and exists (select 1 from jsonb_array_elements(coalesce(route.condition_config, '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text);
  select v_process_reference_count + count(*) into v_process_reference_count
  from process_nodes node join process_templates template on template.workspace_id = node.workspace_id and template.id = node.process_template_id
  where node.workspace_id = p_workspace_id and node.node_type = 'condition_wait' and (
    (template.applies_to_entity_type_id = p_entity_type_id and exists (select 1 from jsonb_array_elements(coalesce(node.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or (node.config #>> '{condition_wait_rule,target,target_entity_type_id}' = p_entity_type_id::text and exists (select 1 from jsonb_array_elements(coalesce(node.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or node.config #>> '{condition_wait_rule,target,relation_field_definition_id}' = p_field_definition_id::text
  );
  select v_process_reference_count + count(*) into v_process_reference_count
  from process_step_runs step join process_runs run on run.workspace_id = step.workspace_id and run.id = step.process_run_id
  where step.workspace_id = p_workspace_id and step.node_type = 'condition_wait' and step.status in ('pending', 'active') and run.status = 'active' and (
    (run.origin_entity_type_id = p_entity_type_id and exists (select 1 from jsonb_array_elements(coalesce(step.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or (step.config #>> '{condition_wait_rule,target,target_entity_type_id}' = p_entity_type_id::text and exists (select 1 from jsonb_array_elements(coalesce(step.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or step.config #>> '{condition_wait_rule,target,relation_field_definition_id}' = p_field_definition_id::text
  );
  process_reference_count := v_process_reference_count;

  pristine := record_value_count = 0 and relation_value_count = 0 and choice_option_count = 0
    and display_field_reference_count = 0 and quality_review_reference_count = 0
    and people_sensitive_reference_count = 0 and view_reference_count = 0
    and workflow_reference_count = 0 and process_reference_count = 0;

  return next;
end;
$$;

revoke all on function private.field_definition_type_change_dependencies(uuid, uuid, uuid) from public, authenticated;
grant execute on function private.field_definition_type_change_dependencies(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 6. Read-only preflight. Informational only -- the UI uses this to decide
-- what to show, but it is never trusted as authority; the mutation RPC
-- below always re-derives the same result itself, under lock, before
-- acting.
-- ============================================================================

create function get_field_definition_type_change_preflight_authorized(
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
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  if not exists (
    select 1 from field_definitions
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id
  ) then
    raise exception 'Field definition not found.';
  end if;

  return query select * from private.field_definition_type_change_dependencies(p_workspace_id, p_entity_type_id, p_field_definition_id);
end;
$$;

-- ============================================================================
-- 7. Authoritative mutation RPC.
--
-- schema.manage, real-actor-bound (matches every other field/schema-editing
-- RPC -- schema editing stays real-actor-bound per 0068's documented
-- scope, not effective-user-aware). Lock ordering exactly as specified:
-- entity-type advisory lock, then the owning entity_types row (FOR
-- UPDATE -- this is what closes the display-field/QR/people-sensitive
-- designation races for free: those writers already take FOR UPDATE OF
-- entity_type or an ordinary UPDATE on the identical row, so Postgres's
-- own row-lock semantics serialize against them with no changes to those
-- RPCs at all), then the target field_definitions row, then the
-- authoritative re-check, then the mutation only if still pristine.
-- ============================================================================

create function change_field_definition_type_if_safe_authorized(
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
  view_reference_count bigint,
  workflow_reference_count bigint,
  process_reference_count bigint
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

  if p_new_type not in ('text', 'number', 'date', 'boolean', 'relation', 'choice') then
    raise exception 'Unsupported field type: %', p_new_type;
  end if;

  if p_new_type = 'relation' and p_new_related_entity_type_id is null then
    raise exception 'Relation fields require a related entity type';
  end if;

  if p_new_type <> 'relation' and p_new_related_entity_type_id is not null then
    raise exception 'Only relation fields may declare a related entity type';
  end if;

  -- 1. Entity-type advisory lock -- the same key/tag record writes,
  -- Choice-option writes, saved-view writes, Process Template saves, and
  -- workflow writes (via the new trigger above) all now share.
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  -- 2. Owning entity_types row lock.
  select * into v_entity from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
  for update;
  if not found then
    raise exception 'Entity type not found.';
  end if;

  -- 3. Target field_definitions row lock.
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id
  for update;
  if not found then
    raise exception 'Field definition not found.';
  end if;

  if v_field.type = p_new_type then
    raise exception 'Field is already this type.';
  end if;

  -- 4. Authoritative dependency re-check (never trusts an earlier preflight
  -- read -- re-derives the same result freshly, now under lock).
  select * into d from private.field_definition_type_change_dependencies(p_workspace_id, p_entity_type_id, p_field_definition_id);

  -- 5. Mutation only if still pristine. type and related_entity_type_id
  -- move together in the same statement -- the real
  -- field_definitions_relation_target_required CHECK constraint (0003)
  -- would reject a mismatched pair as a backstop regardless.
  if d.pristine then
    v_old_type := v_field.type;
    v_old_related_entity_type_id := v_field.related_entity_type_id;

    update field_definitions
    set type = p_new_type,
        related_entity_type_id = p_new_related_entity_type_id,
        updated_at = now()
    where workspace_id = p_workspace_id and id = p_field_definition_id;

    perform private.governance_audit_insert(
      p_workspace_id, 'field_type_changed', 'field', v_field.id, v_field.name, null, null, v_entity.id, v_entity.name,
      jsonb_build_object(
        'old', jsonb_build_object('type', v_old_type, 'relatedEntityTypeId', v_old_related_entity_type_id),
        'new', jsonb_build_object('type', p_new_type, 'relatedEntityTypeId', p_new_related_entity_type_id)
      )
    );
  end if;

  return query select d.pristine, d.record_value_count, d.relation_value_count, d.choice_option_count,
    d.display_field_reference_count, d.quality_review_reference_count, d.people_sensitive_reference_count,
    d.view_reference_count, d.workflow_reference_count, d.process_reference_count;
end;
$$;

revoke all on function get_field_definition_type_change_preflight_authorized(uuid, uuid, uuid) from public;
revoke all on function change_field_definition_type_if_safe_authorized(uuid, uuid, uuid, text, uuid) from public;
grant execute on function get_field_definition_type_change_preflight_authorized(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function change_field_definition_type_if_safe_authorized(uuid, uuid, uuid, text, uuid) to authenticated, service_role;

comment on function private.field_definition_type_change_dependencies(uuid, uuid, uuid)
  is 'Shared, SECURITY INVOKER, service_role-only dependency surface for field type-change safety: record values (including archived), relation rows, Choice options, display-field/Quality-Review/people-sensitive designation, saved-view references, workflow references, and Process Template/live-run references. Used identically by the read-only preflight and the authoritative mutation RPC so there is exactly one definition of "pristine".';
comment on function get_field_definition_type_change_preflight_authorized(uuid, uuid, uuid)
  is 'schema.manage-checked, read-only preflight for field type change. Informational only -- never authoritative; change_field_definition_type_if_safe_authorized always re-derives the same result itself under lock before mutating.';
comment on function change_field_definition_type_if_safe_authorized(uuid, uuid, uuid, text, uuid)
  is 'schema.manage-checked, governance-audited safe in-place field type change. Preserves field id/key. Permitted only when the field is genuinely pristine: no record values, relation rows, Choice options, display-field/Quality-Review/people-sensitive designation, saved-view reference, workflow reference, or Process reference. Lock order: entity-type advisory lock, owning entity_types row, target field_definitions row, then a fresh authoritative dependency re-check. type and related_entity_type_id are updated atomically; no data or configuration is migrated, created, or deleted.';
