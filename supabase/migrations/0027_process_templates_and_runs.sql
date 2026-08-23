-- Process Templates + Manual Process Runs (v1): a first-class Kinema
-- subsystem for repeatable human-task sequences, distinct from Entities
-- (data), Views (presentation), and Workflows (event-driven automation).
--
-- Persistence is graph-capable from day one even though v1 only supports a
-- single linear acyclic chain of human_task nodes: process_edges is a real
-- adjacency table (not a position integer on process_nodes), so branching,
-- gateways, and new node types are additive later, not a schema rewrite.
-- ProcessStepRun.step_index is a different, safe use of a plain integer: it
-- records one already-realized run's linear path, which stays valid even if
-- the template graph becomes branchy later.
--
-- Every table here is SELECT-only for authenticated members; all writes go
-- through membership-checked, fixed-search-path SECURITY DEFINER RPCs from
-- the start, rather than repeating the older tables' incremental
-- grant-then-wrap pattern.

create table process_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  applies_to_entity_type_id uuid not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, id),

  foreign key (workspace_id, applies_to_entity_type_id)
    references entity_types(workspace_id, id)
    on delete restrict
);

create index process_templates_applies_to_idx
  on process_templates (workspace_id, applies_to_entity_type_id, archived_at);

create table process_nodes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_template_id uuid not null,
  node_type text not null check (node_type = 'human_task'),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, id),

  foreign key (workspace_id, process_template_id)
    references process_templates(workspace_id, id)
    on delete cascade
);

create index process_nodes_template_idx
  on process_nodes (workspace_id, process_template_id);

-- Node identity is stable across template edits (see save_process_template_
-- authorized below): renaming, reordering, and config edits update existing
-- rows in place rather than deleting and recreating them, so a future
-- assignment/workflow/analytics reference to a specific node stays valid.
create table process_edges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_template_id uuid not null,
  source_node_id uuid not null,
  target_node_id uuid not null,
  created_at timestamptz not null default now(),

  check (source_node_id <> target_node_id),

  -- At most one outgoing and one incoming edge per node: structurally
  -- forbids branching/merging for v1 without ruling it out for later.
  unique (workspace_id, source_node_id),
  unique (workspace_id, target_node_id),

  foreign key (workspace_id, process_template_id)
    references process_templates(workspace_id, id)
    on delete cascade,

  foreign key (workspace_id, source_node_id)
    references process_nodes(workspace_id, id)
    on delete cascade,

  foreign key (workspace_id, target_node_id)
    references process_nodes(workspace_id, id)
    on delete cascade
);

create index process_edges_template_idx
  on process_edges (workspace_id, process_template_id);

-- process_template_name/description are a snapshot taken at start time so a
-- later template rename/redescribe never rewrites a run's historical
-- meaning. process_template_id is retained for traceability/dependency
-- checks only, not for resolving display data.
create table process_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_template_id uuid not null,
  process_template_name text not null,
  process_template_description text,
  origin_entity_type_id uuid not null,
  origin_record_id uuid not null,
  status text not null check (status in ('active', 'completed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,

  check (
    (status = 'active' and completed_at is null)
    or (status = 'completed' and completed_at is not null)
  ),

  unique (workspace_id, id),

  foreign key (workspace_id, process_template_id)
    references process_templates(workspace_id, id)
    on delete restrict,

  foreign key (workspace_id, origin_entity_type_id, origin_record_id)
    references entity_records(workspace_id, entity_type_id, id)
    on delete restrict
);

-- Enforces "at most one active run per template + origin record" structurally.
create unique index process_runs_one_active_per_origin_idx
  on process_runs (workspace_id, process_template_id, origin_record_id)
  where status = 'active';

create index process_runs_origin_idx
  on process_runs (workspace_id, origin_entity_type_id, origin_record_id, started_at desc);

create index process_runs_template_idx
  on process_runs (workspace_id, process_template_id, started_at desc);

-- source_node_id is deliberately a soft reference (no FK), matching the
-- existing workflow_execution_logs precedent of not FK-constraining audit
-- fields: a step run's name/node_type/config are fully snapshotted below, so
-- correctness never depends on the originating node still existing, only
-- traceability does.
create table process_step_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_run_id uuid not null,
  source_node_id uuid,
  step_index integer not null check (step_index > 0),
  node_type text not null check (node_type = 'human_task'),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  status text not null check (status in ('pending', 'active', 'completed')),
  started_at timestamptz,
  completed_at timestamptz,

  check (
    (status = 'pending' and started_at is null and completed_at is null)
    or (status = 'active' and started_at is not null and completed_at is null)
    or (status = 'completed' and started_at is not null and completed_at is not null)
  ),

  unique (workspace_id, process_run_id, step_index),

  foreign key (workspace_id, process_run_id)
    references process_runs(workspace_id, id)
    on delete cascade
);

create index process_step_runs_run_idx
  on process_step_runs (workspace_id, process_run_id, step_index);

alter table process_templates enable row level security;
alter table process_nodes enable row level security;
alter table process_edges enable row level security;
alter table process_runs enable row level security;
alter table process_step_runs enable row level security;

create policy process_templates_member_access on process_templates
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy process_nodes_member_access on process_nodes
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy process_edges_member_access on process_edges
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy process_runs_member_access on process_runs
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy process_step_runs_member_access on process_step_runs
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

revoke all on table process_templates, process_nodes, process_edges,
  process_runs, process_step_runs from anon, authenticated;

-- Select-only from the start; every write is a SECURITY DEFINER RPC below.
grant select on table process_templates, process_nodes, process_edges,
  process_runs, process_step_runs to authenticated;

-- Matches the existing private.reject_workspace_id_change() convention used
-- by every other workspace-scoped domain table (see migration 0022): a
-- persisted row belongs to exactly one workspace for its lifetime. None of
-- the RPCs below ever reassign workspace_id on an existing row, but the
-- trigger keeps that a structural guarantee rather than an implementation
-- detail of this migration's functions.
create trigger process_templates_workspace_id_immutable
  before update on process_templates
  for each row execute function private.reject_workspace_id_change();

create trigger process_nodes_workspace_id_immutable
  before update on process_nodes
  for each row execute function private.reject_workspace_id_change();

create trigger process_edges_workspace_id_immutable
  before update on process_edges
  for each row execute function private.reject_workspace_id_change();

create trigger process_runs_workspace_id_immutable
  before update on process_runs
  for each row execute function private.reject_workspace_id_change();

create trigger process_step_runs_workspace_id_immutable
  before update on process_step_runs
  for each row execute function private.reject_workspace_id_change();

-- Creates a new template, or atomically replaces an existing (non-archived)
-- template's name/description/steps. p_process_template_id null means
-- create. p_steps is a JSON array of { node_id: uuid|null, name: text } in
-- the desired order; node_id null means "new step", non-null must already
-- belong to this workspace/template. Existing node rows referenced by
-- node_id are updated in place (stable IDs survive rename/reorder); nodes
-- omitted from the submission are removed; process_edges is always fully
-- rebuilt from the final order, since edges have no independent identity or
-- history value (only nodes are ever referenced by step runs).
create or replace function save_process_template_authorized(
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
  v_template_id uuid;
  v_existing_applies_to uuid;
  v_existing_archived_at timestamptz;
  v_step jsonb;
  v_step_node_id uuid;
  v_step_name text;
  v_previous_node_id uuid;
  v_seen_node_ids uuid[] := '{}'::uuid[];
  v_final_node_ids uuid[] := '{}'::uuid[];
  v_index integer;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'A process template requires at least one step';
  end if;

  if nullif(trim(p_name), '') is null then
    raise exception 'A process template requires a name';
  end if;

  if not exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id
      and id = p_applies_to_entity_type_id
      and archived_at is null
  ) then
    raise exception 'Applies-to entity type not found or archived';
  end if;

  if p_process_template_id is null then
    v_template_id := gen_random_uuid();

    insert into process_templates (
      id, workspace_id, name, description, applies_to_entity_type_id
    ) values (
      v_template_id,
      p_workspace_id,
      trim(p_name),
      nullif(trim(coalesce(p_description, '')), ''),
      p_applies_to_entity_type_id
    );
  else
    select applies_to_entity_type_id, archived_at
      into v_existing_applies_to, v_existing_archived_at
    from process_templates
    where workspace_id = p_workspace_id and id = p_process_template_id
    for update;

    if not found then
      raise exception 'Process template not found';
    end if;

    if v_existing_archived_at is not null then
      raise exception 'Archived process templates are read-only. Restore before editing.';
    end if;

    if v_existing_applies_to <> p_applies_to_entity_type_id then
      raise exception 'Applies-to entity type cannot be changed after creation';
    end if;

    v_template_id := p_process_template_id;

    update process_templates
    set name = trim(p_name),
        description = nullif(trim(coalesce(p_description, '')), ''),
        updated_at = now()
    where workspace_id = p_workspace_id and id = v_template_id;
  end if;

  for v_step in select * from jsonb_array_elements(p_steps)
  loop
    v_step_node_id := nullif(v_step->>'node_id', '')::uuid;
    v_step_name := nullif(trim(coalesce(v_step->>'name', '')), '');

    if v_step_name is null then
      raise exception 'Every step requires a name';
    end if;

    if v_step_node_id is not null then
      if v_step_node_id = any(v_seen_node_ids) then
        raise exception 'Duplicate step submitted';
      end if;

      if not exists (
        select 1 from process_nodes
        where workspace_id = p_workspace_id
          and process_template_id = v_template_id
          and id = v_step_node_id
      ) then
        raise exception 'Submitted step does not belong to this template';
      end if;

      v_seen_node_ids := v_seen_node_ids || v_step_node_id;

      update process_nodes
      set name = v_step_name,
          updated_at = now()
      where workspace_id = p_workspace_id and id = v_step_node_id;
    else
      v_step_node_id := gen_random_uuid();

      insert into process_nodes (
        id, workspace_id, process_template_id, node_type, name
      ) values (
        v_step_node_id, p_workspace_id, v_template_id, 'human_task', v_step_name
      );
    end if;

    v_final_node_ids := v_final_node_ids || v_step_node_id;
  end loop;

  delete from process_nodes
  where workspace_id = p_workspace_id
    and process_template_id = v_template_id
    and not (id = any(v_final_node_ids));

  delete from process_edges
  where workspace_id = p_workspace_id
    and process_template_id = v_template_id;

  v_previous_node_id := null;

  for v_index in 1 .. array_length(v_final_node_ids, 1)
  loop
    if v_previous_node_id is not null then
      insert into process_edges (
        workspace_id, process_template_id, source_node_id, target_node_id
      ) values (
        p_workspace_id, v_template_id, v_previous_node_id, v_final_node_ids[v_index]
      );
    end if;

    v_previous_node_id := v_final_node_ids[v_index];
  end loop;

  return v_template_id;
end;
$$;

create or replace function archive_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  update process_templates
  set archived_at = now(), updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_process_template_id
    and archived_at is null;

  if not found then
    raise exception 'Process template not found or already archived';
  end if;
end;
$$;

create or replace function restore_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  update process_templates
  set archived_at = null, updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_process_template_id
    and archived_at is not null;

  if not found then
    raise exception 'Process template not found or not archived';
  end if;
end;
$$;

-- Blocks hard deletion when any process_runs row references the template
-- (regardless of run status), preserving process history the same way
-- delete_entity_type_if_safe blocks on any record, including archived ones.
create or replace function delete_process_template_if_safe_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns table (
  deleted boolean,
  run_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_count integer := 0;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if not exists (
    select 1 from process_templates
    where workspace_id = p_workspace_id and id = p_process_template_id
  ) then
    raise exception 'Process template not found';
  end if;

  select count(*) into v_run_count
  from process_runs
  where workspace_id = p_workspace_id
    and process_template_id = p_process_template_id;

  if v_run_count > 0 then
    return query select false, v_run_count;
    return;
  end if;

  delete from process_templates
  where workspace_id = p_workspace_id and id = p_process_template_id;

  return query select true, 0;
end;
$$;

-- Manual process start. Resolves the template's node/edge chain into
-- snapshotted step runs: the first human step is activated immediately, the
-- rest are pending. The advisory lock serializes concurrent starts for the
-- same origin record so the "one active run" invariant below is enforced
-- with a friendly error rather than racing the partial unique index.
create or replace function start_process_run_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template process_templates%rowtype;
  v_run_id uuid := gen_random_uuid();
  v_node process_nodes%rowtype;
  v_current_node_id uuid;
  v_step_index integer := 0;
  v_first boolean := true;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  select * into v_template
  from process_templates
  where workspace_id = p_workspace_id
    and id = p_process_template_id
    and archived_at is null;

  if not found then
    raise exception 'Process template not found or archived';
  end if;

  if v_template.applies_to_entity_type_id <> p_origin_entity_type_id then
    raise exception 'Process template does not apply to this record''s entity type';
  end if;

  if not exists (
    select 1 from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_origin_entity_type_id
      and id = p_origin_record_id
      and archived_at is null
  ) then
    raise exception 'Origin record not found or archived';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_origin_record_id::text, 0));

  if exists (
    select 1 from process_runs
    where workspace_id = p_workspace_id
      and process_template_id = p_process_template_id
      and origin_record_id = p_origin_record_id
      and status = 'active'
  ) then
    raise exception 'This process is already running for this record';
  end if;

  insert into process_runs (
    id, workspace_id, process_template_id, process_template_name,
    process_template_description, origin_entity_type_id, origin_record_id, status
  ) values (
    v_run_id, p_workspace_id, p_process_template_id, v_template.name,
    v_template.description, p_origin_entity_type_id, p_origin_record_id, 'active'
  );

  select n.id into v_current_node_id
  from process_nodes n
  where n.workspace_id = p_workspace_id
    and n.process_template_id = p_process_template_id
    and not exists (
      select 1 from process_edges e
      where e.workspace_id = p_workspace_id
        and e.process_template_id = p_process_template_id
        and e.target_node_id = n.id
    );

  if v_current_node_id is null then
    raise exception 'Process template has no steps';
  end if;

  while v_current_node_id is not null loop
    select * into v_node
    from process_nodes
    where workspace_id = p_workspace_id and id = v_current_node_id;

    v_step_index := v_step_index + 1;

    insert into process_step_runs (
      id, workspace_id, process_run_id, source_node_id, step_index,
      node_type, name, config, status, started_at
    ) values (
      gen_random_uuid(), p_workspace_id, v_run_id, v_node.id, v_step_index,
      v_node.node_type, v_node.name, v_node.config,
      case when v_first then 'active' else 'pending' end,
      case when v_first then now() else null end
    );

    v_first := false;

    select e.target_node_id into v_current_node_id
    from process_edges e
    where e.workspace_id = p_workspace_id
      and e.process_template_id = p_process_template_id
      and e.source_node_id = v_current_node_id;
  end loop;

  return v_run_id;
end;
$$;

-- Completes the given step (must currently be active), activates the next
-- step by step_index, or completes the run if there is none. Atomic;
-- rejects cross-workspace/foreign IDs by simply not finding the row.
create or replace function complete_process_step_run_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_run process_step_runs%rowtype;
  v_next_step_run_id uuid;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  select * into v_step_run
  from process_step_runs
  where workspace_id = p_workspace_id
    and process_run_id = p_process_run_id
    and id = p_step_run_id
  for update;

  if not found then
    raise exception 'Step not found';
  end if;

  if v_step_run.status <> 'active' then
    raise exception 'This step is not active';
  end if;

  update process_step_runs
  set status = 'completed', completed_at = now()
  where workspace_id = p_workspace_id and id = p_step_run_id;

  select id into v_next_step_run_id
  from process_step_runs
  where workspace_id = p_workspace_id
    and process_run_id = p_process_run_id
    and step_index = v_step_run.step_index + 1;

  if v_next_step_run_id is not null then
    update process_step_runs
    set status = 'active', started_at = now()
    where workspace_id = p_workspace_id and id = v_next_step_run_id;
  else
    update process_runs
    set status = 'completed', completed_at = now()
    where workspace_id = p_workspace_id and id = p_process_run_id;
  end if;
end;
$$;

revoke all on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public;
revoke all on function archive_process_template_authorized(uuid, uuid) from public;
revoke all on function restore_process_template_authorized(uuid, uuid) from public;
revoke all on function delete_process_template_if_safe_authorized(uuid, uuid) from public;
revoke all on function start_process_run_authorized(uuid, uuid, uuid, uuid) from public;
revoke all on function complete_process_step_run_authorized(uuid, uuid, uuid) from public;

grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function archive_process_template_authorized(uuid, uuid) to authenticated, service_role;
grant execute on function restore_process_template_authorized(uuid, uuid) to authenticated, service_role;
grant execute on function delete_process_template_if_safe_authorized(uuid, uuid) to authenticated, service_role;
grant execute on function start_process_run_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function complete_process_step_run_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb)
  is 'Membership-checked security-definer create/replace for a process template and its linear step chain. Preserves existing process_node IDs for steps re-submitted by ID; rebuilds process_edges from the submitted order.';
comment on function start_process_run_authorized(uuid, uuid, uuid, uuid)
  is 'Membership-checked security-definer manual process start. Snapshots template identity and each node into a new process_run/process_step_runs, activates the first step. Rejects a second concurrent active run for the same template+origin record.';
comment on function complete_process_step_run_authorized(uuid, uuid, uuid)
  is 'Membership-checked security-definer completion of the active step on a process run. Activates the next step by step_index, or completes the run if none remains.';

-- Extend the existing safe-delete checks so process history cannot silently
-- lose its business-object origin. The return shape gains a column, which
-- CREATE OR REPLACE cannot do for a TABLE-returning function, so both the
-- base functions and their authorized wrappers are dropped and recreated,
-- matching how migration 0020 handled the same situation for workflows.

drop function delete_entity_type_if_safe_authorized(uuid, uuid);
drop function delete_entity_type_if_safe(uuid, uuid);

create function delete_entity_type_if_safe(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns table (
  deleted boolean,
  record_count integer,
  relation_field_count integer,
  workflow_target_count integer,
  process_template_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_record_count integer := 0;
  v_relation_field_count integer := 0;
  v_workflow_target_count integer := 0;
  v_process_template_count integer := 0;
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

  if v_record_count > 0
    or v_relation_field_count > 0
    or v_workflow_target_count > 0
    or v_process_template_count > 0 then
    return query select
      false, v_record_count, v_relation_field_count,
      v_workflow_target_count, v_process_template_count;
    return;
  end if;

  delete from entity_types
  where workspace_id = p_workspace_id
    and id = p_entity_type_id;

  return query select true, 0, 0, 0, 0;
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
  process_template_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select * from delete_entity_type_if_safe(p_workspace_id, p_entity_type_id);
end;
$$;

revoke all on function delete_entity_type_if_safe(uuid, uuid) from public, authenticated;
grant execute on function delete_entity_type_if_safe(uuid, uuid) to service_role;

revoke all on function delete_entity_type_if_safe_authorized(uuid, uuid) from public;
grant execute on function delete_entity_type_if_safe_authorized(uuid, uuid) to authenticated, service_role;

comment on function delete_entity_type_if_safe(uuid, uuid)
  is 'Safely hard-deletes an entity type. Blocks deletion when the entity has records, when another field declares a relation to it, when any workflow action creates records in it, or when a process template (active or archived) applies to it.';
comment on function delete_entity_type_if_safe_authorized(uuid, uuid)
  is 'Membership-checked security-definer wrapper for safe entity deletion.';

drop function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid);
drop function delete_entity_record_if_unreferenced(uuid, uuid, uuid);

create function delete_entity_record_if_unreferenced(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns table (
  deleted boolean,
  reference_count integer,
  process_run_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_reference_count integer := 0;
  v_process_run_count integer := 0;
begin
  if not exists (
    select 1
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_record_id
  ) then
    raise exception 'Record not found';
  end if;

  select count(*)
    into v_reference_count
  from entity_record_relation_values
  where workspace_id = p_workspace_id
    and target_entity_type_id = p_entity_type_id
    and target_record_id = p_record_id;

  select count(*)
    into v_process_run_count
  from process_runs
  where workspace_id = p_workspace_id
    and origin_entity_type_id = p_entity_type_id
    and origin_record_id = p_record_id;

  if v_reference_count > 0 or v_process_run_count > 0 then
    return query select false, v_reference_count, v_process_run_count;
    return;
  end if;

  delete from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  return query select true, 0, 0;
end;
$$;

create function delete_entity_record_if_unreferenced_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns table (
  deleted boolean,
  reference_count integer,
  process_run_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select * from delete_entity_record_if_unreferenced(
    p_workspace_id, p_entity_type_id, p_record_id
  );
end;
$$;

revoke all on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) from public, authenticated;
grant execute on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) to service_role;

revoke all on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) from public;
grant execute on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on function delete_entity_record_if_unreferenced(uuid, uuid, uuid)
  is 'Safely hard-deletes a record. Blocks deletion when another record relation references it, or when any process run originates from it.';
comment on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid)
  is 'Membership-checked security-definer wrapper for safe record deletion.';
