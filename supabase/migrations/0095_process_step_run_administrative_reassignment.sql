-- Phase 11.3: Administrative Reassignment Authority.
--
-- Lets an appropriately authorized non-owner reassign someone else's active
-- human_task/approval StepRun -- the authority question deferred by 11.2 on
-- purpose ("administrative reassignment of someone else's step is out of
-- scope for 11.2 by design, not by omission"). No new capability, no
-- widening of processes.operate's own meaning, no managed_user_ids
-- mutation authority: administrative authority reuses the exact
-- `workspace.manage_members AND workspace.manage_roles` conjunction this
-- codebase already established twice for the identical "authorized
-- non-owner may override another member's own-scoped action" shape --
-- comment moderation (tombstone_process_step_run_comment_authorized, 0088)
-- and input-request cancellation (cancel_process_step_run_input_request_
-- authorized, 0090). Workspace administrator needs no special-case grant
-- here: it already holds all three required capabilities from creation
-- (0045/0049), so "Workspace administrator = full workspace access" keeps
-- holding automatically, exactly as every prior capability addition to
-- this schema has preserved it.
--
-- Shared mutation core. 0094's self-reassignment RPC and this migration's
-- new administrative RPC are now two distinct authorization paths onto the
-- same load-bearing state transition (assignment_generation bump, due_at
-- preservation, generation-aware step_assigned notification, step_reassigned
-- Activity event) -- a shared private helper is justified here, not
-- speculative abstraction, since duplicating that logic would leave two
-- independently-maintained copies of assignment-generation/notification/
-- locking/history behavior to keep in sync forever. The helper owns only
-- the state transition itself (locking, active-run/active-step/node-type
-- guards, same-*new*-assignee rejection, target-membership validation, the
-- update, the notification, the event) and makes no authorization
-- decisions and takes no is_administrative flag -- authorization is
-- entirely the two public RPCs' job, per the approved plan.
--
-- reassign_process_step_run_authorized keeps its exact 0094 signature,
-- return type, grants, and observable behavior. Its self-only authorization
-- (processes.operate + "caller is the step's current effective assignee")
-- now runs under the same advisory-lock + `for update` step-row read 0094
-- always took, then delegates the rest to the shared helper -- the helper
-- redundantly (but harmlessly; same-transaction re-locking is instant, not
-- a wait) reacquires the same locks, so it stays fully self-sufficient and
-- safe to call from either authorization path on its own.
--
-- reassign_process_step_run_administrative_authorized is new. It rejects
-- an active impersonation session before anything else -- administrative
-- reassignment is a real workspace-governance intervention and is
-- structurally never exercised through impersonation, matching how
-- workspace.manage_members/manage_roles already stay real-actor-bound
-- everywhere else in this schema (0068). It then requires, on the real
-- actor (auth.uid() directly, not private.current_effective_user):
-- processes.operate, workspace.manage_members, and workspace.manage_roles.
-- Unlike self-reassignment, a reason is mandatory. It never checks who the
-- current assignee is -- that is precisely the administrative case, moving
-- someone else's work.

-- Shared mutation core -- full state-transition body, faithfully factored
-- out of 0094's reassign_process_step_run_authorized with no logic changes:
-- same advisory lock key, same active-run/active-step/node-type guards,
-- same target-membership validation, same assignment_generation increment,
-- same two independent best-effort blocks for the step_assigned
-- notification (generation-aware dedup key, unchanged) and the
-- step_reassigned Activity event (unchanged metadata shape). due_at is
-- untouched by the update statement, exactly as in 0094 -- preserved by
-- omission, not by an explicit "keep" clause.
create function private.reassign_process_step_run_mutate(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_actor_user_id uuid,
  p_real_actor_user_id uuid,
  p_new_assignee_user_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run process_runs%rowtype;
  v_step process_step_runs%rowtype;
  v_new_assignee_label text;
  v_new_generation integer;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_notification_id uuid;
  v_event_id uuid;
begin
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
  -- above succeeded. Independent block on purpose, same as 0094.
  begin
    insert into workspace_events (
      id, workspace_id, actor_user_id, real_actor_user_id, event_type,
      entity_type_id, entity_record_id, process_template_id, process_run_id, process_step_run_id, metadata
    )
    values (
      gen_random_uuid(), p_workspace_id, p_actor_user_id, p_real_actor_user_id, 'step_reassigned',
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

revoke all on function private.reassign_process_step_run_mutate(
  uuid, uuid, uuid, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;

-- reassign_process_step_run_authorized: signature, return type, and grants
-- unchanged from 0094. Authorization (processes.operate + "caller is the
-- step's current effective assignee") now runs first under lock, then
-- delegates the state transition to the shared helper above.
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
  v_current_assignee_user_id uuid;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));

  select assignee_user_id into v_current_assignee_user_id
  from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id
  for update;

  if not found then
    raise exception 'Step not found';
  end if;

  if v_current_assignee_user_id is null or v_current_assignee_user_id <> v_actor_user_id then
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

-- reassign_process_step_run_administrative_authorized: new. Real-actor-only
-- throughout (auth.uid() directly, never private.current_effective_user) --
-- administrative authority is a governance action and cannot be exercised
-- through impersonation, checked first and unconditionally, before any
-- capability is even evaluated. p_reason is mandatory, unlike the
-- self-service RPC above.
create function reassign_process_step_run_administrative_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_new_assignee_user_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Administrative reassignment is not available while impersonating';
  end if;

  if not private.is_workspace_member_as(p_workspace_id, auth.uid()) then
    raise exception 'Workspace access denied';
  end if;

  if not private.has_workspace_capability_as(p_workspace_id, 'processes.operate', auth.uid()) then
    raise exception 'Permission denied: processes.operate';
  end if;

  if not (
    private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_members', auth.uid())
    and private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_roles', auth.uid())
  ) then
    raise exception 'Permission denied: administrative reassignment requires workspace management authority';
  end if;

  if v_reason is null then
    raise exception 'A reason is required for administrative reassignment';
  end if;

  perform private.reassign_process_step_run_mutate(
    p_workspace_id, p_process_run_id, p_step_run_id,
    auth.uid(), null, p_new_assignee_user_id, v_reason
  );
end;
$$;

revoke all on function reassign_process_step_run_administrative_authorized(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function reassign_process_step_run_administrative_authorized(uuid, uuid, uuid, uuid, text) to authenticated, service_role;
