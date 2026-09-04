-- Phase 11.1: Cancel Process Run.
--
-- Correction after a failed manual apply attempt: the first version of this
-- (unapplied) file used `create or replace function
-- list_record_activity_authorized(...)` to widen its RETURNS TABLE shape
-- (adding the cancellation_reason output column). Postgres rejects that --
-- `CREATE OR REPLACE FUNCTION` cannot change an existing function's return
-- type/shape (error 42P13) -- and the manual apply failed at exactly that
-- statement. Because this file was never recorded as successfully applied,
-- it is fixed in place here rather than superseded by a corrective
-- migration -- consistent with this project's own rule that only an
-- *applied* migration is immutable.
--
-- Since psql/the SQL editor may or may not have wrapped the whole file in
-- one transaction (unknown at the time of this fix), every DDL statement
-- below is now written defensively idempotent (IF EXISTS / IF NOT EXISTS /
-- CREATE OR REPLACE / explicit DROP-then-CREATE) so this file applies
-- cleanly whether the live database is still fully pre-0092, or already
-- carries everything up to (but not including) the function that failed.
-- list_record_activity_authorized itself is fixed per the same rule that
-- caused the failure: its return shape is changing again relative to 0065,
-- so it is dropped explicitly and recreated, never CREATE OR REPLACE'd.
--
-- Adds a truthful, durable way to abandon an active ProcessRun without
-- mutating its ProcessTemplate, reversing completed history, or mislabeling
-- unfinished work as `skipped`. `skipped` already has a specific, correct
-- meaning everywhere else in this runtime -- "routing proved this node was
-- not taken" -- and reusing it for cancellation would make Process History/
-- Activity/Analytics misrepresent an abandoned run as one that completed
-- normally with some branches not selected. Cancellation gets its own
-- status on both process_runs and process_step_runs instead.
--
-- Constraint-safety note (per corrective review of the 11.1 plan): this
-- migration touches ONLY the CHECK constraints whose semantics are actually
-- changing (the two status-vocabulary checks and the two status/lifecycle
-- checks). Every other constraint on process_runs/process_step_runs is left
-- untouched. The full migration history for both tables was inspected
-- end-to-end before writing this file to confirm process_runs has exactly
-- two CHECK constraints (process_runs_status_check, and one anonymous
-- table-level lifecycle check, both from 0027, never touched since) and
-- process_step_runs' process_step_runs_status_check/_lifecycle_check
-- (named, from 0031) have never been touched by any later migration --
-- every subsequent 0033/0035/0037/0038/0041/0077 constraint churn on that
-- table only ever drops/recreates the node_type_check/system_metadata_
-- check/*_shape_check family (node-type-specific config shape), never
-- status or lifecycle. process_runs' anonymous lifecycle check is located
-- dynamically by its actual definition content (matching on `completed_at`,
-- the column it's known to reference), the same discipline this project
-- already used for field_choice_options.color in 0084 -- not by a blind
-- loop over every CHECK constraint on the table, which would also catch
-- constraints unrelated to this change.

alter table process_runs
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by_user_id uuid,
  add column if not exists cancelled_by_real_actor_user_id uuid,
  add column if not exists cancelled_by_label text,
  add column if not exists cancellation_reason text;

alter table process_runs
  drop constraint if exists process_runs_status_check;
alter table process_runs
  add constraint process_runs_status_check
    check (status in ('active', 'completed', 'cancelled'));

do $$
declare
  v_conname text;
begin
  select c.conname into v_conname
  from pg_constraint c
  where c.conrelid = 'public.process_runs'::regclass
    and c.contype = 'c'
    and c.conname <> 'process_runs_status_check'
    and pg_get_constraintdef(c.oid) ilike '%completed_at%';

  if v_conname is null then
    raise exception 'Could not locate the process_runs status/completed_at lifecycle CHECK constraint -- aborting rather than guessing a name';
  end if;

  execute format('alter table process_runs drop constraint %I', v_conname);
end
$$;

-- Named going forward (it was anonymous before), so no future migration
-- needs to rediscover it. cancellation_reason is required non-blank (after
-- trim) here at the data layer -- the RPC below also rejects a blank
-- reason with a friendlier error, but this is the guarantee that holds
-- even against a raw/inadvertent write.
alter table process_runs
  add constraint process_runs_lifecycle_check
    check (
      (status = 'active' and completed_at is null and cancelled_at is null)
      or (status = 'completed' and completed_at is not null and cancelled_at is null)
      or (
        status = 'cancelled'
        and completed_at is null
        and cancelled_at is not null
        and cancelled_by_user_id is not null
        and cancellation_reason is not null
        and btrim(cancellation_reason) <> ''
      )
    );

alter table process_step_runs
  drop constraint if exists process_step_runs_status_check;
alter table process_step_runs
  add constraint process_step_runs_status_check
    check (status in ('pending', 'active', 'completed', 'skipped', 'cancelled'));

alter table process_step_runs
  drop constraint if exists process_step_runs_lifecycle_check;
-- Deliberately NOT constraining started_at for 'cancelled', unlike
-- 'skipped': a cancelled step may have come from 'active' (started_at
-- already set -- it was genuinely in progress) or 'pending' (started_at
-- still null -- never reached). Both are real, distinct historical facts
-- worth preserving, not collapsing into one shape the way 'skipped'
-- (always reached from 'pending', never 'active') correctly does.
alter table process_step_runs
  add constraint process_step_runs_lifecycle_check
    check (
      (status = 'pending' and started_at is null and completed_at is null and due_at is null)
      or (status = 'active' and started_at is not null and completed_at is null)
      or (status = 'completed' and started_at is not null and completed_at is not null)
      or (status = 'skipped' and started_at is null and completed_at is null and due_at is null)
      or (status = 'cancelled' and completed_at is null and due_at is null)
    );

alter table workspace_events
  drop constraint if exists workspace_events_event_type_check;
alter table workspace_events
  add constraint workspace_events_event_type_check
    check (event_type in (
      'step_assigned', 'step_due_soon', 'step_overdue', 'recurrence_started_process',
      'process_started', 'process_completed', 'approval_decided',
      'impersonation_started', 'impersonation_ended',
      'process_cancelled'
    ));

-- Cancellation RPC. Locking/guard shape mirrors every other canonical
-- run-mutating RPC (advisory xact lock on the run id, `for update` on the
-- run row, active-run guard); actor/real-actor derivation mirrors
-- cancel_process_step_run_input_request_authorized (0090) exactly, since
-- that is this codebase's existing "cancel something, with an
-- impersonation-aware actor" precedent, not the completion/decision RPCs'
-- pattern. Gated on the plain `processes.operate` capability only -- no new
-- capability, per the approved 11.1 scope. No assignee check: a run has no
-- single owner the way a step does, so this is a workspace-level operate
-- action, not an assignee-restricted one.
--
-- CREATE OR REPLACE here (not a bare CREATE): this function is entirely new
-- as of this migration, so its signature/return shape can never differ
-- between a first attempt and a retry of this same file -- CREATE OR
-- REPLACE is unconditionally safe for it, unlike list_record_activity_
-- authorized below, whose shape is genuinely changing relative to an
-- already-applied prior migration (0065).
create or replace function cancel_process_run_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run process_runs%rowtype;
  v_actor_user_id uuid := private.current_effective_user(p_workspace_id);
  v_real_actor_user_id uuid := case
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id)
      then auth.uid()
    else null
  end;
  v_cancelled_at timestamptz := now();
  v_cancelled_by_label text;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Cancellation requires a reason';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));

  select * into v_run from process_runs
  where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active'
  for update;
  if not found then raise exception 'Process run is not active'; end if;

  select email into v_cancelled_by_label from auth.users where id = v_actor_user_id;

  update process_runs
  set status = 'cancelled',
      cancelled_at = v_cancelled_at,
      cancelled_by_user_id = v_actor_user_id,
      cancelled_by_real_actor_user_id = v_real_actor_user_id,
      cancelled_by_label = v_cancelled_by_label,
      cancellation_reason = btrim(p_reason)
  where workspace_id = p_workspace_id and id = p_process_run_id;

  -- Every currently active/pending StepRun becomes cancelled -- wait,
  -- condition_wait, action, human_task, and approval nodes alike, no
  -- node-type branching needed. Already-completed/skipped rows are
  -- untouched by construction (excluded by the WHERE clause). due_at is
  -- cleared for hygiene, matching the existing skip-cascade's own
  -- due_at = null convention, even though status alone already removes
  -- these rows from every My Work/Team Work/scheduler scan (all of which
  -- filter on status = 'active').
  --
  -- process_step_runs_clear_condition_wait_dependencies (0038) fires on any
  -- UPDATE OF status transitioning away from 'active', regardless of the
  -- new value -- so an active wait/condition_wait step moving to
  -- 'cancelled' gets its process_condition_wait_dependencies rows cleaned
  -- up automatically here, with no code in this function referencing that
  -- table at all.
  --
  -- Unarrived process_parallel_join_obligations rows are deliberately left
  -- untouched: they are only ever read from inside
  -- complete_process_step_run_authorized_member/
  -- decide_process_approval_authorized_member, both of which require
  -- run.status = 'active' for update as their own first guard, so neither
  -- can execute against this run again after this transaction commits.
  update process_step_runs
  set status = 'cancelled', due_at = null
  where workspace_id = p_workspace_id
    and process_run_id = p_process_run_id
    and status in ('active', 'pending');

  begin
    insert into workspace_events (
      id, workspace_id, actor_user_id, real_actor_user_id, event_type,
      entity_type_id, entity_record_id, process_template_id, process_run_id, metadata
    )
    values (
      gen_random_uuid(), p_workspace_id, v_actor_user_id, v_real_actor_user_id, 'process_cancelled',
      v_run.origin_entity_type_id, v_run.origin_record_id, v_run.process_template_id, p_process_run_id,
      jsonb_build_object('reason', btrim(p_reason))
    );
  exception when others then
    null;
  end;
end;
$$;

revoke all on function cancel_process_run_authorized(uuid, uuid, text) from public, anon, authenticated;
grant execute on function cancel_process_run_authorized(uuid, uuid, text) to authenticated, service_role;

-- list_record_activity_authorized: full current body copied verbatim from
-- its sole prior definition (0065_process_activity_events.sql), then
-- widened to (a) surface process_cancelled in the projection and (b)
-- return process_runs.cancellation_reason alongside it, joined from the
-- `run` alias this function already selects from -- no new join. No other
-- line changed.
--
-- This RETURNS TABLE shape is widening (one new output column), which
-- Postgres will not allow via CREATE OR REPLACE FUNCTION (error 42P13:
-- "cannot change return type of existing function") -- this is exactly the
-- statement that failed on the first apply attempt. Dropped explicitly and
-- recreated instead. Confirmed via migration-source inspection that
-- nothing else in this schema (no view, trigger, or other SQL function)
-- references list_record_activity_authorized -- its only callers are
-- app-layer supabase.rpc() calls -- so a plain DROP (no CASCADE) is safe.
-- IF EXISTS guards the drop so this file stays safe to reapply regardless
-- of whether the earlier failed attempt left this specific statement
-- untouched or (if the apply tool wrapped the whole file in one
-- transaction) rolled everything back to the pre-0092 0065 definition.
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
  cancellation_reason text
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
    run.cancellation_reason
  from workspace_events e
  left join process_runs run on run.workspace_id = e.workspace_id and run.id = e.process_run_id
  left join process_step_runs step on step.workspace_id = e.workspace_id and step.id = e.process_step_run_id
  left join auth.users actor_user on actor_user.id = e.actor_user_id
  where e.workspace_id = p_workspace_id
    and e.entity_type_id = p_entity_type_id
    and e.entity_record_id = p_entity_record_id
    and e.event_type in ('process_started', 'process_completed', 'step_assigned', 'approval_decided', 'process_cancelled')
  order by e.created_at desc
  limit p_limit;
end;
$$;

revoke all on function list_record_activity_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_record_activity_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;
