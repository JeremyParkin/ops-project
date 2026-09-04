-- Phase 11.1 follow-up: widen the node-type-specific "shape" CHECK
-- constraints on process_step_runs to permit status = 'cancelled'.
--
-- 0092 added 'cancelled' to process_step_runs_status_check and to the
-- general process_step_runs_lifecycle_check, but missed that four
-- additional, separately-maintained constraints -- each enumerating its own
-- closed set of allowed statuses for one node type -- also gate on status
-- and did not include 'cancelled'. Their latest bodies (all from 0077,
-- confirmed untouched by any migration since, including 0092) are:
--
--   process_step_runs_wait_shape_check: wait nodes may be
--     status in ('pending','skipped') with resume_at null, or
--     status in ('active','completed') with resume_at not null -- no third
--     option, so cancel_process_run_authorized's own
--     `update process_step_runs set status = 'cancelled' ...` fails this
--     check outright for any active or pending wait step.
--   process_step_runs_condition_wait_shape_check: analogous, for
--     condition_wait nodes and condition_wait_result.
--   process_step_runs_action_shape_check: analogous, for action nodes and
--     action_result.
--   process_step_runs_external_wait_shape_check: analogous, for
--     external_event_wait nodes and external_wait_id.
--
-- This was found by source inspection of 0077 before running the Phase
-- 11.1 DB/RPC verification pass, not by a failing test -- but the fix
-- lands here regardless, as its own corrective migration, since 0092 is
-- already applied and immutable.
--
-- Fix shape, consistent with process_step_runs_lifecycle_check's own
-- 'cancelled' clause: a cancelled step may have come from 'active' (its
-- node-type-specific fields already populated -- resume_at set,
-- condition_wait_result possibly set, action_result possibly set,
-- external_wait_id set) or from 'pending' (those fields still null/unset,
-- since it was never reached). Both are real, distinct historical facts,
-- so 'cancelled' is added as an unconstrained-on-those-fields status,
-- exactly mirroring how 'active' is already left unconstrained on
-- action_result in process_step_runs_action_shape_check today.
alter table process_step_runs
  drop constraint if exists process_step_runs_wait_shape_check,
  drop constraint if exists process_step_runs_condition_wait_shape_check,
  drop constraint if exists process_step_runs_action_shape_check,
  drop constraint if exists process_step_runs_external_wait_shape_check;

alter table process_step_runs
  add constraint process_step_runs_wait_shape_check
    check (
      (node_type <> 'wait' and resume_at is null)
      or (node_type = 'wait' and assignee_user_id is null and due_at is null and external_wait_id is null
        and (
          (status in ('pending', 'skipped') and resume_at is null)
          or (status in ('active', 'completed') and resume_at is not null)
          or status = 'cancelled'
        ))
    ),
  add constraint process_step_runs_condition_wait_shape_check
    check (
      (node_type <> 'condition_wait' and condition_wait_result is null)
      or (node_type = 'condition_wait' and assignee_user_id is null and due_at is null and resume_at is null and external_wait_id is null
        and (
          (status in ('pending', 'skipped') and condition_wait_result is null)
          or status in ('active', 'completed', 'cancelled')
        ))
    ),
  add constraint process_step_runs_action_shape_check
    check (
      (node_type <> 'action' and action_result is null)
      or (node_type = 'action' and assignee_user_id is null and due_at is null and resume_at is null and condition_wait_result is null and external_wait_id is null
        and (
          (status in ('pending', 'skipped') and action_result is null)
          or status = 'active'
          or (status = 'completed' and action_result is not null)
          or status = 'cancelled'
        ))
    ),
  add constraint process_step_runs_external_wait_shape_check
    check (
      (node_type <> 'external_event_wait' and external_wait_id is null)
      or (node_type = 'external_event_wait' and assignee_user_id is null and due_at is null and resume_at is null and condition_wait_result is null and action_result is null
        and (
          (status in ('pending', 'skipped') and external_wait_id is null)
          or (status in ('active', 'completed') and external_wait_id is not null)
          or status = 'cancelled'
        ))
    );
