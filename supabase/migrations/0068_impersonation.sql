-- Phase 8E.2: Admin Impersonation ("Log in as"). Real actor stays whoever
-- auth.uid() actually is -- that can never be changed by a cookie, a header,
-- or an RPC parameter, since it comes straight from the request's JWT. So
-- this migration does not try to make Postgres believe the caller is
-- someone else. Instead it adds one narrow, explicitly-verified helper
-- (private.current_effective_user) that a small, deliberately curated set
-- of capability checks and RPCs can opt into -- everything else in this
-- schema is completely untouched and structurally cannot be affected by an
-- active impersonation session, because it never calls the new functions.
--
-- Scope (approved): records.operate and processes.operate become genuinely
-- effective-user-authorized, at the RLS/RPC layer, not merely hidden in the
-- UI. workspace.manage_members/manage_roles/manage_organization/manage_settings,
-- schema.manage, and automation.manage all remain bound to the real actor --
-- governance and builder actions are simply not something impersonation
-- reaches; an admin who wants to make one of those changes exits
-- impersonation first, exactly as before this migration existed.

-- 1. Capability. Backfilled onto the built-in "Workspace administrator"
-- role specifically because that role is documented (0045) as "Compatibility
-- role with full workspace access" -- a stated invariant, not an accident of
-- the original seed script, so a new capability being silently excluded from
-- it would break that documented promise. Custom roles never receive it
-- automatically.
alter table workspace_role_capabilities drop constraint if exists workspace_role_capabilities_capability_check;
alter table workspace_role_capabilities add constraint workspace_role_capabilities_capability_check
  check (capability in (
    'workspace.manage_members', 'workspace.manage_roles', 'workspace.manage_organization', 'workspace.manage_settings',
    'schema.manage', 'automation.manage', 'records.operate', 'processes.operate', 'operations.view',
    'workspace.impersonate_users'
  ));

insert into workspace_role_capabilities (workspace_id, role_id, capability)
select role.workspace_id, role.id, 'workspace.impersonate_users'
from workspace_roles role
where role.is_builtin = true
  and not exists (
    select 1 from workspace_role_capabilities existing
    where existing.workspace_id = role.workspace_id and existing.role_id = role.id
      and existing.capability = 'workspace.impersonate_users'
  );

-- The role-management RPCs validate incoming capability values against
-- their own inline vocabulary list (independent of the table CHECK
-- constraint above) -- without this, the role editor would reject
-- workspace.impersonate_users as "Invalid capability" the moment anyone
-- tried to grant it to a custom role. Reproduced in full from their current
-- live bodies (0054) with the one new value added to each list.
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
      'workspace.impersonate_users'
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
      'workspace.impersonate_users'
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

-- 2. Session table. One real actor may have at most one open session at a
-- time (enforced in start_impersonation_session_authorized by ending any
-- prior open one, not by a partial unique index -- a short overlap during
-- the ending/starting transaction is harmless since both rows still
-- correctly scope to the same real_actor_user_id). RLS is deliberately the
-- simplest possible shape: an admin may only ever see/touch their own
-- sessions. There is no select policy for the target -- the effective user
-- has no visibility into being impersonated via this table; the banner is
-- the actual notice, driven by the real actor's own request.
create table impersonation_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  real_actor_user_id uuid not null,
  effective_user_id uuid not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  check (real_actor_user_id <> effective_user_id)
);
create index impersonation_sessions_real_actor_open_idx
  on impersonation_sessions (real_actor_user_id)
  where ended_at is null;

alter table impersonation_sessions enable row level security;
revoke all on table impersonation_sessions from public, anon, authenticated;
create policy impersonation_sessions_select_own on impersonation_sessions
  for select to authenticated
  using (real_actor_user_id = (select auth.uid()));

-- 3. Audit. actor_user_id keeps meaning "the effective/operational actor"
-- for every event type, unchanged -- process_started and approval_decided
-- will now carry the effective user's id while impersonating, exactly as
-- they would for that person acting directly. real_actor_user_id is new,
-- nullable, and populated only where an admin is actually impersonating at
-- the moment of the event -- this is not a general audit column and this
-- migration does not claim broader CRUD audit coverage than already existed
-- (most mutations in this app still emit no durable event at all,
-- impersonated or not).
alter table workspace_events add column if not exists real_actor_user_id uuid;

alter table workspace_events drop constraint workspace_events_event_type_check;
alter table workspace_events add constraint workspace_events_event_type_check
  check (event_type in (
    'step_assigned', 'step_due_soon', 'step_overdue', 'recurrence_started_process',
    'process_started', 'process_completed', 'approval_decided',
    'impersonation_started', 'impersonation_ended'
  ));

-- 4. The effective-identity primitive. SQL/stable, mirroring auth.uid()
-- itself in shape -- "a cheap function call that reads request-scoped
-- context," just backed by a table lookup instead of a JWT claim. Falls
-- back to auth.uid() the instant the target is no longer an active member
-- of this workspace, even if nothing has explicitly ended the session row
-- yet -- impersonated authority can never outlive the target's membership.
-- This is the safety boundary; resolveImpersonationContext (app layer)
-- separately detects this same condition to end the session and clear the
-- cookie so the UI never keeps showing an impersonation that has silently
-- stopped conferring any authority.
create function private.current_effective_user(p_workspace_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.effective_user_id
     from public.impersonation_sessions s
     join public.workspace_memberships target
       on target.workspace_id = s.workspace_id
      and target.user_id = s.effective_user_id
      and target.deactivated_at is null
     where s.workspace_id = p_workspace_id
       and s.real_actor_user_id = (select auth.uid())
       and s.ended_at is null
     limit 1),
    (select auth.uid())
  )
$$;

-- 5. Effective-identity capability checks. Deliberately NEW, separately
-- named functions rather than an in-place extension of
-- private.is_workspace_member/private.has_workspace_capability: those two
-- are called from dozens of RLS policies and RPC bodies across this schema,
-- and Postgres cannot widen a function's parameter list via CREATE OR
-- REPLACE without either creating a silently-coexisting overload (if the
-- old one is left in place) or a DROP, which fails outright while so many
-- objects depend on it (short of a CASCADE that would take every dependent
-- policy/RPC down with it -- unacceptable). Adding sibling functions instead
-- means every one of those existing call sites is untouched by this
-- migration, byte for byte -- only the finite set of call sites below that
-- explicitly opt in ever resolve an effective identity at all.
create function private.is_workspace_member_as(p_workspace_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships membership
    where membership.workspace_id = p_workspace_id
      and membership.user_id = p_user_id
      and membership.deactivated_at is null
  )
$$;

create function private.has_workspace_capability_as(p_workspace_id uuid, p_capability text, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships membership
    join public.workspace_role_capabilities capability
      on capability.workspace_id = membership.workspace_id and capability.role_id = membership.role_id
    where membership.workspace_id = p_workspace_id
      and membership.user_id = p_user_id
      and membership.deactivated_at is null
      and capability.capability = p_capability
  )
$$;

create function private.require_effective_workspace_capability(p_workspace_id uuid, p_capability text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := private.current_effective_user(p_workspace_id);
begin
  if not private.is_workspace_member_as(p_workspace_id, v_user_id) then raise exception 'Workspace access denied'; end if;
  if not private.has_workspace_capability_as(p_workspace_id, p_capability, v_user_id) then raise exception 'Permission denied: %', p_capability; end if;
end;
$$;

create function private.require_effective_interactive_workspace_capability(p_workspace_id uuid, p_capability text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'service_role' then return; end if;
  perform private.require_effective_workspace_capability(p_workspace_id, p_capability);
end;
$$;

-- 6. RLS: the only three tables in this schema enforcing a capability
-- directly at the row-security layer rather than inside a SECURITY DEFINER
-- RPC (0048) -- record archive/restore and all saved-view CRUD go through
-- these raw policies, not a wrapper function, so making records.operate
-- genuinely effective-aware requires editing the policies themselves, not
-- just RPC bodies. schema.manage's and automation.manage's equivalent
-- policies (entity_types_schema_write, field_definitions_schema_write,
-- workflows_automation_write) are deliberately NOT touched -- those stay
-- real-actor-bound per the approved scope.
alter policy entity_records_operate_write on entity_records
  using ((select private.has_workspace_capability_as(workspace_id, 'records.operate', private.current_effective_user(workspace_id))))
  with check ((select private.has_workspace_capability_as(workspace_id, 'records.operate', private.current_effective_user(workspace_id))));

alter policy relation_values_operate_write on entity_record_relation_values
  using ((select private.has_workspace_capability_as(workspace_id, 'records.operate', private.current_effective_user(workspace_id))))
  with check ((select private.has_workspace_capability_as(workspace_id, 'records.operate', private.current_effective_user(workspace_id))));

alter policy entity_views_operate_write on entity_views
  using ((select private.has_workspace_capability_as(workspace_id, 'records.operate', private.current_effective_user(workspace_id))))
  with check ((select private.has_workspace_capability_as(workspace_id, 'records.operate', private.current_effective_user(workspace_id))));

-- 7. records.operate RPC wrappers. Each is a thin capability-check-then-
-- delegate wrapper already (0046/0052) -- the only change is which
-- capability-check function each one calls. None of these write any actor
-- column for the record itself (confirmed by inspection: entity_records has
-- no created_by/updated_by column), so no further change is needed inside
-- them for correct effective-user attribution.
create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return create_entity_record_with_relations(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    p_originating_process_step_run_id
  );
end;
$$;

create or replace function update_entity_record_with_relations_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid, p_values jsonb,
  p_relation_field_ids jsonb, p_relations jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return update_entity_record_with_relations(p_workspace_id, p_entity_type_id, p_record_id, p_values, p_relation_field_ids, p_relations);
end;
$$;

create or replace function delete_entity_record_if_unreferenced_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid
)
returns table (deleted boolean, reference_count integer, process_run_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return query select * from delete_entity_record_if_unreferenced(p_workspace_id, p_entity_type_id, p_record_id);
end;
$$;

-- 8. processes.operate RPC wrappers -- the same two-line
-- capability-check-then-delegate shape (0047) covering start/complete/
-- decide/action-step. Only the capability-check line changes in each.
create or replace function start_process_run_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return start_process_run_authorized_member(
    p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id,
    private.current_effective_user(p_workspace_id), p_originating_process_step_run_id
  );
end;
$$;

create or replace function start_process_run_via_workflow_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return start_process_run_authorized_member(
    p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id,
    null, p_originating_process_step_run_id
  );
end;
$$;

create or replace function complete_process_step_run_authorized(p_workspace_id uuid, p_process_run_id uuid, p_step_run_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  perform complete_process_step_run_authorized_member(p_workspace_id, p_process_run_id, p_step_run_id);
end; $$;

create or replace function decide_process_approval_authorized(p_workspace_id uuid, p_process_run_id uuid, p_step_run_id uuid, p_outcome_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  perform decide_process_approval_authorized_member(p_workspace_id, p_process_run_id, p_step_run_id, p_outcome_id);
end; $$;

create or replace function complete_process_action_step_authorized(p_workspace_id uuid, p_process_run_id uuid, p_step_run_id uuid, p_action_result jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return complete_process_action_step_authorized_member(p_workspace_id, p_process_run_id, p_step_run_id, p_action_result);
end; $$;

create or replace function fail_process_action_step_authorized(p_workspace_id uuid, p_process_run_id uuid, p_step_run_id uuid, p_action_result jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$ begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  return fail_process_action_step_authorized_member(p_workspace_id, p_process_run_id, p_step_run_id, p_action_result);
end; $$;

-- 9. The two functions with real per-row identity-equality logic, not just
-- a capability check -- these are the actual "complete/approve as the
-- effective user" surface, and the only inner-logic changes this migration
-- makes. Reproduced in full from their current live bodies (0033's rename
-- target and 0065 respectively) with auth.uid() replaced by a single
-- resolved v_effective_user_id everywhere it previously meant "the acting
-- member," including the assignee check, the decided_by attribution, and
-- the workspace_events actor.
create or replace function complete_process_step_run_authorized_member(
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
  v_run process_runs%rowtype;
  v_target_step_run process_step_runs%rowtype;
  v_route process_step_run_routes%rowtype;
  v_default_route process_step_run_routes%rowtype;
  v_route_count integer;
  v_default_count integer;
  v_selected_route_id uuid;
  v_outcome text;
  v_evaluation jsonb;
  v_evaluated_conditions jsonb := '[]'::jsonb;
  v_activation_at timestamptz := now();
  v_arrived_count integer := 0;
  v_effective_user_id uuid := private.current_effective_user(p_workspace_id);
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));
  select * into v_run from process_runs
  where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active' for update;
  if not found then raise exception 'Process run is not active'; end if;
  select * into v_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found then raise exception 'Step not found'; end if;
  if v_step_run.node_type <> 'human_task' then raise exception 'System process steps advance automatically'; end if;
  if v_step_run.status <> 'active' then raise exception 'This step is not active'; end if;
  if v_step_run.assignee_user_id is not null and v_step_run.assignee_user_id <> v_effective_user_id then
    raise exception 'This step is assigned to another member';
  end if;
  perform 1 from entity_records where workspace_id = p_workspace_id
    and entity_type_id = v_run.origin_entity_type_id and id = v_run.origin_record_id and archived_at is null for share;
  if not found then raise exception 'Origin record not found or archived'; end if;

  select count(*), count(*) filter (where is_default)
    into v_route_count, v_default_count
  from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = p_step_run_id;

  if v_route_count = 0 then
    if v_step_run.parallel_branch_token is not null
      or exists (
        select 1 from process_step_runs
        where workspace_id = p_workspace_id and process_run_id = p_process_run_id
          and status = 'active' and id <> p_step_run_id
      )
      or exists (
        select 1 from process_parallel_join_obligations
        where workspace_id = p_workspace_id and process_run_id = p_process_run_id and arrived_at is null
      ) then
      raise exception 'Process cannot terminate while parallel work remains';
    end if;
    update process_step_runs set status = 'completed', completed_at = v_activation_at
    where workspace_id = p_workspace_id and id = p_step_run_id;
    perform private.try_complete_process_run(p_workspace_id, p_process_run_id, v_activation_at);
    return;
  end if;

  if v_default_count <> 1 then raise exception 'Process route configuration has no unambiguous default'; end if;
  select * into v_default_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id
    and source_step_run_id = p_step_run_id and is_default;
  if v_route_count = 1 then
    v_selected_route_id := v_default_route.id;
    v_outcome := 'unconditional';
  else
    for v_route in select * from process_step_run_routes
      where workspace_id = p_workspace_id and process_run_id = p_process_run_id
        and source_step_run_id = p_step_run_id and not is_default
      order by priority
    loop
      v_evaluation := private.evaluate_process_branch_conditions(
        p_workspace_id, v_run.origin_entity_type_id, v_run.origin_record_id, v_route.condition_config
      );
      v_evaluated_conditions := v_evaluated_conditions || coalesce(v_evaluation->'conditions', '[]'::jsonb);
      if coalesce((v_evaluation->>'matched')::boolean, false) then
        v_selected_route_id := v_route.id;
        v_outcome := 'matched_condition';
        exit;
      end if;
    end loop;
    if v_selected_route_id is null then
      v_selected_route_id := v_default_route.id;
      v_outcome := 'default_fallback';
    end if;
  end if;

  select * into v_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_selected_route_id;
  select * into v_target_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_route.target_step_run_id for update;
  if not found or v_target_step_run.status <> 'pending' then raise exception 'Process route target is not available'; end if;

  update process_step_runs set status = 'completed', completed_at = v_activation_at,
    routing_result = jsonb_build_object(
      'selectedRouteId', v_route.id,
      'targetStepRunId', v_target_step_run.id,
      'outcome', v_outcome,
      'evaluatedAt', v_activation_at,
      'evaluatedConditions', v_evaluated_conditions
    )
  where workspace_id = p_workspace_id and id = p_step_run_id;

  if v_step_run.parallel_branch_token is null then
    with recursive reachable(step_run_id) as (
      select v_target_step_run.id
      union
      select route.target_step_run_id
      from process_step_run_routes route
      join reachable on reachable.step_run_id = route.source_step_run_id
      where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id
    )
    update process_step_runs step_run
    set status = 'skipped', due_at = null
    where step_run.workspace_id = p_workspace_id
      and step_run.process_run_id = p_process_run_id
      and step_run.status = 'pending'
      and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  else
    with recursive reachable(step_run_id) as (
      select v_target_step_run.id
      union
      select route.target_step_run_id
      from process_step_run_routes route
      join reachable on reachable.step_run_id = route.source_step_run_id
      where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id
        and route.target_step_run_id <> v_target_step_run.id
    )
    update process_step_runs step_run
    set status = 'skipped', due_at = null
    where step_run.workspace_id = p_workspace_id
      and step_run.process_run_id = p_process_run_id
      and step_run.status = 'pending'
      and step_run.parallel_branch_token = v_step_run.parallel_branch_token
      and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  end if;

  if v_target_step_run.node_type = 'parallel_join' then
    if v_step_run.parallel_branch_token is null then
      raise exception 'Only a parallel branch may arrive at a parallel join';
    end if;
    update process_parallel_join_obligations
    set arrived_at = v_activation_at, arrival_source_step_run_id = p_step_run_id
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id
      and join_step_run_id = v_target_step_run.id
      and branch_token = v_step_run.parallel_branch_token
      and arrived_at is null;
    get diagnostics v_arrived_count = row_count;
    if v_arrived_count <> 1 then raise exception 'Parallel join obligation is not available'; end if;
    if not exists (
      select 1 from process_parallel_join_obligations
      where workspace_id = p_workspace_id and process_run_id = p_process_run_id
        and join_step_run_id = v_target_step_run.id and arrived_at is null
    ) then
      perform private.activate_process_step_run(
        p_workspace_id, p_process_run_id, v_target_step_run.id, v_activation_at, null
      );
    end if;
  else
    perform private.activate_process_step_run(
      p_workspace_id, p_process_run_id, v_target_step_run.id, v_activation_at,
      v_step_run.parallel_branch_token
    );
  end if;
end;
$$;

create or replace function decide_process_approval_authorized_member(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_outcome_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_run process_step_runs%rowtype;
  v_run process_runs%rowtype;
  v_target_step_run process_step_runs%rowtype;
  v_route process_step_run_routes%rowtype;
  v_activation_at timestamptz := now();
  v_arrived_count integer := 0;
  v_decided_by_label text;
  v_effective_user_id uuid;
  v_real_actor_user_id uuid;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if auth.uid() is null then raise exception 'Approval decisions require an authenticated user'; end if;
  v_effective_user_id := private.current_effective_user(p_workspace_id);
  v_real_actor_user_id := case when auth.uid() <> v_effective_user_id then auth.uid() else null end;
  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));
  select * into v_run from process_runs where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active' for update;
  if not found then raise exception 'Process run is not active'; end if;
  select * into v_step_run from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found then raise exception 'Step not found'; end if;
  if v_step_run.node_type <> 'approval' then raise exception 'This step is not an approval'; end if;
  if v_step_run.status <> 'active' then raise exception 'This approval is not active'; end if;
  if v_step_run.assignee_user_id is not null and v_step_run.assignee_user_id <> v_effective_user_id then raise exception 'This approval is assigned to another member'; end if;
  perform 1 from entity_records where workspace_id = p_workspace_id and entity_type_id = v_run.origin_entity_type_id and id = v_run.origin_record_id and archived_at is null for share;
  if not found then raise exception 'Origin record not found or archived'; end if;
  select * into v_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = p_step_run_id and approval_outcome_id = p_outcome_id
  for update;
  if not found then raise exception 'Approval outcome is not available for this step'; end if;
  select * into v_target_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_route.target_step_run_id for update;
  if not found or v_target_step_run.status <> 'pending' then raise exception 'Process route target is not available'; end if;
  select email into v_decided_by_label from auth.users where id = v_effective_user_id;
  if v_decided_by_label is null then raise exception 'Approval decision user was not found'; end if;

  update process_step_runs
  set status = 'completed', completed_at = v_activation_at,
    approval_outcome_id = v_route.approval_outcome_id,
    approval_outcome_label = v_route.approval_outcome_label,
    decided_at = v_activation_at,
    decided_by_user_id = v_effective_user_id,
    decided_by_label = v_decided_by_label,
    routing_result = jsonb_build_object(
      'selectedRouteId', v_route.id,
      'targetStepRunId', v_target_step_run.id,
      'outcome', 'approval_outcome',
      'approvalOutcomeId', v_route.approval_outcome_id,
      'approvalOutcomeLabel', v_route.approval_outcome_label,
      'evaluatedAt', v_activation_at
    )
  where workspace_id = p_workspace_id and id = p_step_run_id;

  begin
    insert into workspace_events (
      id, workspace_id, actor_user_id, real_actor_user_id, event_type, entity_type_id, entity_record_id,
      process_template_id, process_run_id, process_step_run_id
    )
    values (
      gen_random_uuid(), p_workspace_id, v_effective_user_id, v_real_actor_user_id, 'approval_decided', v_run.origin_entity_type_id, v_run.origin_record_id,
      v_run.process_template_id, p_process_run_id, p_step_run_id
    );
  exception when others then
    null;
  end;

  if v_step_run.parallel_branch_token is null then
    with recursive reachable(step_run_id) as (
      select v_target_step_run.id
      union
      select route.target_step_run_id
      from process_step_run_routes route
      join reachable on reachable.step_run_id = route.source_step_run_id
      where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id
    )
    update process_step_runs step_run
    set status = 'skipped', due_at = null
    where step_run.workspace_id = p_workspace_id and step_run.process_run_id = p_process_run_id
      and step_run.status = 'pending'
      and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  else
    with recursive reachable(step_run_id) as (
      select v_target_step_run.id
      union
      select route.target_step_run_id
      from process_step_run_routes route
      join reachable on reachable.step_run_id = route.source_step_run_id
      where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id
        and route.target_step_run_id <> v_target_step_run.id
    )
    update process_step_runs step_run
    set status = 'skipped', due_at = null
    where step_run.workspace_id = p_workspace_id and step_run.process_run_id = p_process_run_id
      and step_run.status = 'pending' and step_run.parallel_branch_token = v_step_run.parallel_branch_token
      and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  end if;

  if v_target_step_run.node_type = 'parallel_join' then
    if v_step_run.parallel_branch_token is null then raise exception 'Only a parallel branch may arrive at a parallel join'; end if;
    update process_parallel_join_obligations
    set arrived_at = v_activation_at, arrival_source_step_run_id = p_step_run_id
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id
      and join_step_run_id = v_target_step_run.id and branch_token = v_step_run.parallel_branch_token and arrived_at is null;
    get diagnostics v_arrived_count = row_count;
    if v_arrived_count <> 1 then raise exception 'Parallel join obligation is not available'; end if;
    if not exists (select 1 from process_parallel_join_obligations where workspace_id = p_workspace_id and process_run_id = p_process_run_id and join_step_run_id = v_target_step_run.id and arrived_at is null) then
      perform private.activate_process_step_run(p_workspace_id, p_process_run_id, v_target_step_run.id, v_activation_at, null);
    end if;
  else
    perform private.activate_process_step_run(p_workspace_id, p_process_run_id, v_target_step_run.id, v_activation_at, v_step_run.parallel_branch_token);
  end if;
end;
$$;

-- 10. start_process_run_authorized_member's signature is unchanged
-- (p_actor_user_id is already an explicit parameter, not resolved from
-- auth.uid() internally -- 0065 made that a required argument specifically
-- so no caller could silently default it). What changes: the public wrapper
-- above now passes the effective user rather than auth.uid(), and this
-- function additionally records real_actor_user_id on the process_started
-- event by comparing the two -- null whenever they match (not impersonating,
-- or a system/workflow start where p_actor_user_id is null and this
-- comparison is skipped entirely).
create or replace function start_process_run_authorized_member(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_actor_user_id uuid,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template process_templates%rowtype;
  v_existing_run_id uuid;
  v_run_id uuid := gen_random_uuid();
  v_start_node_id uuid;
  v_start_step_run_id uuid;
  v_activation_at timestamptz := now();
  v_node process_nodes%rowtype;
  v_assignee_label text;
  v_node_count integer;
  v_start_count integer;
  v_edge process_edges%rowtype;
  v_real_actor_user_id uuid := case when p_actor_user_id is not null and p_actor_user_id <> auth.uid() then auth.uid() else null end;
begin
  if auth.role() <> 'service_role' and not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if p_originating_process_step_run_id is not null then
    select id into v_existing_run_id from process_runs
    where workspace_id = p_workspace_id and originating_process_step_run_id = p_originating_process_step_run_id;
    if found then
      return v_existing_run_id;
    end if;
  end if;

  select * into v_template from process_templates where workspace_id = p_workspace_id and id = p_process_template_id and archived_at is null;
  if not found then raise exception 'Process template not found or archived'; end if;
  if v_template.applies_to_entity_type_id <> p_origin_entity_type_id then raise exception 'Process template does not apply to this record''s entity type'; end if;
  if not exists (select 1 from entity_records where workspace_id = p_workspace_id and entity_type_id = p_origin_entity_type_id and id = p_origin_record_id and archived_at is null) then raise exception 'Origin record not found or archived'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_origin_record_id::text, 0));
  if exists (select 1 from process_runs where workspace_id = p_workspace_id and process_template_id = p_process_template_id and origin_record_id = p_origin_record_id and status = 'active') then raise exception 'This process is already running for this record'; end if;
  select count(*) into v_node_count from process_nodes where workspace_id = p_workspace_id and process_template_id = p_process_template_id;
  if v_node_count = 0 then raise exception 'Process template has no steps'; end if;
  perform private.validate_process_parallel_template(p_workspace_id, p_process_template_id);
  perform private.validate_process_approval_template(p_workspace_id, p_process_template_id);
  select count(*), (array_agg(node.id order by node.position))[1] into v_start_count, v_start_node_id
  from process_nodes node
  where node.workspace_id = p_workspace_id and node.process_template_id = p_process_template_id
    and not exists (select 1 from process_edges edge where edge.workspace_id = p_workspace_id and edge.process_template_id = p_process_template_id and edge.target_node_id = node.id);
  if v_start_count <> 1 then raise exception 'Process template must have exactly one start step'; end if;
  for v_edge in select * from process_edges where workspace_id = p_workspace_id and process_template_id = p_process_template_id and not is_default and not is_parallel and approval_outcome_id is null loop
    perform private.validate_process_branch_conditions(p_workspace_id, p_origin_entity_type_id, v_edge.condition_config);
  end loop;
  insert into process_runs (id, workspace_id, process_template_id, process_template_name, process_template_description, origin_entity_type_id, origin_record_id, status, originating_process_step_run_id)
  values (v_run_id, p_workspace_id, p_process_template_id, v_template.name, v_template.description, p_origin_entity_type_id, p_origin_record_id, 'active', p_originating_process_step_run_id);

  begin
    insert into workspace_events (
      id, workspace_id, actor_user_id, real_actor_user_id, event_type, entity_type_id, entity_record_id,
      process_template_id, process_run_id
    )
    values (
      gen_random_uuid(), p_workspace_id, p_actor_user_id, v_real_actor_user_id, 'process_started', p_origin_entity_type_id, p_origin_record_id,
      p_process_template_id, v_run_id
    );
  exception when others then
    null;
  end;

  for v_node in select * from process_nodes where workspace_id = p_workspace_id and process_template_id = p_process_template_id order by position loop
    v_assignee_label := null;
    if v_node.node_type in ('human_task', 'approval') and v_node.assignee_user_id is not null then select email into v_assignee_label from auth.users where id = v_node.assignee_user_id; end if;
    insert into process_step_runs (id, workspace_id, process_run_id, source_node_id, step_index, node_type, parallel_group_id, name, config, status, assignee_user_id, assignee_label)
    values (gen_random_uuid(), p_workspace_id, v_run_id, v_node.id, v_node.position, v_node.node_type, v_node.parallel_group_id, v_node.name, v_node.config, 'pending', case when v_node.node_type in ('human_task', 'approval') then v_node.assignee_user_id else null end, v_assignee_label);
  end loop;
  insert into process_step_run_routes (workspace_id, process_run_id, source_step_run_id, target_step_run_id, source_node_id, target_node_id, priority, condition_config, condition_summary, is_default, is_parallel, approval_outcome_id, approval_outcome_label)
  select edge.workspace_id, v_run_id, source_step.id, target_step.id, edge.source_node_id, edge.target_node_id, edge.priority, edge.condition_config,
    case when edge.is_default or edge.is_parallel or edge.approval_outcome_id is not null then null else private.process_branch_condition_summary(p_workspace_id, p_origin_entity_type_id, edge.condition_config) end,
    edge.is_default, edge.is_parallel, edge.approval_outcome_id, edge.approval_outcome_label
  from process_edges edge
  join process_step_runs source_step on source_step.workspace_id = edge.workspace_id and source_step.process_run_id = v_run_id and source_step.source_node_id = edge.source_node_id
  join process_step_runs target_step on target_step.workspace_id = edge.workspace_id and target_step.process_run_id = v_run_id and target_step.source_node_id = edge.target_node_id
  where edge.workspace_id = p_workspace_id and edge.process_template_id = p_process_template_id;
  select id into v_start_step_run_id from process_step_runs where workspace_id = p_workspace_id and process_run_id = v_run_id and source_node_id = v_start_node_id;
  perform private.activate_process_step_run(p_workspace_id, v_run_id, v_start_step_run_id, v_activation_at, null);
  return v_run_id;
end;
$$;

revoke all on function start_process_run_authorized_member(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function start_process_run_authorized_member(uuid, uuid, uuid, uuid, uuid, uuid) to service_role;

-- 11. bulk_create_entity_records_authorized (CSV import, 0061/0062) is a
-- monolithic function, not a thin wrapper -- swap only its capability check
-- for consistency with every other records.operate entry point (an
-- impersonated non-worker should not be able to bulk-import any more than
-- they could create one record by hand). Its record_import_batches.actor_
-- user_id stays real-actor-bound deliberately -- that is a private
-- idempotency-ledger identity column, not a user-facing audit trail, and
-- changing its semantics was not part of the approved scope.
create or replace function bulk_create_entity_records_authorized(
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
  v_existing_count integer;
  v_row jsonb;
  v_values jsonb;
  v_relation jsonb;
  v_record_id uuid;
  v_field field_definitions%rowtype;
  v_inserted_count integer := 0;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty JSON array';
  end if;

  if not exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id and id = p_entity_type_id and archived_at is null
  ) then
    raise exception 'Object not found or archived';
  end if;

  insert into record_import_batches (id, workspace_id, entity_type_id, actor_user_id)
  values (p_import_id, p_workspace_id, p_entity_type_id, auth.uid())
  on conflict (id) do nothing;

  if not found then
    select record_import_batches.imported_row_count into v_existing_count
    from record_import_batches
    where id = p_import_id
      and workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id;

    if not found then
      raise exception 'Import ID already used for a different object';
    end if;

    return query select v_existing_count;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_values := coalesce(v_row->'values', '{}'::jsonb);

    for v_field in
      select *
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and required = true
        and archived_at is null
      order by position
    loop
      if v_field.type = 'relation' then
        if not exists (
          select 1
          from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb)) relation
          where relation->>'field_definition_id' = v_field.id::text
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      elsif v_field.type = 'text' then
        if not (
          v_values ? v_field.key
          and jsonb_typeof(v_values -> v_field.key) = 'string'
          and btrim(v_values ->> v_field.key) <> ''
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      else
        if not (v_values ? v_field.key and v_values -> v_field.key is not null) then
          raise exception '% is required.', v_field.name;
        end if;
      end if;
    end loop;

    v_record_id := gen_random_uuid();
    insert into entity_records (id, workspace_id, entity_type_id, values)
    values (v_record_id, p_workspace_id, p_entity_type_id, v_values);

    for v_relation in select * from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb))
    loop
      insert into entity_record_relation_values (workspace_id, source_record_id, field_definition_id, target_record_id)
      values (p_workspace_id, v_record_id, (v_relation->>'field_definition_id')::uuid, (v_relation->>'target_record_id')::uuid);
    end loop;

    v_inserted_count := v_inserted_count + 1;
  end loop;

  update record_import_batches
  set imported_row_count = v_inserted_count, completed_at = now()
  where id = p_import_id and workspace_id = p_workspace_id and entity_type_id = p_entity_type_id;

  return query select v_inserted_count;
end;
$$;

-- 12. Session lifecycle RPCs. Starting/ending impersonation is itself a
-- privileged, real-actor-only action -- neither of these ever resolves or
-- accepts an effective identity, by construction, so impersonation can
-- never be nested or chained: whoever is really typing (auth.uid(), which
-- no cookie can change) is the only identity that can ever start or end a
-- session.
create function start_impersonation_session_authorized(p_workspace_id uuid, p_target_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.impersonate_users');
  if p_target_user_id = auth.uid() then raise exception 'You cannot impersonate yourself'; end if;
  if not exists (
    select 1 from workspace_memberships
    where workspace_id = p_workspace_id and user_id = p_target_user_id and deactivated_at is null
  ) then
    raise exception 'Member not found or not active in this workspace';
  end if;

  update impersonation_sessions set ended_at = now()
  where real_actor_user_id = auth.uid() and ended_at is null;

  insert into impersonation_sessions (id, workspace_id, real_actor_user_id, effective_user_id)
  values (gen_random_uuid(), p_workspace_id, auth.uid(), p_target_user_id)
  returning id into v_session_id;

  begin
    insert into workspace_events (id, workspace_id, actor_user_id, event_type, metadata)
    values (gen_random_uuid(), p_workspace_id, auth.uid(), 'impersonation_started', jsonb_build_object('effective_user_id', p_target_user_id));
  exception when others then
    null;
  end;

  return v_session_id;
end;
$$;

create function end_impersonation_session_authorized(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_user_id uuid;
  v_workspace_id uuid;
begin
  update impersonation_sessions set ended_at = now()
  where id = p_session_id and real_actor_user_id = auth.uid() and ended_at is null
  returning effective_user_id, workspace_id into v_effective_user_id, v_workspace_id;
  if not found then raise exception 'Impersonation session not found or already ended'; end if;

  begin
    insert into workspace_events (id, workspace_id, actor_user_id, event_type, metadata)
    values (gen_random_uuid(), v_workspace_id, auth.uid(), 'impersonation_ended', jsonb_build_object('effective_user_id', v_effective_user_id));
  exception when others then
    null;
  end;
end;
$$;

-- 13. The one read the app layer needs every request: "am I (the real,
-- literal caller) currently impersonating anyone, and is it still valid?"
-- Self-healing: if the target has since been deactivated, this ends the
-- stale session (and records impersonation_ended) before returning empty,
-- rather than requiring a second round trip from the app to clean it up.
-- resolveImpersonationContext (app layer) treats an empty result as
-- definitive proof there is no valid impersonation -- it clears the cookie
-- and falls back to ordinary real-actor context on that same request, so
-- the banner cannot keep showing a session that has stopped conferring any
-- authority.
create function get_active_impersonation_authorized()
returns table (
  session_id uuid,
  workspace_id uuid,
  effective_user_id uuid,
  effective_email text,
  real_actor_email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session impersonation_sessions%rowtype;
begin
  if auth.uid() is null then return; end if;

  select * into v_session from impersonation_sessions
  where real_actor_user_id = auth.uid() and ended_at is null
  order by started_at desc
  limit 1;

  if not found then return; end if;

  if not exists (
    select 1 from workspace_memberships
    where workspace_id = v_session.workspace_id
      and user_id = v_session.effective_user_id
      and deactivated_at is null
  ) then
    update impersonation_sessions set ended_at = now() where id = v_session.id;
    begin
      insert into workspace_events (id, workspace_id, actor_user_id, event_type, metadata)
      values (gen_random_uuid(), v_session.workspace_id, auth.uid(), 'impersonation_ended', jsonb_build_object('effective_user_id', v_session.effective_user_id, 'reason', 'target_deactivated'));
    exception when others then
      null;
    end;
    return;
  end if;

  return query
  select v_session.id, v_session.workspace_id, v_session.effective_user_id, target.email::text, actor.email::text
  from auth.users target, auth.users actor
  where target.id = v_session.effective_user_id and actor.id = auth.uid();
end;
$$;

revoke all on function start_impersonation_session_authorized(uuid, uuid), end_impersonation_session_authorized(uuid), get_active_impersonation_authorized() from public, anon;
grant execute on function start_impersonation_session_authorized(uuid, uuid), end_impersonation_session_authorized(uuid), get_active_impersonation_authorized() to authenticated, service_role;
