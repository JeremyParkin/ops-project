-- Fixed Process-Step Assignment + My Work (v1): each human_task ProcessNode
-- may have no assignee or exactly one fixed workspace member. Assignment is
-- snapshotted onto ProcessStepRun at run start so later template
-- reassignment never rewrites an already-started run, and so history
-- remains readable even if the assigned member later leaves the workspace.

-- process_nodes.assignee_user_id: a composite FK to workspace_memberships'
-- own primary key structurally guarantees an assignee is always a current
-- member of the *same* workspace, and (with no cascade) blocks removing a
-- membership still referenced by any template node — including nodes on
-- archived templates — until it is reassigned or cleared. There is no
-- membership-removal product feature yet, so this is forward hardening for
-- whenever one exists.
alter table process_nodes
  add column assignee_user_id uuid;

alter table process_nodes
  add constraint process_nodes_assignee_member_fk
  foreign key (workspace_id, assignee_user_id)
  references workspace_memberships(workspace_id, user_id);

-- process_step_runs.assignee_user_id/assignee_label: a soft historical
-- snapshot, matching the existing source_node_id precedent. No FK — a
-- completed run's assignment must remain meaningful (via assignee_label)
-- even after the assigned member leaves the workspace, and must never block
-- that departure.
alter table process_step_runs
  add column assignee_user_id uuid,
  add column assignee_label text;

-- Exposes only user id + email for a requesting member's own workspace, for
-- process assignment UI (the template editor's assignee selector and
-- resolving current labels). No other auth.users metadata is surfaced.
-- Uses the same hardened style as private.is_workspace_member (empty
-- search_path, everything fully schema-qualified) since this is the one
-- process RPC that reads the auth schema directly.
create or replace function list_workspace_member_identities_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select membership.user_id, au.email::text
  from public.workspace_memberships membership
  join auth.users au on au.id = membership.user_id
  where membership.workspace_id = p_workspace_id
  order by au.email;
end;
$$;

revoke all on function list_workspace_member_identities_authorized(uuid) from public;
grant execute on function list_workspace_member_identities_authorized(uuid) to authenticated, service_role;

comment on function list_workspace_member_identities_authorized(uuid)
  is 'Membership-checked security-definer lookup of current workspace members'' user id and email only, for process assignment UI. Exposes no other auth.users metadata.';

-- p_steps elements now also carry an optional assignee_user_id: null/absent
-- means unassigned, otherwise it must already be a member of this workspace
-- (checked here for a friendly error; the process_nodes_assignee_member_fk
-- constraint above is the structural backstop). Reassigning an existing
-- step (submitted by node_id) updates assignee_user_id in place, same as
-- name — node identity and the rest of the linear-chain rebuild are
-- unchanged from migration 0027.
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
  v_step_assignee_user_id uuid;
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
    v_step_assignee_user_id := nullif(v_step->>'assignee_user_id', '')::uuid;

    if v_step_name is null then
      raise exception 'Every step requires a name';
    end if;

    if v_step_assignee_user_id is not null and not exists (
      select 1 from workspace_memberships
      where workspace_id = p_workspace_id
        and user_id = v_step_assignee_user_id
    ) then
      raise exception 'Assignee is not a member of this workspace';
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
          assignee_user_id = v_step_assignee_user_id,
          updated_at = now()
      where workspace_id = p_workspace_id and id = v_step_node_id;
    else
      v_step_node_id := gen_random_uuid();

      insert into process_nodes (
        id, workspace_id, process_template_id, node_type, name, assignee_user_id
      ) values (
        v_step_node_id, p_workspace_id, v_template_id, 'human_task', v_step_name,
        v_step_assignee_user_id
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

-- Now also snapshots each node's assignee_user_id and, when present, the
-- assignee's *current* email as assignee_label — a point-in-time snapshot,
-- not a live reference, so a later template reassignment or the assigned
-- member leaving the workspace never rewrites this run's history.
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
  v_assignee_label text;
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
    v_assignee_label := null;

    if v_node.assignee_user_id is not null then
      select email into v_assignee_label
      from auth.users
      where id = v_node.assignee_user_id;
    end if;

    insert into process_step_runs (
      id, workspace_id, process_run_id, source_node_id, step_index,
      node_type, name, config, status, started_at,
      assignee_user_id, assignee_label
    ) values (
      gen_random_uuid(), p_workspace_id, v_run_id, v_node.id, v_step_index,
      v_node.node_type, v_node.name, v_node.config,
      case when v_first then 'active' else 'pending' end,
      case when v_first then now() else null end,
      v_node.assignee_user_id, v_assignee_label
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

-- Now enforces assignee-only completion: an assigned active step may only
-- be completed by that assignee; an unassigned active step remains
-- completable by any authenticated same-workspace member. This is the
-- canonical enforcement point — the UI additionally hides/disables the
-- Complete action for non-assignees, but never relies on that alone.
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

  if v_step_run.assignee_user_id is not null and v_step_run.assignee_user_id <> auth.uid() then
    raise exception 'This step is assigned to another member';
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
