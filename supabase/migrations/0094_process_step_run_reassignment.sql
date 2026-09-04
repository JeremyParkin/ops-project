-- Phase 11.2: Reassign Active Human Work.
--
-- Lets the current assignee of an active human_task/approval StepRun hand it
-- to another current workspace member -- self-reassignment only in this
-- slice; administrative (non-self) reassignment is deliberately deferred to
-- 11.3, per the approved Process Runtime Administration investigation.
-- assignee_user_id/assignee_label continue to represent the *current*
-- effective assignment (unchanged posture); a new `step_reassigned`
-- workspace_events row is the durable historical record of each transition,
-- following this project's established preference for new events over new
-- persisted-state columns (routing_result, decided_by_*, cancelled_at/
-- cancellation_reason). No assignment-history table, no
-- original_assignee_* column.
--
-- Three corrections incorporated after review of the initial 11.2 plan,
-- each addressed below at its own site:
--
--   1. Legacy dedup-key compatibility. Live active StepRuns already carry
--      generation-1 notifications under the pre-existing unsuffixed keys
--      (`due_soon:{step_run_id}`, `overdue:{step_run_id}`). Making
--      generation 1 use a suffixed key here would silently duplicate those
--      notifications the very next scheduler pass, since the new key would
--      no longer collide with the already-claimed old one. Both scheduler
--      functions below keep the exact legacy unsuffixed key for
--      assignment_generation = 1 and only switch to a generation-suffixed
--      key from generation 2 onward -- i.e. only once a real reassignment
--      has actually happened. private.activate_process_step_run's own
--      step_assigned insert needs no equivalent change and is NOT touched
--      by this migration: it fires exactly once per step, ever (activation
--      is a strict one-time pending -> active transition, confirmed
--      forward-only across this runtime's entire history), so its bare
--      `assignment:{step_run_id}` key can never collide with this
--      migration's generation>=2 keys (`assignment:{step_run_id}:{N}`,
--      N >= 2 always, since reassign_process_step_run_authorized only ever
--      fires after incrementing assignment_generation from at least 1) --
--      textually distinct strings regardless.
--   2. Scheduler/reassignment serialization. Both scheduler functions
--      already use `for update of s skip locked` inside one implicit
--      per-invocation transaction (the same pattern already backing
--      resume_due_process_waits_system and the recurrence/action-node
--      schedulers) -- a row's lock is held for the scheduler's entire
--      transaction, and reassign_process_step_run_authorized's own
--      `for update` on the same row must wait for that lock exactly like
--      any other concurrent writer. Whichever transaction commits first
--      establishes the row's true state for the other; a scheduler pass
--      can never observe or act on a step's pre-reassignment assignee/
--      generation after the reassignment has actually committed, and a
--      reassignment can never partially overlap a scheduler pass's read of
--      the same row. No new locking was introduced -- ordinary Postgres row
--      locking, already relied on throughout this codebase, already
--      provides this guarantee.
--   3. Notification/Activity independence. Unlike
--      private.activate_process_step_run (where the workspace_events row
--      exists specifically to record that a notification was created, so
--      coupling them is correct), a step_reassigned event records that a
--      reassignment *happened* -- true regardless of whether its
--      notification could be created. The notification insert and the
--      workspace_events insert below are therefore two independent
--      exception-swallowing blocks, not one shared block: an Activity-layer
--      failure can never prevent the release-critical assignment
--      notification from being attempted, and a notification-layer failure
--      does not prevent the audit event from being recorded. Both remain
--      best-effort or already-correct engine progression must never be
--      blocked, matching this project's standing notification/Activity
--      posture.

alter table process_step_runs
  add column if not exists assignment_generation integer not null default 1;

alter table process_step_runs
  drop constraint if exists process_step_runs_assignment_generation_positive_check;
alter table process_step_runs
  add constraint process_step_runs_assignment_generation_positive_check
    check (assignment_generation >= 1);

alter table workspace_events
  drop constraint if exists workspace_events_event_type_check;
alter table workspace_events
  add constraint workspace_events_event_type_check
    check (event_type in (
      'step_assigned', 'step_due_soon', 'step_overdue', 'recurrence_started_process',
      'process_started', 'process_completed', 'approval_decided',
      'impersonation_started', 'impersonation_ended',
      'process_cancelled', 'step_reassigned'
    ));

-- Reassignment RPC. Locking mirrors cancel_process_run_authorized (0092)
-- exactly: advisory xact lock on the run id, `for update` on both the run
-- and step rows -- this also serializes correctly against a concurrent
-- cancellation or scheduler pass touching the same rows (see correction 2
-- above). Self-reassignment only: the caller must hold `processes.operate`
-- AND be the step's current effective assignee -- administrative
-- reassignment of someone else's step is out of scope for 11.2 by design,
-- not by omission. Reassigning to the current assignee is rejected rather
-- than treated as a no-op, since a no-op would still burn a generation and
-- send a redundant "assigned to you" notification for no real change.
create or replace function reassign_process_step_run_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_new_assignee_user_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run process_runs%rowtype;
  v_step process_step_runs%rowtype;
  v_actor_user_id uuid := private.current_effective_user(p_workspace_id);
  v_real_actor_user_id uuid := case
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id)
      then auth.uid()
    else null
  end;
  v_new_assignee_label text;
  v_new_generation integer;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_notification_id uuid;
  v_event_id uuid;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));

  select * into v_run from process_runs
  where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active'
  for update;
  if not found then raise exception 'Process run is not active'; end if;

  select * into v_step from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id
  for update;
  if not found then raise exception 'Step not found'; end if;
  if v_step.node_type not in ('human_task', 'approval') then
    raise exception 'This step type cannot be reassigned';
  end if;
  if v_step.status <> 'active' then raise exception 'This step is not active'; end if;

  if v_step.assignee_user_id is null or v_step.assignee_user_id <> v_actor_user_id then
    raise exception 'Only the current assignee can reassign this step';
  end if;

  if p_new_assignee_user_id = v_step.assignee_user_id then
    raise exception 'Already assigned to this member';
  end if;

  if not exists (
    select 1 from workspace_memberships
    where workspace_id = p_workspace_id and user_id = p_new_assignee_user_id and deactivated_at is null
  ) then
    raise exception 'New assignee is not a current member of this workspace';
  end if;

  select email into v_new_assignee_label from auth.users where id = p_new_assignee_user_id;

  update process_step_runs
  set assignee_user_id = p_new_assignee_user_id,
      assignee_label = v_new_assignee_label,
      assignment_generation = assignment_generation + 1
  where workspace_id = p_workspace_id and id = p_step_run_id
  returning assignment_generation into v_new_generation;

  -- Release-critical: attempted independently of the Activity event below.
  begin
    insert into notifications (
      id, workspace_id, recipient_user_id, event_type,
      process_template_id, process_run_id, process_step_run_id,
      entity_type_id, entity_record_id, title, destination_href, dedup_key
    )
    values (
      gen_random_uuid(), p_workspace_id, p_new_assignee_user_id, 'step_assigned',
      v_run.process_template_id, p_process_run_id, p_step_run_id,
      v_run.origin_entity_type_id, v_run.origin_record_id,
      v_step.name || ' is ready for you',
      '/process-runs/' || p_process_run_id::text,
      'assignment:' || p_step_run_id::text || ':' || v_new_generation::text
    )
    on conflict (workspace_id, dedup_key) do nothing
    returning id into v_notification_id;
  exception when others then
    v_notification_id := null;
  end;

  -- Audit trail: a reassignment happened, whether or not the notification
  -- above succeeded. Independent block on purpose -- see correction 3.
  begin
    insert into workspace_events (
      id, workspace_id, actor_user_id, real_actor_user_id, event_type,
      entity_type_id, entity_record_id, process_template_id, process_run_id, process_step_run_id, metadata
    )
    values (
      gen_random_uuid(), p_workspace_id, v_actor_user_id, v_real_actor_user_id, 'step_reassigned',
      v_run.origin_entity_type_id, v_run.origin_record_id, v_run.process_template_id, p_process_run_id, p_step_run_id,
      jsonb_build_object(
        'from_assignee_user_id', v_step.assignee_user_id,
        'from_assignee_label', v_step.assignee_label,
        'to_assignee_user_id', p_new_assignee_user_id,
        'to_assignee_label', v_new_assignee_label,
        'assignment_generation', v_new_generation,
        'reason', v_reason
      )
    )
    returning id into v_event_id;

    if v_notification_id is not null then
      update notifications set workspace_event_id = v_event_id where id = v_notification_id;
    end if;
  exception when others then
    null;
  end;
end;
$$;

revoke all on function reassign_process_step_run_authorized(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function reassign_process_step_run_authorized(uuid, uuid, uuid, uuid, text) to authenticated, service_role;

-- generate_step_due_soon_notifications_system / generate_step_overdue_
-- notifications_system: full current bodies copied verbatim from their sole
-- prior definition (0064_workspace_events_and_notifications.sql, confirmed
-- untouched by any migration since), then widened to select
-- assignment_generation (already available via `s.*`, no new column in the
-- select list needed) and use it in the dedup key -- but see correction 1
-- above: generation 1 keeps the exact legacy unsuffixed key so any
-- already-claimed notification for a currently-active, never-reassigned
-- step is not duplicated the next time either scheduler runs. No other
-- line changed.
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
  v_dedup_key text;
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
      v_dedup_key := case
        when v_step.assignment_generation = 1 then 'due_soon:' || v_step.id::text
        else 'due_soon:' || v_step.id::text || ':' || v_step.assignment_generation::text
      end;

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
        v_dedup_key
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
  v_dedup_key text;
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
      v_dedup_key := case
        when v_step.assignment_generation = 1 then 'overdue:' || v_step.id::text
        else 'overdue:' || v_step.id::text || ':' || v_step.assignment_generation::text
      end;

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
        v_dedup_key
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

-- list_record_activity_authorized: full current body copied verbatim from
-- its latest applied definition (0092_process_run_cancellation.sql), then
-- widened again to surface step_reassigned with its own durable from/to
-- labels. Those labels are read from the event's own metadata, never from
-- a live join to process_step_runs.assignee_label -- a *later* reassignment
-- would otherwise silently corrupt an *earlier* reassignment event's "to"
-- display, since assignee_label only ever reflects the step's current
-- state. Same 42P13 return-shape hazard as 0092's own fix: dropped
-- explicitly, never CREATE OR REPLACE'd. Confirmed via migration-source
-- inspection that nothing else in this schema depends on this function.
drop function if exists public.list_record_activity_authorized(uuid, uuid, uuid, integer);

create function list_record_activity_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_record_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  event_type text,
  created_at timestamptz,
  actor_user_id uuid,
  actor_label text,
  process_run_id uuid,
  process_run_name text,
  process_step_run_id uuid,
  step_name text,
  assignee_label text,
  approval_outcome_label text,
  is_recurrence_started boolean,
  cancellation_reason text,
  from_assignee_label text,
  to_assignee_label text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Activity limit must be between 1 and 100';
  end if;

  return query
  select
    e.id, e.event_type, e.created_at, e.actor_user_id,
    coalesce(step.decided_by_label, actor_user.email) as actor_label,
    e.process_run_id, run.process_template_name as process_run_name,
    e.process_step_run_id, step.name as step_name, step.assignee_label,
    step.approval_outcome_label,
    (run.originating_recurrence_occurrence_id is not null) as is_recurrence_started,
    run.cancellation_reason,
    e.metadata->>'from_assignee_label' as from_assignee_label,
    e.metadata->>'to_assignee_label' as to_assignee_label
  from workspace_events e
  left join process_runs run on run.workspace_id = e.workspace_id and run.id = e.process_run_id
  left join process_step_runs step on step.workspace_id = e.workspace_id and step.id = e.process_step_run_id
  left join auth.users actor_user on actor_user.id = e.actor_user_id
  where e.workspace_id = p_workspace_id
    and e.entity_type_id = p_entity_type_id
    and e.entity_record_id = p_entity_record_id
    and e.event_type in (
      'process_started', 'process_completed', 'step_assigned', 'approval_decided',
      'process_cancelled', 'step_reassigned'
    )
  order by e.created_at desc
  limit p_limit;
end;
$$;

revoke all on function list_record_activity_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_record_activity_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;
