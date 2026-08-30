-- Phase 8D.2: in-app notifications, plus the thin shared workspace_events
-- foundation approved for Notifications now and Activity (8D.3) later.
--
-- Architecture:
--  - workspace_events is a pure historical log, deliberately modeled like
--    workflow_execution_logs / process_step_runs.source_node_id: its
--    reference columns (entity_type_id, entity_record_id, process_template_
--    id, process_run_id, process_step_run_id) carry NO foreign keys. A log
--    row must never block deletion of the business object it describes, and
--    must survive gracefully if that object is later removed -- exactly the
--    reasoning already established for those two precedents. This is a
--    different posture from process_recurrence_occurrences/record_import_
--    batches (0061/0063), which DO carry FKs, because those exist to
--    enforce a structural identity relationship, not to record history.
--  - notifications is recipient-scoped, RLS-select-only-your-own, zero raw
--    write grants -- every row is created by a SECURITY DEFINER function,
--    every read-state change goes through a narrow authorized RPC.
--  - Idempotency for both step_due_soon and step_overdue (and step_assigned,
--    wired directly into private.activate_process_step_run below) uses the
--    same durable-claim-before-side-effect shape as 0061/0063: insert the
--    notification row with `on conflict (workspace_id, dedup_key) do
--    nothing`, and only create the paired workspace_event when that insert
--    actually claims a new row. This means workspace_events never
--    accumulates duplicate rows for a repeated/overlapping scheduler pass
--    without needing its own separate uniqueness constraint -- it inherits
--    the notification's claim.
--  - Notification/event creation is always wrapped in its own exception-
--    swallowing block wherever it's added to an existing canonical function
--    (private.activate_process_step_run, start_process_run_system): a
--    notification-layer bug must never block the actual process from
--    advancing or a recurrence-started run from being created. The
--    important side effect (the process moving forward) is the one that
--    must always commit.

create table workspace_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_user_id uuid,
  event_type text not null check (event_type in (
    'step_assigned', 'step_due_soon', 'step_overdue', 'recurrence_started_process'
  )),
  entity_type_id uuid,
  entity_record_id uuid,
  process_template_id uuid,
  process_run_id uuid,
  process_step_run_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index workspace_events_workspace_created_idx
  on workspace_events (workspace_id, created_at desc);
create index workspace_events_process_run_idx
  on workspace_events (workspace_id, process_run_id)
  where process_run_id is not null;

alter table workspace_events enable row level security;
-- Deliberately closed for 8D.2: no select policy at all. Ordinary workers
-- don't need a general events feed yet -- that's Activity UI (8D.3). The
-- table exists now as durable infrastructure both Notifications and the
-- future Activity timeline can read from once that surface is built.
revoke all on table workspace_events from public, anon, authenticated;

create table notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  recipient_user_id uuid not null,
  workspace_event_id uuid,
  event_type text not null check (event_type in ('step_assigned', 'step_due_soon', 'step_overdue')),
  process_template_id uuid,
  process_run_id uuid,
  process_step_run_id uuid,
  entity_type_id uuid,
  entity_record_id uuid,
  title text not null,
  destination_href text not null,
  dedup_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,

  unique (workspace_id, dedup_key)
);

create index notifications_recipient_idx
  on notifications (workspace_id, recipient_user_id, created_at desc);
create index notifications_recipient_unread_idx
  on notifications (workspace_id, recipient_user_id)
  where read_at is null;

alter table notifications enable row level security;

create policy notifications_select_own on notifications
  for select to authenticated
  using (recipient_user_id = auth.uid());

revoke all on table notifications from public, anon;
grant select on table notifications to authenticated;

-- Read-state RPCs. Both scope purely via the WHERE clause (recipient_user_id
-- = auth.uid()) -- a request for someone else's notification id matches
-- zero rows and silently no-ops rather than raising, so the RPC never
-- confirms or denies whether a given notification id belongs to another
-- member (a minor but deliberate privacy choice, not an oversight).
create or replace function mark_notification_read_authorized(
  p_workspace_id uuid,
  p_notification_id uuid
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

  update notifications
  set read_at = coalesce(read_at, now())
  where workspace_id = p_workspace_id
    and id = p_notification_id
    and recipient_user_id = auth.uid();
end;
$$;

create or replace function mark_all_notifications_read_authorized(
  p_workspace_id uuid
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

  update notifications
  set read_at = now()
  where workspace_id = p_workspace_id
    and recipient_user_id = auth.uid()
    and read_at is null;
end;
$$;

revoke all on function mark_notification_read_authorized(uuid, uuid) from public, anon;
grant execute on function mark_notification_read_authorized(uuid, uuid) to authenticated, service_role;
revoke all on function mark_all_notifications_read_authorized(uuid) from public, anon;
grant execute on function mark_all_notifications_read_authorized(uuid) to authenticated, service_role;

-- Assignment notification: wired directly into the one canonical step-
-- activation function every activation path already funnels through
-- (manual/workflow-triggered/recurrence-triggered run start, ordinary
-- continuation after completion, conditional routing, parallel fan-out,
-- approval nodes, and wait/condition-wait resumption) -- there is exactly
-- one place a step ever transitions pending -> active, so there is exactly
-- one place this needs to be added. Deliberately excludes wait/condition_
-- wait/action/parallel system nodes (no assignee concept) and any step
-- with no assignee_user_id, matching the v1 requirement precisely.
create or replace function private.activate_process_step_run(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_activation_at timestamptz,
  p_parallel_branch_token uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step process_step_runs%rowtype;
  v_run process_runs%rowtype;
  v_notification_id uuid;
  v_event_id uuid;
begin
  select * into v_step from process_step_runs where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.status <> 'pending' then raise exception 'Process route target is not available'; end if;
  if v_step.parallel_branch_token is not null and p_parallel_branch_token is not null and v_step.parallel_branch_token <> p_parallel_branch_token then raise exception 'Process branch token does not match its target'; end if;
  update process_step_runs set status = 'active', started_at = p_activation_at,
    due_at = case when v_step.node_type in ('human_task', 'approval') then private.process_due_at_from_config(v_step.config, p_activation_at) else null end,
    resume_at = case when v_step.node_type = 'wait' then private.process_wait_resume_at_from_config(v_step.config, p_activation_at) else null end,
    parallel_branch_token = coalesce(v_step.parallel_branch_token, p_parallel_branch_token)
  where workspace_id = p_workspace_id and id = p_step_run_id;

  if v_step.node_type in ('human_task', 'approval') and v_step.assignee_user_id is not null then
    begin
      select * into v_run from process_runs where workspace_id = p_workspace_id and id = p_process_run_id;

      insert into notifications (
        id, workspace_id, recipient_user_id, event_type,
        process_template_id, process_run_id, process_step_run_id,
        entity_type_id, entity_record_id, title, destination_href, dedup_key
      )
      values (
        gen_random_uuid(), p_workspace_id, v_step.assignee_user_id, 'step_assigned',
        v_run.process_template_id, p_process_run_id, p_step_run_id,
        v_run.origin_entity_type_id, v_run.origin_record_id,
        v_step.name || ' is ready for you',
        '/process-runs/' || p_process_run_id::text,
        'assignment:' || p_step_run_id::text
      )
      on conflict (workspace_id, dedup_key) do nothing
      returning id into v_notification_id;

      if v_notification_id is not null then
        insert into workspace_events (
          id, workspace_id, event_type, entity_type_id, entity_record_id,
          process_template_id, process_run_id, process_step_run_id, metadata
        )
        values (
          gen_random_uuid(), p_workspace_id, 'step_assigned', v_run.origin_entity_type_id, v_run.origin_record_id,
          v_run.process_template_id, p_process_run_id, p_step_run_id,
          jsonb_build_object('recipient_user_id', v_step.assignee_user_id)
        )
        returning id into v_event_id;

        update notifications set workspace_event_id = v_event_id where id = v_notification_id;
      end if;
    exception when others then
      null;
    end;
  end if;

  if v_step.node_type = 'condition_wait' then
    perform private.evaluate_process_condition_wait(p_workspace_id, p_process_run_id, p_step_run_id, p_activation_at);
  elsif v_step.node_type not in ('human_task', 'approval', 'wait', 'action') then
    perform private.advance_process_system_step(p_workspace_id, p_process_run_id, p_step_run_id, p_activation_at);
  end if;
end;
$$;

-- Recurrence-started event only -- deliberately NO notification. Inspected
-- first: the only genuinely useful recipient for "a recurring rule started
-- a process" is whoever needs to DO something about it, and that case is
-- already fully covered by the assignment notification above the moment
-- the new run's first step activates with an assignee (recurrence-started
-- runs activate through this exact same canonical path, no special case
-- needed). Notifying the rule's creator instead would be a routine,
-- expected, non-actionable ping every cycle -- exactly the kind of noise
-- this milestone is meant to avoid, not a broadcast-to-admin pattern either
-- (there's no "admin" concept here, just whoever happened to configure the
-- rule). The event is still recorded, since it's genuinely useful process
-- history for 8D.3's Activity timeline, and it's free: start_process_run_
-- system already runs once per successfully-claimed occurrence (0063's own
-- idempotency), so this event inherits that guarantee without needing any
-- dedup logic of its own.
create or replace function start_process_run_system(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_originating_recurrence_occurrence_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
begin
  v_run_id := start_process_run_authorized_member(
    p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id
  );

  update process_runs
  set originating_recurrence_occurrence_id = p_originating_recurrence_occurrence_id
  where workspace_id = p_workspace_id and id = v_run_id;

  begin
    insert into workspace_events (
      id, workspace_id, event_type, entity_type_id, entity_record_id,
      process_template_id, process_run_id, metadata
    )
    values (
      gen_random_uuid(), p_workspace_id, 'recurrence_started_process', p_origin_entity_type_id, p_origin_record_id,
      p_process_template_id, v_run_id,
      jsonb_build_object('originating_recurrence_occurrence_id', p_originating_recurrence_occurrence_id)
    );
  exception when others then
    null;
  end;

  return v_run_id;
end;
$$;

-- Reminder scheduler discovery. Same shape as resume_due_process_waits_
-- system/discover_and_start_recurrence_occurrences_system: global (no
-- workspace_id parameter -- scans due work across every workspace, so this
-- must be service_role-only, matching the identical reasoning for those two
-- functions), bounded batch, deterministic order, FOR UPDATE SKIP LOCKED,
-- per-row exception isolation. Split into two focused functions (due-soon,
-- overdue) rather than one combined scan, matching how timer waits and
-- condition waits are also two separate system RPCs despite both being
-- "due work" scans.
--
-- "At most one due-soon notification per step-run lifetime, ever" and "no
-- repeated overdue nagging" both fall directly out of the dedup_key unique
-- constraint -- there is no separate "already notified" flag or lookup
-- query anywhere; the constraint IS the guarantee, exactly like 0061/0063.
-- due_at is set exactly once, at activation (private.activate_process_step_
-- run above), and is never mutated on an already-active step anywhere in
-- this codebase (confirmed by inspection: the only other writes to due_at
-- are `due_at = null` on a transition to 'skipped', never on an active
-- step) -- so there is no "due date changed after due-soon already fired"
-- case to handle in v1; the dedup key needs no date component.
create or replace function generate_step_due_soon_notifications_system(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step record;
  v_now timestamptz := clock_timestamp();
  v_notification_id uuid;
  v_event_id uuid;
  v_created integer := 0;
  v_failed integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Notification batch limit must be between 1 and 500';
  end if;

  for v_step in
    select s.*, r.process_template_id as run_process_template_id,
      r.origin_entity_type_id as run_origin_entity_type_id, r.origin_record_id as run_origin_record_id
    from process_step_runs s
    join process_runs r on r.workspace_id = s.workspace_id and r.id = s.process_run_id and r.status = 'active'
    where s.status = 'active'
      and s.node_type in ('human_task', 'approval')
      and s.assignee_user_id is not null
      and s.due_at is not null
      and s.due_at > v_now
      and s.due_at <= v_now + interval '24 hours'
    order by s.due_at, s.id
    limit p_limit
    for update of s skip locked
  loop
    begin
      v_notification_id := null;
      insert into notifications (
        id, workspace_id, recipient_user_id, event_type,
        process_template_id, process_run_id, process_step_run_id,
        entity_type_id, entity_record_id, title, destination_href, dedup_key
      )
      values (
        gen_random_uuid(), v_step.workspace_id, v_step.assignee_user_id, 'step_due_soon',
        v_step.run_process_template_id, v_step.process_run_id, v_step.id,
        v_step.run_origin_entity_type_id, v_step.run_origin_record_id,
        v_step.name || ' is due soon',
        '/process-runs/' || v_step.process_run_id::text,
        'due_soon:' || v_step.id::text
      )
      on conflict (workspace_id, dedup_key) do nothing
      returning id into v_notification_id;

      if v_notification_id is not null then
        insert into workspace_events (
          id, workspace_id, event_type, entity_type_id, entity_record_id,
          process_template_id, process_run_id, process_step_run_id, metadata
        )
        values (
          gen_random_uuid(), v_step.workspace_id, 'step_due_soon', v_step.run_origin_entity_type_id, v_step.run_origin_record_id,
          v_step.run_process_template_id, v_step.process_run_id, v_step.id,
          jsonb_build_object('recipient_user_id', v_step.assignee_user_id, 'due_at', v_step.due_at)
        )
        returning id into v_event_id;
        update notifications set workspace_event_id = v_event_id where id = v_notification_id;
        v_created := v_created + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object('created', v_created, 'failed', v_failed);
end;
$$;

create or replace function generate_step_overdue_notifications_system(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step record;
  v_now timestamptz := clock_timestamp();
  v_notification_id uuid;
  v_event_id uuid;
  v_created integer := 0;
  v_failed integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Notification batch limit must be between 1 and 500';
  end if;

  for v_step in
    select s.*, r.process_template_id as run_process_template_id,
      r.origin_entity_type_id as run_origin_entity_type_id, r.origin_record_id as run_origin_record_id
    from process_step_runs s
    join process_runs r on r.workspace_id = s.workspace_id and r.id = s.process_run_id and r.status = 'active'
    where s.status = 'active'
      and s.node_type in ('human_task', 'approval')
      and s.assignee_user_id is not null
      and s.due_at is not null
      and s.due_at < v_now
    order by s.due_at, s.id
    limit p_limit
    for update of s skip locked
  loop
    begin
      v_notification_id := null;
      insert into notifications (
        id, workspace_id, recipient_user_id, event_type,
        process_template_id, process_run_id, process_step_run_id,
        entity_type_id, entity_record_id, title, destination_href, dedup_key
      )
      values (
        gen_random_uuid(), v_step.workspace_id, v_step.assignee_user_id, 'step_overdue',
        v_step.run_process_template_id, v_step.process_run_id, v_step.id,
        v_step.run_origin_entity_type_id, v_step.run_origin_record_id,
        v_step.name || ' is overdue',
        '/process-runs/' || v_step.process_run_id::text,
        'overdue:' || v_step.id::text
      )
      on conflict (workspace_id, dedup_key) do nothing
      returning id into v_notification_id;

      if v_notification_id is not null then
        insert into workspace_events (
          id, workspace_id, event_type, entity_type_id, entity_record_id,
          process_template_id, process_run_id, process_step_run_id, metadata
        )
        values (
          gen_random_uuid(), v_step.workspace_id, 'step_overdue', v_step.run_origin_entity_type_id, v_step.run_origin_record_id,
          v_step.run_process_template_id, v_step.process_run_id, v_step.id,
          jsonb_build_object('recipient_user_id', v_step.assignee_user_id, 'due_at', v_step.due_at)
        )
        returning id into v_event_id;
        update notifications set workspace_event_id = v_event_id where id = v_notification_id;
        v_created := v_created + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object('created', v_created, 'failed', v_failed);
end;
$$;

revoke all on function generate_step_due_soon_notifications_system(integer) from public, anon, authenticated;
grant execute on function generate_step_due_soon_notifications_system(integer) to service_role;
revoke all on function generate_step_overdue_notifications_system(integer) from public, anon, authenticated;
grant execute on function generate_step_overdue_notifications_system(integer) to service_role;
