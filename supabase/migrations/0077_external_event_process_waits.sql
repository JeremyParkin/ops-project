-- Phase 8F.5: External Event / Webhook Waits (inbound).
--
-- V1 deliberately extends the Process runtime instead of creating a general
-- inbound automation system. An external_event_wait is a normal Process step:
-- it snapshots with the run, activates through private.activate_process_step_run,
-- and completes through private.complete_process_step_and_advance. The public
-- HTTP route uses workspace API keys, but the DB boundary independently
-- resolves key -> workspace -> scope again before mutating anything.

alter table public.process_nodes
  drop constraint if exists process_nodes_node_type_check,
  drop constraint if exists process_nodes_parallel_group_shape_check,
  drop constraint if exists process_nodes_system_metadata_check;

alter table public.process_nodes
  add constraint process_nodes_node_type_check
    check (node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'external_event_wait', 'action', 'parallel_split', 'parallel_join')),
  add constraint process_nodes_parallel_group_shape_check
    check (
      (node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'external_event_wait', 'action') and parallel_group_id is null)
      or (node_type in ('parallel_split', 'parallel_join') and parallel_group_id is not null)
    ),
  add constraint process_nodes_system_metadata_check
    check (
      node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'external_event_wait', 'action')
      or (assignee_user_id is null and config = '{}'::jsonb)
    );

alter table public.process_step_runs
  add column if not exists external_wait_id uuid;

alter table public.process_step_runs
  drop constraint if exists process_step_runs_node_type_check,
  drop constraint if exists process_step_runs_system_metadata_check,
  drop constraint if exists process_step_runs_wait_shape_check,
  drop constraint if exists process_step_runs_condition_wait_shape_check,
  drop constraint if exists process_step_runs_action_shape_check,
  drop constraint if exists process_step_runs_external_wait_shape_check;

alter table public.process_step_runs
  add constraint process_step_runs_node_type_check
    check (node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'external_event_wait', 'action', 'parallel_split', 'parallel_join')),
  add constraint process_step_runs_system_metadata_check
    check (
      node_type in ('human_task', 'approval', 'wait', 'condition_wait', 'external_event_wait', 'action')
      or (assignee_user_id is null and due_at is null and config = '{}'::jsonb and resume_at is null and external_wait_id is null)
    ),
  add constraint process_step_runs_wait_shape_check
    check (
      (node_type <> 'wait' and resume_at is null)
      or (node_type = 'wait' and assignee_user_id is null and due_at is null and external_wait_id is null
        and ((status in ('pending', 'skipped') and resume_at is null) or (status in ('active', 'completed') and resume_at is not null)))
    ),
  add constraint process_step_runs_condition_wait_shape_check
    check (
      (node_type <> 'condition_wait' and condition_wait_result is null)
      or (node_type = 'condition_wait' and assignee_user_id is null and due_at is null and resume_at is null and external_wait_id is null
        and ((status in ('pending', 'skipped') and condition_wait_result is null) or status in ('active', 'completed')))
    ),
  add constraint process_step_runs_action_shape_check
    check (
      (node_type <> 'action' and action_result is null)
      or (node_type = 'action' and assignee_user_id is null and due_at is null and resume_at is null and condition_wait_result is null and external_wait_id is null
        and ((status in ('pending', 'skipped') and action_result is null)
          or (status = 'active')
          or (status = 'completed' and action_result is not null)))
    ),
  add constraint process_step_runs_external_wait_shape_check
    check (
      (node_type <> 'external_event_wait' and external_wait_id is null)
      or (node_type = 'external_event_wait' and assignee_user_id is null and due_at is null and resume_at is null and condition_wait_result is null and action_result is null
        and ((status in ('pending', 'skipped') and external_wait_id is null) or (status in ('active', 'completed') and external_wait_id is not null)))
    );

create unique index if not exists process_step_runs_external_wait_id_idx
  on public.process_step_runs (workspace_id, external_wait_id)
  where external_wait_id is not null;

create table public.process_external_wait_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  external_wait_id uuid not null,
  process_run_id uuid not null,
  step_run_id uuid not null,
  idempotency_key_hash text not null,
  accepted_at timestamptz not null default now(),
  unique (workspace_id, external_wait_id, idempotency_key_hash),
  foreign key (workspace_id, process_run_id, step_run_id)
    references public.process_step_runs(workspace_id, process_run_id, id) on delete cascade
);

create index process_external_wait_events_step_idx
  on public.process_external_wait_events (workspace_id, step_run_id, accepted_at desc);

alter table public.process_external_wait_events enable row level security;
revoke all on table public.process_external_wait_events from public, anon, authenticated;

alter function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb)
  rename to save_process_template_authorized_pre_external_event_wait;

create function public.save_process_template_authorized(
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
  v_step jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_external_steps jsonb := '[]'::jsonb;
  v_template_id uuid;
  v_node_id uuid;
  v_index integer := 0;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Process steps must be an array'; end if;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_index := v_index + 1;
    if v_step->>'node_type' = 'external_event_wait' then
      if coalesce(nullif(trim(v_step->>'assignee_user_id'), ''), '') <> ''
        or coalesce(v_step->'due_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'wait_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'condition_wait_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'action_config', 'null'::jsonb) <> 'null'::jsonb then
        raise exception 'External event waits cannot have an assignee, due rule, timer rule, condition rule, or action config';
      end if;
      v_external_steps := v_external_steps || jsonb_build_array(jsonb_build_object('position', v_index));
      v_normalized := v_normalized || jsonb_build_array((v_step - 'wait_rule' - 'condition_wait_rule' - 'action_config') || jsonb_build_object('node_type', 'human_task', 'config', '{}'::jsonb));
    else
      v_normalized := v_normalized || jsonb_build_array(v_step);
    end if;
  end loop;

  v_template_id := save_process_template_authorized_pre_external_event_wait(
    p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, v_normalized
  );

  for v_step in select * from jsonb_array_elements(v_external_steps) loop
    select id into v_node_id from public.process_nodes
    where workspace_id = p_workspace_id and process_template_id = v_template_id and position = (v_step->>'position')::integer for update;
    if not found then raise exception 'External event wait node was not saved'; end if;
    update public.process_nodes
    set node_type = 'external_event_wait', assignee_user_id = null, config = '{}'::jsonb, updated_at = now()
    where workspace_id = p_workspace_id and id = v_node_id;
  end loop;

  return v_template_id;
end;
$$;

revoke all on function public.save_process_template_authorized_pre_external_event_wait(uuid, uuid, text, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public, anon;
grant execute on function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;

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
    external_wait_id = case when v_step.node_type = 'external_event_wait' then gen_random_uuid() else null end,
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
  elsif v_step.node_type not in ('human_task', 'approval', 'wait', 'external_event_wait', 'action') then
    perform private.advance_process_system_step(p_workspace_id, p_process_run_id, p_step_run_id, p_activation_at);
  end if;
end;
$$;

create function public.receive_external_process_wait_event_for_api_key(
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

  select r.workspace_id, r.scopes into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  if not ('process_waits:complete' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  select * into v_existing
  from public.process_external_wait_events event
  where event.workspace_id = v_workspace_id
    and event.external_wait_id = p_external_wait_id
    and event.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    return query select 'accepted'::text, v_existing.workspace_id, v_existing.process_run_id, v_existing.step_run_id;
    return;
  end if;

  select * into v_step
  from public.process_step_runs step
  where step.workspace_id = v_workspace_id
    and step.external_wait_id = p_external_wait_id
  for update;

  if not found or v_step.node_type <> 'external_event_wait' then
    raise exception 'external_wait_not_found';
  end if;

  select * into v_existing
  from public.process_external_wait_events event
  where event.workspace_id = v_workspace_id
    and event.external_wait_id = p_external_wait_id
    and event.idempotency_key_hash = p_idempotency_key_hash;

  if found then
    return query select 'accepted'::text, v_existing.workspace_id, v_existing.process_run_id, v_existing.step_run_id;
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
    v_workspace_id, p_external_wait_id, v_step.process_run_id, v_step.id, p_idempotency_key_hash
  )
  on conflict (workspace_id, external_wait_id, idempotency_key_hash) do nothing
  returning * into v_existing;

  if v_existing.id is null then
    select * into v_existing
    from public.process_external_wait_events event
    where event.workspace_id = v_workspace_id
      and event.external_wait_id = p_external_wait_id
      and event.idempotency_key_hash = p_idempotency_key_hash;

    if found then
      return query select 'accepted'::text, v_existing.workspace_id, v_existing.process_run_id, v_existing.step_run_id;
      return;
    end if;

    raise exception 'external_wait_conflict';
  end if;

  v_completed := private.complete_process_step_and_advance(
    v_workspace_id, v_step.process_run_id, v_step.id, now(), 'external_event_received', '[]'::jsonb
  );

  if not v_completed then
    raise exception 'external_wait_conflict';
  end if;

  return query select 'accepted'::text, v_existing.workspace_id, v_existing.process_run_id, v_existing.step_run_id;
end;
$$;

revoke all on function public.receive_external_process_wait_event_for_api_key(text, uuid, text) from public, anon, authenticated;
grant execute on function public.receive_external_process_wait_event_for_api_key(text, uuid, text) to service_role;

alter function public.create_api_key_authorized(uuid, text, text, text)
  rename to create_api_key_authorized_pre_external_wait_scope;

create function public.create_api_key_authorized(
  p_workspace_id uuid,
  p_name text,
  p_key_hash text,
  p_key_preview text,
  p_scope text default 'records:read'
)
returns table(id uuid, name text, key_preview text, scopes text[], created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_scope text := coalesce(nullif(trim(p_scope), ''), 'records:read');
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  if v_scope not in ('records:read', 'process_waits:complete') then
    raise exception 'invalid_api_key_scope';
  end if;
  if nullif(trim(p_name), '') is null then raise exception 'Key name is required'; end if;
  if nullif(trim(p_key_hash), '') is null or nullif(trim(p_key_preview), '') is null then
    raise exception 'Key material is required';
  end if;

  insert into public.api_keys (workspace_id, name, key_hash, key_preview, scopes, created_by)
  values (p_workspace_id, trim(p_name), p_key_hash, p_key_preview, array[v_scope], auth.uid())
  returning api_keys.id into v_id;

  insert into public.api_key_rate_limits (api_key_id) values (v_id);

  return query
  select ak.id, ak.name, ak.key_preview, ak.scopes, ak.created_at
  from public.api_keys ak
  where ak.id = v_id;
end;
$$;

revoke all on function public.create_api_key_authorized_pre_external_wait_scope(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.create_api_key_authorized(uuid, text, text, text, text) from public, anon;
grant execute on function public.create_api_key_authorized(uuid, text, text, text, text) to authenticated, service_role;

comment on column public.process_step_runs.external_wait_id is
  'Opaque runtime callback identity generated when an external_event_wait StepRun becomes active; not a public StepRun id and retained for idempotent retry lookup.';
comment on table public.process_external_wait_events is
  'Minimal inbound external wait idempotency ledger. Stores no request payload because V1 inbound events carry no mapping or matching semantics.';
