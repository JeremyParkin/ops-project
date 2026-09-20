-- Record Work / Work Settings v1a -- schema foundation.
--
-- Explicit, builder-configured work semantics for an EntityType: which
-- Workspace Member field means "assignee," which Date field (if any) means
-- "due," which Choice field (if any) means "status," and which of that
-- field's options (if any) mean "complete." An arbitrary Workspace Member
-- field never implies work on its own -- see 0143's own note. Mirrors the
-- structural shape of 0100 (people-sensitive access) and 0105 (Quality
-- Review): plain columns on entity_types, same-EntityType composite FKs,
-- restrictive deletes, no shadow field-type columns (field type is
-- authoritative-RPC-validated, matching Quality Review's own precedent, not
-- 0143's heavier 4-column type-scoped FK).

alter table entity_types
  add column if not exists work_enabled boolean not null default false,
  add column if not exists work_assignment_field_id uuid,
  add column if not exists work_due_field_id uuid,
  add column if not exists work_status_field_id uuid;

-- Same-EntityType structural guarantee, reusing the (workspace_id,
-- entity_type_id, id) unique key 0100 added to field_definitions.
alter table entity_types
  drop constraint if exists entity_types_work_assignment_field_fk;
alter table entity_types
  add constraint entity_types_work_assignment_field_fk
  foreign key (workspace_id, id, work_assignment_field_id)
  references field_definitions (workspace_id, entity_type_id, id)
  on delete restrict;

alter table entity_types
  drop constraint if exists entity_types_work_due_field_fk;
alter table entity_types
  add constraint entity_types_work_due_field_fk
  foreign key (workspace_id, id, work_due_field_id)
  references field_definitions (workspace_id, entity_type_id, id)
  on delete restrict;

alter table entity_types
  drop constraint if exists entity_types_work_status_field_fk;
alter table entity_types
  add constraint entity_types_work_status_field_fk
  foreign key (workspace_id, id, work_status_field_id)
  references field_definitions (workspace_id, entity_type_id, id)
  on delete restrict;

-- Enabling work requires an assignment field; due/status stay optional.
alter table entity_types
  drop constraint if exists entity_types_work_invariant_check;
alter table entity_types
  add constraint entity_types_work_invariant_check
  check (not work_enabled or work_assignment_field_id is not null);

-- Completion options: which option(s) of the configured status field mean
-- "this record is done." A join table (not single option columns like
-- Quality Review's draft/finalized pair) because multiple completion
-- options are a real v1 requirement (Done/Cancelled/Closed). Both FKs
-- together transitively guarantee option_id belongs to a Choice field that
-- itself belongs to entity_type_id/workspace_id -- no shadow type column,
-- field type ('choice') is RPC-validated only, matching entity_types'
-- own work_status_field_id above.
create table entity_type_work_completion_options (
  workspace_id uuid not null,
  entity_type_id uuid not null,
  status_field_id uuid not null,
  option_id uuid not null,
  created_at timestamptz not null default now(),

  primary key (workspace_id, entity_type_id, status_field_id, option_id),

  foreign key (workspace_id, entity_type_id)
    references entity_types (workspace_id, id)
    on delete cascade,

  -- status_field_id belongs to this exact EntityType/workspace.
  foreign key (workspace_id, entity_type_id, status_field_id)
    references field_definitions (workspace_id, entity_type_id, id)
    on delete restrict,

  -- option_id belongs to that exact status_field_id (field_choice_options'
  -- own (workspace_id, field_definition_id, id) key, the same shape
  -- Quality Review's draft/finalized option FKs already use in 0105).
  foreign key (workspace_id, status_field_id, option_id)
    references field_choice_options (workspace_id, field_definition_id, id)
    on delete restrict
);

create index entity_type_work_completion_options_status_field_idx
  on entity_type_work_completion_options (workspace_id, status_field_id);

alter table entity_type_work_completion_options enable row level security;
revoke all on table entity_type_work_completion_options from public, anon, authenticated;
