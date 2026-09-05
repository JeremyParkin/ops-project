-- Phase 12.2: People-Sensitive Read Access -- foundation.
--
-- Approved architecture (three PLAN ONLY investigation rounds):
--   - RLS is the enforcement boundary for generic record/relation READ
--     visibility.
--   - Authorized SECURITY DEFINER RPCs are the enforcement boundary for
--     record/relation MUTATION (RLS cannot reach their internal statements
--     at all -- confirmed by inspection, round 3).
--   - entity_record_relation_values has never had a direct authenticated
--     mutation grant since 0022/0023; entity_records has only the narrow
--     archive/restore column-update grant since the same migrations. Both
--     are already exactly the target shape -- no grant/revoke DDL is
--     needed anywhere in Phase 12.2.
--   - People remain ordinary metadata-defined business objects; sensitive
--     people data remains an ordinary EntityRecord with explicit security
--     metadata -- no field ACL engine, no policy language, no lifecycle.
--
-- This migration adds: EntityType sensitive-access metadata, the
-- people_data.view_all capability, the private.can_view_people_sensitive_
-- record helper, the corrected entity_records/entity_record_relation_values
-- RLS composition, the sensitive-access configuration RPC (with the
-- safe-transition existing-record validation), a field-archival guard, a
-- Process Template attachment guard, and a Workflow attachment guard.

-- 1. EntityType sensitive-access metadata. subject_person_field_id and
-- author_person_field_id are composite FKs into field_definitions scoped to
-- this exact entity type and workspace -- a field belonging to a different
-- entity type or workspace is structurally impossible to designate, not
-- merely RPC-validated. Both are relation fields whose related_entity_type_id
-- is immutable after creation (confirmed: update_field_definition, the only
-- field-mutation RPC, exposes only name/slug/required) -- so once a field is
-- validated as targeting the workspace's designated Person type at
-- designation time, it can never silently drift to point elsewhere.
alter table entity_types
  add column if not exists people_sensitive boolean not null default false,
  add column if not exists subject_person_field_id uuid,
  add column if not exists author_person_field_id uuid,
  add column if not exists subject_can_view boolean not null default true,
  add column if not exists manager_can_view boolean not null default true,
  add column if not exists author_can_view boolean not null default false;

-- field_definitions carries a unique (workspace_id, id) key (0003) and a
-- 4-column (workspace_id, entity_type_id, id, related_entity_type_id) key,
-- but no unique (workspace_id, entity_type_id, id) triple -- the exact
-- shape a composite FK scoping subject/author designation to fields of
-- this same entity type needs. id is already globally unique (primary
-- key), so this added constraint is free -- it cannot fail against any
-- existing data.
alter table field_definitions
  drop constraint if exists field_definitions_workspace_entity_type_id_id_key;
alter table field_definitions
  add constraint field_definitions_workspace_entity_type_id_id_key
  unique (workspace_id, entity_type_id, id);

alter table entity_types
  drop constraint if exists entity_types_subject_person_field_fk;
alter table entity_types
  add constraint entity_types_subject_person_field_fk
  foreign key (workspace_id, id, subject_person_field_id)
  references field_definitions (workspace_id, entity_type_id, id)
  on delete restrict;

alter table entity_types
  drop constraint if exists entity_types_author_person_field_fk;
alter table entity_types
  add constraint entity_types_author_person_field_fk
  foreign key (workspace_id, id, author_person_field_id)
  references field_definitions (workspace_id, entity_type_id, id)
  on delete restrict;

-- author_can_view is meaningless (and dangerous to evaluate) without a
-- designated author field; the subject/author fields must be two distinct
-- fields when both are set (one field cannot mean two different things);
-- and sensitivity always requires a subject field the moment it is enabled.
alter table entity_types
  drop constraint if exists entity_types_author_requires_field_check;
alter table entity_types
  add constraint entity_types_author_requires_field_check
  check (not author_can_view or author_person_field_id is not null);

alter table entity_types
  drop constraint if exists entity_types_subject_author_distinct_check;
alter table entity_types
  add constraint entity_types_subject_author_distinct_check
  check (
    subject_person_field_id is null
    or author_person_field_id is null
    or subject_person_field_id <> author_person_field_id
  );

alter table entity_types
  drop constraint if exists entity_types_sensitive_requires_subject_check;
alter table entity_types
  add constraint entity_types_sensitive_requires_subject_check
  check (not people_sensitive or subject_person_field_id is not null);

-- 2. people_data.view_all capability. Narrow and specific: none of the
-- existing capabilities honestly mean "read all sensitive personnel data"
-- (operations.view is read access to operational analytics/portfolio
-- summaries, not sensitive record content; workspace.manage_members and
-- schema.manage are governance capabilities unrelated to record content).
-- Backfilled onto built-in roles only, per the established precedent
-- (0068 workspace.impersonate_users, 0073 workspace.manage_integrations) --
-- custom roles never receive a new capability automatically.
alter table workspace_role_capabilities drop constraint if exists workspace_role_capabilities_capability_check;
alter table workspace_role_capabilities add constraint workspace_role_capabilities_capability_check
  check (capability in (
    'workspace.manage_members', 'workspace.manage_roles', 'workspace.manage_organization', 'workspace.manage_settings',
    'schema.manage', 'automation.manage', 'records.operate', 'processes.operate', 'operations.view',
    'workspace.impersonate_users',
    'workspace.manage_integrations',
    'people_data.view_all'
  ));

insert into workspace_role_capabilities (workspace_id, role_id, capability)
select role.workspace_id, role.id, 'people_data.view_all'
from workspace_roles role
where role.is_builtin = true
  and not exists (
    select 1 from workspace_role_capabilities existing
    where existing.workspace_id = role.workspace_id and existing.role_id = role.id
      and existing.capability = 'people_data.view_all'
  );

-- Reproduced in full from their current live bodies (0073) with the one new
-- value added to each inline vocabulary list -- these RPCs validate
-- incoming capability values independently of the table CHECK constraint
-- above, so without this the role editor would reject people_data.view_all
-- as "Invalid capability" the moment anyone tried to grant it to a custom
-- role.
create or replace function create_workspace_role_authorized(
  p_workspace_id uuid,
  p_name text,
  p_description text,
  p_capabilities jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role_id uuid := gen_random_uuid();
  v_capability text;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');

  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;

  insert into workspace_roles (id, workspace_id, name, description)
  values (v_role_id, p_workspace_id, trim(p_name), nullif(trim(p_description), ''));

  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members',
      'workspace.manage_roles',
      'workspace.manage_organization',
      'workspace.manage_settings',
      'schema.manage',
      'automation.manage',
      'records.operate',
      'processes.operate',
      'operations.view',
      'workspace.impersonate_users',
      'workspace.manage_integrations',
      'people_data.view_all'
    ) then
      raise exception 'Invalid capability';
    end if;

    insert into workspace_role_capabilities (workspace_id, role_id, capability)
    values (p_workspace_id, v_role_id, v_capability);
  end loop;

  return v_role_id;
end;
$$;

create or replace function update_workspace_role_authorized(
  p_workspace_id uuid,
  p_role_id uuid,
  p_name text,
  p_description text,
  p_capabilities jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_capability text;
  v_caller_role uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  select role_id into v_caller_role
  from workspace_memberships
  where workspace_id = p_workspace_id
    and user_id = auth.uid()
  for update;

  if v_caller_role = p_role_id then
    raise exception 'You cannot edit the capabilities of your own role';
  end if;
  if not exists (
    select 1
    from workspace_roles
    where workspace_id = p_workspace_id
      and id = p_role_id
  ) then
    raise exception 'Role not found';
  end if;
  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;

  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members',
      'workspace.manage_roles',
      'workspace.manage_organization',
      'workspace.manage_settings',
      'schema.manage',
      'automation.manage',
      'records.operate',
      'processes.operate',
      'operations.view',
      'workspace.impersonate_users',
      'workspace.manage_integrations',
      'people_data.view_all'
    ) then
      raise exception 'Invalid capability';
    end if;
  end loop;

  update workspace_roles
  set name = trim(p_name),
      description = nullif(trim(p_description), ''),
      updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_role_id;

  delete from workspace_role_capabilities
  where workspace_id = p_workspace_id
    and role_id = p_role_id;

  insert into workspace_role_capabilities (workspace_id, role_id, capability)
  select p_workspace_id, p_role_id, value
  from jsonb_array_elements_text(p_capabilities) value;

  perform private.assert_workspace_administrator(p_workspace_id);
end;
$$;

-- 3. The authorization helper. One private, reusable SECURITY DEFINER
-- function used identically by RLS policies and by every SECURITY DEFINER
-- RPC that reads or mutates entity_records/entity_record_relation_values --
-- the single place sensitive-visibility logic is ever expressed. `language
-- sql stable` (not plpgsql) so it inlines cleanly into RLS USING clauses,
-- matching every existing private helper (is_workspace_member,
-- has_workspace_capability_as, current_effective_user).
--
-- Semantics:
--   A. Non-sensitive EntityType: always true (ordinary member behavior,
--      unchanged -- the caller is expected to separately require workspace
--      membership, exactly as every existing call site already does).
--   B. Sensitive EntityType:
--      - people_data.view_all is checked against the REAL actor
--        (auth.uid()), never the effective/impersonated identity, so the
--        override cannot leak through an active impersonation session.
--      - The record's subject is resolved via its designated
--        subject_person_field_id relation -> the target Person record's
--        entity_record_person_links row -> that row's linked user_id. If no
--        such chain resolves to a linked user (missing relation, relation
--        target not linked to any member, or subject_person_field_id
--        misconfigured/null on malformed data), the record is FAIL CLOSED:
--        only the privileged override above can see it. subject_can_view,
--        manager_can_view, and author_can_view all require a resolved
--        subject and independently default to false the instant no subject
--        resolves.
--      - manager_can_view is evaluated against workspace_reporting_
--        relationships' current primary_manager row for the resolved
--        subject user -- a live, single-row lookup, not
--        private.managed_user_ids (which is broader manager/team read scope
--        never intended to double as sensitive-record authorization) -- so
--        access updates immediately when the reporting relationship
--        changes, with no team-lead or skip-level reach.
--      - author_can_view resolves the same way through
--        author_person_field_id, independent of the subject/manager
--        branches.
--      - Every branch is evaluated against p_effective_user_id, the
--        already-resolved effective identity the caller passes in
--        (private.current_effective_user(workspace_id)) -- ordinary reads
--        stay effective-user-aware, exactly like records.operate.
create or replace function private.can_view_people_sensitive_record(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_effective_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      not et.people_sensitive
      or (
        -- The override is checked against the real actor and ALSO requires
        -- the real actor to currently BE the effective user -- i.e. it is
        -- unconditionally false while impersonating, regardless of the
        -- real actor's own capabilities. Without this second conjunct the
        -- override would leak: a people_data.view_all holder impersonating
        -- an ordinary member would see more than that member actually
        -- sees, defeating the entire point of impersonation (reproducing
        -- exactly what the impersonated identity sees).
        private.has_workspace_capability_as(p_workspace_id, 'people_data.view_all', (select auth.uid()))
        and (select auth.uid()) = p_effective_user_id
      )
      or (
        subject.linked_user_id is not null
        and (
          (et.subject_can_view and subject.linked_user_id = p_effective_user_id)
          or (
            et.manager_can_view
            and exists (
              select 1
              from public.workspace_reporting_relationships wrr
              where wrr.workspace_id = p_workspace_id
                and wrr.report_user_id = subject.linked_user_id
                and wrr.relationship_kind = 'primary_manager'
                and wrr.manager_user_id = p_effective_user_id
            )
          )
          or (
            et.author_can_view
            and et.author_person_field_id is not null
            and exists (
              select 1
              from public.entity_record_relation_values arv
              join public.entity_record_person_links apl
                on apl.workspace_id = arv.workspace_id
                and apl.entity_record_id = arv.target_record_id
              where arv.workspace_id = p_workspace_id
                and arv.source_record_id = p_record_id
                and arv.field_definition_id = et.author_person_field_id
                and apl.user_id = p_effective_user_id
            )
          )
        )
      )
    from public.entity_types et
    left join lateral (
      select apl.user_id as linked_user_id
      from public.entity_record_relation_values srv
      join public.entity_record_person_links apl
        on apl.workspace_id = srv.workspace_id
        and apl.entity_record_id = srv.target_record_id
      where srv.workspace_id = p_workspace_id
        and srv.source_record_id = p_record_id
        and srv.field_definition_id = et.subject_person_field_id
      limit 1
    ) subject on true
    where et.workspace_id = p_workspace_id
      and et.id = p_entity_type_id
  ), false)
$$;

revoke all on function private.can_view_people_sensitive_record(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function private.can_view_people_sensitive_record(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- 3b. Governance-boundary helper for post-creation subject/author relation
-- changes (used by update_entity_record_with_relations, 0101). Deliberately
-- separate from every other capability check in this schema:
-- people_data.view_all is evaluated against auth.uid() (the real actor),
-- never private.current_effective_user(...), and impersonation is rejected
-- outright BEFORE the capability is even checked -- matching 0099's
-- established ordering exactly (reject impersonation first, so the error a
-- real admin sees while impersonating is "not available while
-- impersonating," not a misleading "permission denied"). An impersonated
-- effective identity can never rewrite subject/author authorization even
-- when that effective identity itself holds people_data.view_all, because
-- this check never looks at the effective identity at all.
create or replace function private.require_people_data_governance_authority(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Changing who can access this record is not available while impersonating';
  end if;

  if not private.has_workspace_capability_as(p_workspace_id, 'people_data.view_all', auth.uid()) then
    raise exception 'Changing who can access this record requires additional privileges';
  end if;
end;
$$;

revoke all on function private.require_people_data_governance_authority(uuid) from public, anon, authenticated;
grant execute on function private.require_people_data_governance_authority(uuid) to authenticated, service_role;

-- 4. entity_records RLS. Exact current live policies re-confirmed
-- immediately before this edit by re-inspecting every CREATE POLICY/ALTER
-- POLICY statement ever issued against this table (0048 defines both;
-- 0068 alters entity_records_operate_write for effective-user awareness;
-- nothing else touches either policy) -- exhaustively two policies exist
-- today:
--   entity_records_member_read: for select, using is_workspace_member(...)
--   entity_records_operate_write: for all, using/with check
--     has_workspace_capability_as(..., 'records.operate', effective user)
-- entity_records_operate_write's "for all" independently grants SELECT --
-- the confirmed round-1 defect. Both are dropped and replaced: one SELECT
-- policy narrowed with the sensitive predicate, and one UPDATE-only policy
-- (INSERT/DELETE need no policy at all -- entity_records has carried no
-- INSERT/DELETE grant for authenticated since 0022/0023, confirmed by
-- exhaustive grant/revoke history audit; a policy for a command with no
-- underlying grant is simply never reached). This UPDATE policy is what
-- actually protects the live direct-table archive/restore path
-- (archiveEntityRecord/restoreEntityRecord, lib/domain/record-repository.ts)
-- -- the create/update/delete RPCs are SECURITY DEFINER and never reach
-- table RLS at all, enforced instead in 0101.
drop policy if exists entity_records_member_read on entity_records;
create policy entity_records_member_read on entity_records
  for select to authenticated
  using (
    (select private.is_workspace_member(workspace_id))
    and (select private.can_view_people_sensitive_record(
      workspace_id, entity_type_id, id, private.current_effective_user(workspace_id)
    ))
  );

drop policy if exists entity_records_operate_write on entity_records;
create policy entity_records_operate_update on entity_records
  for update to authenticated
  using (
    (select private.has_workspace_capability_as(workspace_id, 'records.operate', private.current_effective_user(workspace_id)))
    and (select private.can_view_people_sensitive_record(
      workspace_id, entity_type_id, id, private.current_effective_user(workspace_id)
    ))
  )
  with check ((select private.has_workspace_capability_as(workspace_id, 'records.operate', private.current_effective_user(workspace_id))));

-- 5. entity_record_relation_values RLS. Same re-confirmation: exactly two
-- policies exist today (relation_values_member_read, for select;
-- relation_values_operate_write, for all, altered by 0068 the same way).
-- entity_record_relation_values has carried NO insert/update/delete grant
-- for authenticated since 0022/0023 (confirmed by the same exhaustive
-- audit) -- so relation_values_operate_write's entire for-all scope has
-- been dead code on every command except the SELECT it accidentally
-- widens. It is dropped outright with no replacement: no INSERT/UPDATE/
-- DELETE policy is authored for authenticated, since no such grant exists
-- to invoke one -- exactly the standing principle of keeping raw tables
-- closed when authorized RPCs are the intended mutation model, and a
-- missing GRANT is a stronger guarantee than any policy could provide.
-- The remaining SELECT policy requires both sides of a relation to be
-- independently visible, so a relation row can never reveal the existence
-- of a hidden sensitive record through its visible, ordinary counterpart.
drop policy if exists relation_values_member_read on entity_record_relation_values;
create policy relation_values_member_read on entity_record_relation_values
  for select to authenticated
  using (
    (select private.is_workspace_member(workspace_id))
    and (select private.can_view_people_sensitive_record(
      workspace_id, source_entity_type_id, source_record_id, private.current_effective_user(workspace_id)
    ))
    and (select private.can_view_people_sensitive_record(
      workspace_id, target_entity_type_id, target_record_id, private.current_effective_user(workspace_id)
    ))
  );

drop policy if exists relation_values_operate_write on entity_record_relation_values;

-- 6. Field-lifecycle guard. field_definitions.archived_at is set through a
-- direct table UPDATE (grant update (archived_at, updated_at) on table
-- field_definitions to authenticated, 0022), governed by RLS
-- (field_definitions_schema_write, schema.manage), not an RPC -- so
-- "changing/removing the sensitive subject/author field" must be closed at
-- the table level, not inside a config RPC nobody is forced to call.
-- Mirrors the existing private.reject_workspace_id_change() trigger
-- precedent (0022) exactly in shape.
create or replace function private.reject_archiving_designated_sensitive_field()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    if exists (
      select 1 from public.entity_types et
      where et.workspace_id = new.workspace_id
        and (et.subject_person_field_id = new.id or et.author_person_field_id = new.id)
    ) then
      raise exception 'This field is designated for sensitive-record access and cannot be archived. Change the designation first.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists field_definitions_reject_sensitive_archive on field_definitions;
create trigger field_definitions_reject_sensitive_archive
  before update on field_definitions
  for each row execute function private.reject_archiving_designated_sensitive_field();

-- 7. Process Template attachment guard. applies_to_entity_type_id is
-- immutable after creation (confirmed: every save path raises "Applies-to
-- entity type cannot be changed after creation" for an existing template),
-- so this one check on the outermost save RPC covers both directions: a
-- brand-new template cannot be created against an already-sensitive type,
-- and (because a people_sensitive designation is itself blocked below while
-- any process_templates row targets the type) an existing template can
-- never later find itself attached to a type that just became sensitive.
-- Full latest body reproduced faithfully from 0079 (the current outermost
-- entry point in the save_process_template_authorized_* disguise-wrapper
-- chain) -- the only change is the new leading validation.
create or replace function public.save_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_name text,
  p_description text,
  p_applies_to_entity_type_id uuid,
  p_steps jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_external_steps jsonb := '[]'::jsonb;
  v_template_id uuid;
  v_node_id uuid;
  v_index integer := 0;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');

  if exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id
      and id = p_applies_to_entity_type_id
      and people_sensitive = true
  ) then
    raise exception 'Process Templates cannot target people-sensitive entity types';
  end if;

  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Process steps must be an array'; end if;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_index := v_index + 1;
    if v_step->>'node_type' = 'external_event_wait' then
      if coalesce(nullif(trim(v_step->>'assignee_user_id'), ''), '') <> ''
        or coalesce(v_step->'due_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'wait_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'condition_wait_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'action_config', 'null'::jsonb) <> 'null'::jsonb then
        raise exception 'External event waits cannot have an assignee, due rule, timer rule, condition rule, or action config';
      end if;
      v_external_steps := v_external_steps || jsonb_build_array(jsonb_build_object('position', v_index));
      v_normalized := v_normalized || jsonb_build_array((v_step - 'wait_rule' - 'condition_wait_rule' - 'action_config') || jsonb_build_object('node_type', 'human_task'));
    else
      v_normalized := v_normalized || jsonb_build_array(v_step);
    end if;
  end loop;

  v_template_id := save_process_template_authorized_pre_external_event_wait(
    p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, v_normalized
  );

  for v_step in select * from jsonb_array_elements(v_external_steps) loop
    select id into v_node_id from public.process_nodes
    where workspace_id = p_workspace_id and process_template_id = v_template_id and position = (v_step->>'position')::integer for update;
    if not found then raise exception 'External event wait node was not saved'; end if;
    update public.process_nodes
    set node_type = 'external_event_wait', assignee_user_id = null, config = '{}'::jsonb, updated_at = now()
    where workspace_id = p_workspace_id and id = v_node_id;
  end loop;

  return v_template_id;
end;
$$;

revoke all on function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public, anon;
grant execute on function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;

-- 8. Workflow attachment guard. Workflows are still direct-table writes
-- (grant insert, update, delete on table workflows to authenticated,
-- 0022), governed by RLS (workflows_automation_write, automation.manage),
-- with no RPC boundary to add a check to -- a BEFORE INSERT OR UPDATE
-- trigger is the only place this can be enforced, mirroring the existing
-- reject_workspace_id_change trigger precedent. Checks both the trigger
-- entity type and every action's target entity type inside the actions[]
-- array (0019's ordered-actions representation).
create or replace function private.reject_people_sensitive_workflow_target()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.entity_types et
    where et.workspace_id = new.workspace_id
      and et.id = new.trigger_entity_type_id
      and et.people_sensitive = true
  ) then
    raise exception 'Workflows cannot trigger on people-sensitive entity types';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.actions) action
    join public.entity_types et
      on et.workspace_id = new.workspace_id
      and action ->> 'actionTargetEntityTypeId' = et.id::text
    where et.people_sensitive = true
  ) then
    raise exception 'Workflows cannot target people-sensitive entity types';
  end if;

  return new;
end;
$$;

drop trigger if exists workflows_reject_sensitive_target on workflows;
create trigger workflows_reject_sensitive_target
  before insert or update on workflows
  for each row execute function private.reject_people_sensitive_workflow_target();

-- 9. Sensitive-access configuration RPC. Governance action, mirroring
-- set_person_entity_type_authorized (0097/0099) exactly in shape:
-- schema.manage, real-actor-only, unconditionally rejects an active
-- impersonation session as the first statement (0099's idiom, verbatim).
--
-- Safe-transition validation (approved correction): before people_sensitive
-- may become true, or before an already-sensitive type's subject field may
-- change to a different field, every existing record of this entity type is
-- checked for a subject relation value that points to a genuine Person-type
-- record. This does not require that Person already be linked to a
-- workspace member, and does not require that Person record be unarchived
-- (see the archived-Person note at the query itself) -- an unlinked subject
-- is a completely ordinary, pre-existing state that the runtime helper
-- already handles safely (fail-closed to the privileged override, not an
-- error) -- it only catches records with no subject relation value at all,
-- or one pointing to something that is not a genuine Person record, which
-- is what would otherwise silently and confusingly strand existing records
-- behind fail-closed the instant sensitivity is enabled. No record is ever
-- auto-populated, repaired, or rewritten; the configuration change is
-- rejected outright with a truthful count.
create or replace function set_entity_type_people_sensitive_access_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_people_sensitive boolean,
  p_subject_person_field_id uuid,
  p_author_person_field_id uuid,
  p_subject_can_view boolean,
  p_manager_can_view boolean,
  p_author_can_view boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_type entity_types%rowtype;
  v_person_entity_type_id uuid;
  v_invalid_subject_count integer := 0;
  v_conflicting_process_count integer := 0;
  v_conflicting_workflow_count integer := 0;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  select * into v_entity_type
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
  for update;

  if not found then
    raise exception 'Entity type not found';
  end if;
  if v_entity_type.archived_at is not null then
    raise exception 'Cannot configure an archived entity type';
  end if;

  if p_people_sensitive is null or p_subject_can_view is null or p_manager_can_view is null or p_author_can_view is null then
    raise exception 'Sensitive-access configuration fields are required';
  end if;

  if p_author_can_view and p_author_person_field_id is null then
    raise exception 'Reviewer/author visibility requires a designated reviewer/author field';
  end if;

  select person_entity_type_id into v_person_entity_type_id
  from workspaces
  where id = p_workspace_id;

  -- Subject/author fields are validated whenever supplied, independent of
  -- p_people_sensitive -- never store a designation pointing at something
  -- that is not a live relation-to-Person field on this exact entity type.
  if p_subject_person_field_id is not null or p_author_person_field_id is not null then
    if v_person_entity_type_id is null then
      raise exception 'No Person type is designated for this workspace';
    end if;
  end if;

  if p_subject_person_field_id is not null and not exists (
    select 1 from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_subject_person_field_id
      and type = 'relation'
      and archived_at is null
      and related_entity_type_id = v_person_entity_type_id
  ) then
    raise exception 'Subject field must be an active relation field on this object targeting the designated Person type';
  end if;

  if p_author_person_field_id is not null and not exists (
    select 1 from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_author_person_field_id
      and type = 'relation'
      and archived_at is null
      and related_entity_type_id = v_person_entity_type_id
  ) then
    raise exception 'Reviewer/author field must be an active relation field on this object targeting the designated Person type';
  end if;

  if p_subject_person_field_id is not null and p_subject_person_field_id = p_author_person_field_id then
    raise exception 'Subject and reviewer/author must be different fields';
  end if;

  if p_people_sensitive then
    if p_subject_person_field_id is null then
      raise exception 'Sensitive people data requires a designated subject field';
    end if;

    select count(*) into v_conflicting_process_count
    from process_templates
    where workspace_id = p_workspace_id
      and applies_to_entity_type_id = p_entity_type_id;

    select count(*) into v_conflicting_workflow_count
    from workflows workflow
    where workflow.workspace_id = p_workspace_id
      and (
        workflow.trigger_entity_type_id = p_entity_type_id
        or exists (
          select 1 from jsonb_array_elements(workflow.actions) action
          where action ->> 'actionTargetEntityTypeId' = p_entity_type_id::text
        )
      );

    if v_conflicting_process_count > 0 or v_conflicting_workflow_count > 0 then
      raise exception 'Cannot mark this object as sensitive people data while % Process Template(s) and % Workflow(s) still target it. Detach them first.',
        v_conflicting_process_count, v_conflicting_workflow_count;
    end if;

    -- Re-validate existing records only when sensitivity is newly enabled,
    -- or the subject field is changing to a different field -- an
    -- unchanged, already-validated subject field never needs re-checking.
    --
    -- Deliberately does NOT require the target Person record to be
    -- unarchived. Person identity links survive Person-record archival by
    -- design (0097), archival is reversible, and historical business
    -- relationships are never rewritten when a Person profile is archived
    -- -- an already-archived Person is a structurally valid, legitimate
    -- historical subject anchor, not a broken one. Rejecting enablement
    -- here for that reason would penalize normal, expected Person lifecycle
    -- (e.g. a former employee's historical Quality Reviews) for a state
    -- that is not actually broken. Whether a NEW relation may be created
    -- against an archived target at all is a separate, already-existing,
    -- unrelated rule (create_entity_record_with_relations/update_entity_
    -- record_with_relations's "must reference an active record" check,
    -- 0082) -- unaffected by this validation either way.
    if v_entity_type.people_sensitive is not true
      or v_entity_type.subject_person_field_id is distinct from p_subject_person_field_id
    then
      select count(*) into v_invalid_subject_count
      from entity_records er
      where er.workspace_id = p_workspace_id
        and er.entity_type_id = p_entity_type_id
        and not exists (
          select 1
          from entity_record_relation_values rv
          join entity_records person_rec
            on person_rec.workspace_id = rv.workspace_id
            and person_rec.id = rv.target_record_id
          where rv.workspace_id = p_workspace_id
            and rv.source_record_id = er.id
            and rv.field_definition_id = p_subject_person_field_id
            and rv.target_entity_type_id = v_person_entity_type_id
            and person_rec.entity_type_id = v_person_entity_type_id
        );

      if v_invalid_subject_count > 0 then
        raise exception '% existing record(s) of this object do not have a valid subject relation set in the selected subject field. Set a subject for every existing record before enabling sensitive access.',
          v_invalid_subject_count;
      end if;
    end if;
  end if;

  update entity_types
  set people_sensitive = p_people_sensitive,
      subject_person_field_id = p_subject_person_field_id,
      author_person_field_id = p_author_person_field_id,
      subject_can_view = p_subject_can_view,
      manager_can_view = p_manager_can_view,
      author_can_view = p_author_can_view,
      updated_at = now()
  where workspace_id = p_workspace_id and id = p_entity_type_id;
end;
$$;

revoke all on function set_entity_type_people_sensitive_access_authorized(uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function set_entity_type_people_sensitive_access_authorized(uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean) to authenticated, service_role;

comment on function set_entity_type_people_sensitive_access_authorized(uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean)
  is 'Configures Phase 12.2 sensitive-access metadata for one EntityType: people_sensitive designation, subject/author relation fields (must target the workspace''s designated Person type), and the three fixed read-access toggles. schema.manage, real-actor-only, blocked while impersonating. Rejects enabling sensitivity while a Process Template or Workflow targets the type, and rejects it while any existing record lacks a valid subject relation, with a truthful count -- never auto-populates or rewrites records.';

comment on function private.can_view_people_sensitive_record(uuid, uuid, uuid, uuid)
  is 'Phase 12.2 sensitive-record read authorization. Non-sensitive types always pass. Sensitive types require people_data.view_all (real actor only) or a resolved subject (via the designated subject relation''s linked workspace member) with a matching subject/manager/author branch enabled; a record with no resolvable subject is fail-closed to the privileged override only.';

-- 10. Person-type redesignation guard, extended for Phase 12.2. Corrective
-- migration for set_person_entity_type_authorized, exactly like 0098/0099
-- corrected 0097 -- 0097/0098/0099 remain untouched and immutable. Full
-- latest body (0099, its most recent redefinition) copied faithfully below;
-- the only change is one new guard appended after the existing identity-
-- link check.
--
-- Defect this closes: Phase 12.1's own guard (0097) blocks redesignation
-- only while entity_record_person_links has rows. A workspace can have a
-- designated Person type, one or more EntityTypes actively configured
-- people_sensitive with subject/author relation fields targeting that
-- Person type, and ZERO person links (e.g. sensitivity was enabled, but no
-- subject has been linked to a login yet, or every link was since removed
-- without anyone disabling sensitivity). In that state 0097/0099's
-- zero-link check alone would let a builder freely change or clear
-- workspaces.person_entity_type_id -- not because doing so is safe, but
-- because 12.1 had no way to know 12.2's sensitive-access configuration
-- would even come to exist. The result would not be a crash: every
-- currently-sensitive EntityType's helper resolution already fails closed
-- the moment its subject/author fields stop matching the live Person type
-- (can_view_people_sensitive_record never validates that its own
-- configuration is current) -- but silently falling back to "only
-- people_data.view_all can see this" is not an acceptable ordinary
-- lifecycle outcome for an active security configuration nobody chose to
-- change or was ever told about. The fix mirrors 0097's own reasoning for
-- links exactly: require the builder to explicitly disable/reconfigure
-- sensitive access first, then change the Person type -- never let
-- redesignation silently invalidate it.
--
-- Scope: only entity_types actively marked people_sensitive = true count.
-- A type with people_sensitive = false (sensitivity previously disabled,
-- or never enabled) is not currently enforcing anything -- its stored
-- subject_person_field_id/author_person_field_id, if any, are inert and
-- already re-validated against whatever Person type is current the next
-- time someone tries to re-enable sensitivity (this same RPC, section 9
-- above) -- so leaving a disabled type's stale field references
-- unaddressed here strands nothing live and does not need its own guard.
create or replace function set_person_entity_type_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_entity_type_id uuid;
  v_sensitive_entity_type_count integer := 0;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  select person_entity_type_id into v_current_entity_type_id
  from workspaces
  where id = p_workspace_id;

  if v_current_entity_type_id is not distinct from p_entity_type_id then
    return;
  end if;

  if exists (
    select 1 from entity_record_person_links where workspace_id = p_workspace_id
  ) then
    raise exception 'Cannot change the Person type while identity links exist. Remove all links first.';
  end if;

  -- Phase 12.2 addition: see migration header. Reached only when this call
  -- is a genuine change or clear (the no-op return above already handled
  -- "same value"), so this covers both directions identically.
  select count(*) into v_sensitive_entity_type_count
  from entity_types
  where workspace_id = p_workspace_id
    and people_sensitive = true;

  if v_sensitive_entity_type_count > 0 then
    raise exception 'Cannot change the Person type while % object(s) are configured as sensitive people data. Disable sensitive access on them first.',
      v_sensitive_entity_type_count;
  end if;

  if p_entity_type_id is not null then
    if not exists (
      select 1 from entity_types
      where workspace_id = p_workspace_id
        and id = p_entity_type_id
        and archived_at is null
    ) then
      raise exception 'Entity type not found or archived';
    end if;
  end if;

  update workspaces
  set person_entity_type_id = p_entity_type_id, updated_at = now()
  where id = p_workspace_id;
end;
$$;

comment on function set_person_entity_type_authorized(uuid, uuid)
  is 'Designates (or clears) the workspace''s single Person EntityType. Blocked while any entity_record_person_links row exists, and blocked while any EntityType is actively configured people_sensitive (Phase 12.2) -- both must be explicitly cleared first, to avoid stranding identity links or silently invalidating live sensitive-access configuration across a redesignation. schema.manage, real-actor-only, blocked while impersonating.';
