-- Phase 8F.5 corrective migration: remove PL/pgSQL ambiguity in
-- receive_external_process_wait_event_for_api_key without changing its
-- external signature or authorization/continuation semantics.
--
-- The RETURNS TABLE column names (status, workspace_id, process_run_id,
-- step_run_id) are PL/pgSQL variables throughout the function body. Keep the
-- externally visible return shape, but qualify every table/row source and
-- avoid unqualified ON CONFLICT index column names inside the function.

create or replace function public.receive_external_process_wait_event_for_api_key(
  p_key_hash text,
  p_external_wait_id uuid,
  p_idempotency_key_hash text
)
returns table(status text, workspace_id uuid, process_run_id uuid, step_run_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_scopes text[];
  v_existing public.process_external_wait_events%rowtype;
  v_step public.process_step_runs%rowtype;
  v_completed boolean;
begin
  if nullif(trim(p_idempotency_key_hash), '') is null then
    raise exception 'invalid_idempotency_key';
  end if;

  select resolved.workspace_id, resolved.scopes
  into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) resolved;

  if not ('process_waits:complete' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  select event_row.*
  into v_existing
  from public.process_external_wait_events event_row
  where event_row.workspace_id = v_workspace_id
    and event_row.external_wait_id = p_external_wait_id
    and event_row.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    return query
    select accepted_result.status, accepted_result.workspace_id, accepted_result.process_run_id, accepted_result.step_run_id
    from (
      values (
        'accepted'::text,
        v_existing.workspace_id,
        v_existing.process_run_id,
        v_existing.step_run_id
      )
    ) as accepted_result(status, workspace_id, process_run_id, step_run_id);
    return;
  end if;

  select step_row.*
  into v_step
  from public.process_step_runs step_row
  where step_row.workspace_id = v_workspace_id
    and step_row.external_wait_id = p_external_wait_id
  for update;

  if not found or v_step.node_type <> 'external_event_wait' then
    raise exception 'external_wait_not_found';
  end if;

  -- Re-check after taking the StepRun lock. A same-key concurrent retry may
  -- have inserted the ledger row and committed while this request waited.
  select event_row.*
  into v_existing
  from public.process_external_wait_events event_row
  where event_row.workspace_id = v_workspace_id
    and event_row.external_wait_id = p_external_wait_id
    and event_row.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    return query
    select accepted_result.status, accepted_result.workspace_id, accepted_result.process_run_id, accepted_result.step_run_id
    from (
      values (
        'accepted'::text,
        v_existing.workspace_id,
        v_existing.process_run_id,
        v_existing.step_run_id
      )
    ) as accepted_result(status, workspace_id, process_run_id, step_run_id);
    return;
  end if;

  if v_step.status = 'completed' then
    raise exception 'external_wait_conflict';
  end if;

  if v_step.status <> 'active' then
    raise exception 'external_wait_not_found';
  end if;

  insert into public.process_external_wait_events (
    workspace_id, external_wait_id, process_run_id, step_run_id, idempotency_key_hash
  )
  values (
    v_workspace_id,
    p_external_wait_id,
    v_step.process_run_id,
    v_step.id,
    p_idempotency_key_hash
  )
  returning public.process_external_wait_events.* into v_existing;

  v_completed := private.complete_process_step_and_advance(
    v_workspace_id,
    v_step.process_run_id,
    v_step.id,
    now(),
    'external_event_received',
    '[]'::jsonb
  );

  if not v_completed then
    raise exception 'external_wait_conflict';
  end if;

  return query
  select accepted_result.status, accepted_result.workspace_id, accepted_result.process_run_id, accepted_result.step_run_id
  from (
    values (
      'accepted'::text,
      v_existing.workspace_id,
      v_existing.process_run_id,
      v_existing.step_run_id
    )
  ) as accepted_result(status, workspace_id, process_run_id, step_run_id);
end;
$$;

revoke all on function public.receive_external_process_wait_event_for_api_key(text, uuid, text) from public, anon, authenticated;
grant execute on function public.receive_external_process_wait_event_for_api_key(text, uuid, text) to service_role;
