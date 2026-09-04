-- Corrective migration for 0095. Applied migrations are immutable -- 0095
-- itself is untouched by this file.
--
-- Defect found by the Phase 11.2 regression suite
-- (process-step-run-reassignment-commit.test.ts): 0095's
-- reassign_process_step_run_authorized checked "is the caller the step's
-- current assignee" itself, under its own preliminary lock, *before*
-- calling private.reassign_process_step_run_mutate -- which is where the
-- active-run/active-step/human_task-or-approval guards now live. For any
-- non-human_task/non-approval node (wait, condition_wait, action,
-- external_event_wait, parallel_join), assignee_user_id is always null, so
-- that identity check now fired first and raised "Only the current
-- assignee can reassign this step" instead of 0094's original "This step
-- type cannot be reassigned" -- five 11.2 regression tests caught this
-- immediately (2025 wait/condition_wait/action/external_event_wait/
-- parallel_join node-type rejection cases). 0094's actual check order was:
-- run active -> step found -> node type -> status -> caller-is-assignee.
-- The self-only identity check has to stay outside the shared mutation
-- core (per the approved architecture: the core makes no authorization
-- decisions), but it still needs to run *after* the state-validity guards
-- to reproduce that exact order.
--
-- Fix: factor the guard-and-lock portion (advisory lock, run/step `for
-- update`, active-run / active-step / node-type checks) into its own new
-- private function, private.lock_reassignable_process_step_run, which
-- returns the locked, guard-validated row. reassign_process_step_run_
-- authorized now calls this first (restoring 0094's original ordering),
-- performs its identity check against the returned row, and only then
-- calls private.reassign_process_step_run_mutate -- which keeps doing its
-- own redundant (but harmless; same-transaction re-locking is instant)
-- guard re-validation, so it stays fully self-sufficient and safe to call
-- from any path, exactly as designed in 0095. No change to private.
-- reassign_process_step_run_mutate's own body, and no change at all to
-- reassign_process_step_run_administrative_authorized -- it never had this
-- ordering dependency (it has no identity check to sequence around), and
-- its own regression coverage confirms the guard order was already
-- correct for that path.

create function private.lock_reassignable_process_step_run(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid
)
returns process_step_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step process_step_runs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));

  perform 1 from process_runs
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

  return v_step;
end;
$$;

revoke all on function private.lock_reassignable_process_step_run(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- reassign_process_step_run_authorized: signature, return type, and grants
-- still unchanged from 0094/0095. Only the internal ordering changes --
-- guards first (via the new lock helper), then the self-identity
-- authorization check, then the shared mutation core.
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
  v_actor_user_id uuid := private.current_effective_user(p_workspace_id);
  v_real_actor_user_id uuid := case
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id)
      then auth.uid()
    else null
  end;
  v_step process_step_runs;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  v_step := private.lock_reassignable_process_step_run(p_workspace_id, p_process_run_id, p_step_run_id);

  if v_step.assignee_user_id is null or v_step.assignee_user_id <> v_actor_user_id then
    raise exception 'Only the current assignee can reassign this step';
  end if;

  perform private.reassign_process_step_run_mutate(
    p_workspace_id, p_process_run_id, p_step_run_id,
    v_actor_user_id, v_real_actor_user_id, p_new_assignee_user_id, p_reason
  );
end;
$$;

revoke all on function reassign_process_step_run_authorized(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function reassign_process_step_run_authorized(uuid, uuid, uuid, uuid, text) to authenticated, service_role;
