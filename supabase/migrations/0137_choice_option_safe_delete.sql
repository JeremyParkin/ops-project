-- Phase 13.3: Choice-option permanent (safe) deletion, archive-first.
--
-- Product decision (dogfood): a builder should not have to carry a
-- mistaken Choice option forever, but the reversible-first lifecycle
-- (archive/restore) stays the default -- permanent deletion is only ever
-- offered on an already-archived option, and only succeeds when the
-- option has never become meaningfully referenced.
--
-- Investigation (see conversation history, not duplicated in comments
-- here) covered every persisted dependency on a Choice option id:
--   - entity_records.values (JSONB scalar, no FK) -- active AND archived
--     records, since archiving a record never rewrites its stored values;
--   - entity_views.filters[].value (JSONB, no FK) for a Choice "equals"/
--     "not_equals" filter;
--   - entity_types.quality_review_draft_option_id /
--     quality_review_finalized_option_id -- a REAL composite FK
--     (migration 0105, ON DELETE RESTRICT), kept here as a checked,
--     truthful reason rather than left to surface as a raw FK error;
--   - workflows/process branching do not reference Choice option ids at
--     all today (`choice: []` in both lib/domain/workflow-conditions.ts
--     and lib/domain/process-conditions.ts) -- revisit this function if
--     that ever changes;
--   - governance_audit_events/record_change_events snapshot label/color
--     as plain text at event time, not a live reference -- deletion-safe.
--
-- Concurrency: a builder deleting an option races against two other
-- writers that could otherwise leave a dangling reference behind --
-- concurrent record writes (create_entity_record_with_relations /
-- update_entity_record_with_relations, migration 0080) and concurrent
-- saved-view writes (previously raw table access, hardened below). Both
-- already take, or now take, the exact same
-- pg_advisory_xact_lock(hashtextextended(entity_type_id::text, 0)) this
-- delete path uses, so whichever side commits first is authoritative for
-- the other.
--
-- Raw-DELETE hardening: field_choice_options has carried its original
-- `for all` RLS policy (schema.manage) since migration 0080 with no
-- subsequent revoke -- unlike field_definitions (0025's
-- `revoke delete ... from authenticated`), a schema.manage caller could
-- issue a raw DELETE against this table directly today, bypassing every
-- dependency check below. Closed at the end of this migration with the
-- same surgical, DELETE-only revoke 0025 already established for
-- field_definitions -- add/update/archive/restore/reorder are untouched,
-- since none of them touch DELETE and this migration does not revoke
-- INSERT/UPDATE on field_choice_options.
--
-- entity_views hardening: create/update were, by design (0068's own
-- comment: "record archive/restore and all saved-view CRUD go through
-- these raw policies, not a wrapper function"), raw RLS-gated table
-- writes with zero locking and zero Choice-option existence validation.
-- That is exactly the gap that makes the concurrency race above possible,
-- so both paths move behind new SECURITY DEFINER wrappers that
-- (a) take the shared advisory lock, (b) validate every Choice filter
-- value still references an existing option, before (c) writing. The
-- authorization boundary is unchanged: entity_views has required
-- records.operate (not schema.manage), effective-user-aware for
-- impersonation, since migration 0068 altered entity_views_operate_write
-- to has_workspace_capability_as(..., current_effective_user(...)); the
-- new wrappers reproduce that exact check via
-- private.require_effective_interactive_workspace_capability, the same
-- helper create/update_entity_record_with_relations_authorized already
-- use for the identical capability. DELETE on entity_views is untouched
-- (removing a view can never introduce a new dangling reference).
--
-- set_entity_default_view (0017) is SECURITY INVOKER and depends on the
-- authenticated role's own UPDATE privilege on entity_views -- confirmed
-- by inspection to be the only other function that mutates entity_views
-- at all (grepped every migration for INSERT/UPDATE/DELETE on the table).
-- Revoking UPDATE without also converting this function would silently
-- break "set as default" on every view create/update. Redefined below as
-- SECURITY DEFINER with the same capability check added, exact existing
-- validation/body otherwise unchanged.

-- 1. Governance: new event type for successful permanent deletion, same
-- shape as 'field_deleted' (migration 0116).
alter table governance_audit_events
  drop constraint if exists governance_audit_events_event_type_check;

alter table governance_audit_events
  add constraint governance_audit_events_event_type_check check (event_type in (
    'field_created', 'field_updated', 'field_archived', 'field_restored', 'field_deleted',
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
    'quality_review_lifecycle_configured',
    'quality_review_presentation_configured'
  ));

-- 2. Inner dependency-checking function. SECURITY INVOKER -- if it were
-- ever reachable directly (it isn't: EXECUTE is revoked from
-- public/authenticated below, service_role only), it would still be
-- personally subject to the field_choice_options DELETE revoke at the
-- bottom of this migration. Mirrors delete_field_definition_if_safe's
-- shape (migration 0038) with one addition: the archive-first invariant
-- is enforced here, not only in the app action layer, so a direct
-- authorized-RPC call against an active option is refused by the
-- database itself.
create function delete_field_choice_option_if_safe(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid
)
returns table (
  deleted boolean,
  record_value_count bigint,
  view_reference_count bigint,
  quality_review_reference_count bigint
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_field field_definitions%rowtype;
  v_option field_choice_options%rowtype;
begin
  -- Resolve/validate field + entity first (no lock yet -- just need
  -- entity_type_id for the advisory-lock key, and to confirm this is a
  -- real Choice field on this workspace).
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id
    and id = p_field_definition_id
    and type = 'choice';

  if not found then
    raise exception 'Choice field not found';
  end if;

  -- Same entity-type advisory lock record create/update already take
  -- (migration 0080), acquired BEFORE any row lock so this can never
  -- deadlock against a concurrent record write over lock-acquisition
  -- order, and now also taken by create/update_entity_view_authorized
  -- below for the identical reason on the saved-view side.
  perform pg_advisory_xact_lock(hashtextextended(v_field.entity_type_id::text, 0));

  -- Lock/re-read the option itself.
  select * into v_option from field_choice_options
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id
    and id = p_option_id
  for update;

  if not found then
    raise exception 'Choice option not found';
  end if;

  -- Archive-first invariant, enforced here (not only in the app action)
  -- so direct authorized-RPC invocation of an active option cannot
  -- bypass it.
  if v_option.archived_at is null then
    raise exception 'Choice option must be archived before it can be permanently deleted.';
  end if;

  -- Dependency counts, all scoped to this workspace/field/option.
  select count(*) into record_value_count from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = v_field.entity_type_id
    and values ->> v_field.key = p_option_id::text;
  -- Active AND archived records both count: archiving a record never
  -- rewrites its stored values, so an archived record can still hold
  -- this option.

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
  -- Checked explicitly for a truthful combined reason, even though the
  -- real composite FK (migration 0105, ON DELETE RESTRICT) would also
  -- refuse this as a backstop if this check were ever skipped.

  if record_value_count = 0 and view_reference_count = 0 and quality_review_reference_count = 0 then
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

-- 3. Outer authorized wrapper. schema.manage, real-actor-bound (not
-- effective-user-aware) -- matches every other Choice-option/field
-- lifecycle RPC (migration 0116), since schema editing stays real-actor-
-- bound per 0068's own documented scope. Governance-audits only on an
-- actual deletion.
create function delete_field_choice_option_if_safe_authorized(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_option_id uuid
)
returns table (
  deleted boolean,
  record_value_count bigint,
  view_reference_count bigint,
  quality_review_reference_count bigint
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

  return query select result.deleted, result.record_value_count, result.view_reference_count, result.quality_review_reference_count;
end;
$$;

revoke all on function delete_field_choice_option_if_safe_authorized(uuid, uuid, uuid) from public;
grant execute on function delete_field_choice_option_if_safe_authorized(uuid, uuid, uuid) to authenticated, service_role;

-- 4. entity_views hardening: create/update move behind SECURITY DEFINER
-- wrappers that take the shared advisory lock and validate Choice filter
-- values, closing the concurrency window a raw, unlocked, unvalidated
-- table write left open. Authorization boundary reproduced exactly from
-- entity_views_operate_write (records.operate, effective-user-aware) via
-- the same helper create/update_entity_record_with_relations_authorized
-- already use.

create function create_entity_view_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_name text,
  p_filters jsonb,
  p_sorts jsonb,
  p_column_field_definition_ids jsonb
)
returns entity_views
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_view entity_views%rowtype;
  v_next_position integer;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  -- Do not trust caller-supplied ids merely because this function is
  -- SECURITY DEFINER: confirm the entity type genuinely belongs to this
  -- workspace before writing anything scoped to it.
  if not exists (
    select 1 from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id
  ) then
    raise exception 'Entity type not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) f
    join field_definitions fd on fd.workspace_id = p_workspace_id
      and fd.id = (f ->> 'fieldDefinitionId')::uuid and fd.type = 'choice'
    where f ->> 'value' is not null and f ->> 'value' <> ''
      and not exists (
        select 1 from field_choice_options co
        where co.workspace_id = p_workspace_id and co.field_definition_id = fd.id
          and co.id = (f ->> 'value')::uuid
      )
  ) then
    raise exception 'View filter references a Choice option that no longer exists';
  end if;

  select coalesce(max(position), 0) + 1 into v_next_position
  from entity_views where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id;

  insert into entity_views (
    id, workspace_id, entity_type_id, name, position, is_default, filters, sorts, column_field_definition_ids
  )
  values (
    gen_random_uuid(), p_workspace_id, p_entity_type_id, p_name, v_next_position, false,
    coalesce(p_filters, '[]'::jsonb), coalesce(p_sorts, '[]'::jsonb), coalesce(p_column_field_definition_ids, '[]'::jsonb)
  )
  returning * into v_view;

  return v_view;
end;
$$;

create function update_entity_view_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_view_id uuid,
  p_name text,
  p_filters jsonb,
  p_sorts jsonb,
  p_column_field_definition_ids jsonb
)
returns entity_views
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_view entity_views%rowtype;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) f
    join field_definitions fd on fd.workspace_id = p_workspace_id
      and fd.id = (f ->> 'fieldDefinitionId')::uuid and fd.type = 'choice'
    where f ->> 'value' is not null and f ->> 'value' <> ''
      and not exists (
        select 1 from field_choice_options co
        where co.workspace_id = p_workspace_id and co.field_definition_id = fd.id
          and co.id = (f ->> 'value')::uuid
      )
  ) then
    raise exception 'View filter references a Choice option that no longer exists';
  end if;

  -- The WHERE below already scopes by workspace_id + entity_type_id + id
  -- together, so a view_id from a different workspace/entity type simply
  -- matches no row -- confirmed by the explicit not-found check after.
  update entity_views
  set name = p_name,
      filters = coalesce(p_filters, '[]'::jsonb),
      sorts = coalesce(p_sorts, '[]'::jsonb),
      column_field_definition_ids = coalesce(p_column_field_definition_ids, '[]'::jsonb),
      updated_at = now()
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_view_id
  returning * into v_view;

  if not found then
    raise exception 'Entity view not found';
  end if;

  return v_view;
end;
$$;

revoke all on function create_entity_view_authorized(uuid, uuid, text, jsonb, jsonb, jsonb) from public;
revoke all on function update_entity_view_authorized(uuid, uuid, uuid, text, jsonb, jsonb, jsonb) from public;
grant execute on function create_entity_view_authorized(uuid, uuid, text, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function update_entity_view_authorized(uuid, uuid, uuid, text, jsonb, jsonb, jsonb) to authenticated, service_role;

-- 5. set_entity_default_view: redefined SECURITY DEFINER with the same
-- records.operate capability check added (it previously had none, relying
-- entirely on RLS). Body/validation otherwise byte-for-byte identical to
-- its existing definition (migration 0017) -- same signature, same call
-- site (lib/domain/view-repository.ts's setEntityDefaultView), no app
-- change needed beyond this redefinition.
create or replace function set_entity_default_view(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_view_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if not exists (
    select 1
    from entity_types
    where workspace_id = p_workspace_id
      and id = p_entity_type_id
  ) then
    raise exception 'Entity type not found.';
  end if;

  if p_view_id is not null and not exists (
    select 1
    from entity_views
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_view_id
  ) then
    raise exception 'Default view must belong to this entity.';
  end if;

  update entity_views
  set is_default = false,
      updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and is_default;

  if p_view_id is not null then
    update entity_views
    set is_default = true,
        updated_at = now()
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_view_id;
  end if;

  return p_view_id;
end;
$$;

comment on function set_entity_default_view(uuid, uuid, uuid)
  is 'Sets or clears the saved table view used as the default for an entity. The selected view must belong to the same workspace/entity. SECURITY DEFINER as of 0137 so it keeps working once direct authenticated UPDATE on entity_views is revoked below; records.operate is enforced explicitly since RLS no longer applies to its own writes.';

-- 6. Close the two raw-write gaps this migration's dependency guarantees
-- rely on. INSERT/UPDATE on entity_views are revoked (create/update now
-- go through the wrappers above); DELETE is untouched, since removing a
-- view can never introduce a new dangling Choice-option reference.
-- field_choice_options DELETE is revoked the same way 0025 already
-- revoked it for field_definitions; add/update/archive/restore/reorder
-- are unaffected (none of them touch DELETE, and INSERT/UPDATE on
-- field_choice_options are not revoked here).
revoke insert, update on table entity_views from authenticated;
revoke delete on table field_choice_options from authenticated;

comment on function delete_field_choice_option_if_safe(uuid, uuid, uuid)
  is 'Dependency-checked Choice-option deletion core. SECURITY INVOKER, service_role-only: even if ever reachable directly, still subject to the field_choice_options DELETE revoke below.';
comment on function delete_field_choice_option_if_safe_authorized(uuid, uuid, uuid)
  is 'schema.manage-checked, governance-audited wrapper for safe Choice-option deletion. Refuses an option that is not archived, or that is referenced by record values, a saved-view filter, or a Quality Review draft/finalized designation.';
comment on function create_entity_view_authorized(uuid, uuid, text, jsonb, jsonb, jsonb)
  is 'records.operate-checked (effective-user-aware) entity-view creation. Takes the same entity-type advisory lock as record writes and Choice-option deletion, and validates every Choice filter value still references an existing option, before writing.';
comment on function update_entity_view_authorized(uuid, uuid, uuid, text, jsonb, jsonb, jsonb)
  is 'records.operate-checked (effective-user-aware) entity-view update. Same lock/validation guarantees as create_entity_view_authorized.';
