-- Phase 10.5: Request for Input on human-operable Process Step Runs.
--
-- Mirrors the proven Phase 10.4 record-level Request for Input pattern
-- (record_input_requests), kept as dedicated persistence for
-- process_step_runs rather than a polymorphic collaboration table -- the
-- same choice Phase 10.3 made for process_step_run_comments over extending
-- record_comments. Request/response text and human attribution stay
-- authoritative on the linked process_step_run_comments rows; this table
-- stores only state and stable links.
--
-- Visibility invariant (load-bearing, verified by inspection before writing
-- this migration, not assumed): the actual read boundary for Step Discussion
-- is private.is_workspace_member -- list_process_step_run_comments_authorized
-- checks only workspace membership, and its mention-candidate pool
-- (list_workspace_member_identities_authorized) is every active workspace
-- member, not scoped to processes.operate. So "can already see this Step
-- Discussion" is satisfied by workspace membership alone. This migration
-- nonetheless *also* requires processes.operate for a request recipient --
-- not as a stand-in for visibility, but because responding to a request
-- means creating a process_step_run_comments row, and
-- create_process_step_run_comment_with_mentions_authorized already requires
-- processes.operate to do that. A recipient who lacked it could see the
-- request but could never fulfill it. Both checks are enforced explicitly
-- below so this reasoning stays visible in the code, not folded into one
-- capability check standing in for two different invariants.

-- Prerequisite structural key: process_step_run_comments only has
-- (workspace_id, id) unique (0088). Requests need to FK the origin/response
-- comment to the *same* step the request row claims, the same reason
-- record_comments needed its own (workspace_id, entity_type_id,
-- entity_record_id, id) key added in 0089.
alter table process_step_run_comments
  add constraint process_step_run_comments_workspace_run_step_id_key
  unique (workspace_id, process_run_id, process_step_run_id, id);

create table process_step_run_input_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_run_id uuid not null,
  process_step_run_id uuid not null,
  origin_process_step_run_comment_id uuid not null,
  recipient_user_id uuid not null,
  response_process_step_run_comment_id uuid,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid,
  cancelled_by_real_actor_user_id uuid,

  unique (workspace_id, id),
  foreign key (workspace_id, process_run_id)
    references process_runs(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, process_run_id, process_step_run_id)
    references process_step_runs(workspace_id, process_run_id, id)
    on delete restrict,
  foreign key (workspace_id, process_run_id, process_step_run_id, origin_process_step_run_comment_id)
    references process_step_run_comments(workspace_id, process_run_id, process_step_run_id, id)
    on delete restrict,
  foreign key (workspace_id, process_run_id, process_step_run_id, response_process_step_run_comment_id)
    references process_step_run_comments(workspace_id, process_run_id, process_step_run_id, id)
    on delete restrict,
  foreign key (workspace_id, recipient_user_id)
    references workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (
    (response_process_step_run_comment_id is null and cancelled_at is null and cancelled_by_user_id is null and cancelled_by_real_actor_user_id is null)
    or
    (response_process_step_run_comment_id is not null and cancelled_at is null and cancelled_by_user_id is null and cancelled_by_real_actor_user_id is null)
    or
    (response_process_step_run_comment_id is null and cancelled_at is not null and cancelled_by_user_id is not null)
  ),
  check (
    cancelled_by_real_actor_user_id is null
    or cancelled_by_user_id is not null
  )
);

create index process_step_run_input_requests_step_origin_idx
  on process_step_run_input_requests (workspace_id, process_run_id, process_step_run_id, origin_process_step_run_comment_id);

create index process_step_run_input_requests_recipient_open_idx
  on process_step_run_input_requests (workspace_id, recipient_user_id, origin_process_step_run_comment_id)
  where response_process_step_run_comment_id is null and cancelled_at is null;

alter table process_step_run_input_requests enable row level security;
revoke all on table process_step_run_input_requests from public, anon, authenticated;

alter table notifications
  add column process_step_run_input_request_id uuid;

alter table notifications
  drop constraint if exists notifications_event_type_check;

alter table notifications
  add constraint notifications_event_type_check
  check (event_type in (
    'step_assigned',
    'step_due_soon',
    'step_overdue',
    'record_comment_mentioned',
    'process_step_run_comment_mentioned',
    'record_input_request_created',
    'record_input_request_responded',
    'record_input_request_cancelled',
    'process_step_run_input_request_created',
    'process_step_run_input_request_responded',
    'process_step_run_input_request_cancelled'
  ));

-- Faithful widening of the existing four-way (now five-way) exclusive
-- target-shape constraint from 0089: every prior arm gains a fifth
-- "and process_step_run_input_request_id is null" clause, and one new arm
-- is added for the new event types. No prior arm's own logic changes.
alter table notifications
  drop constraint if exists notifications_collaboration_target_shape_check;

alter table notifications
  add constraint notifications_collaboration_target_shape_check
  check (
    (
      event_type = 'record_comment_mentioned'
      and record_comment_id is not null
      and process_step_run_comment_id is null
      and record_input_request_id is null
      and process_step_run_input_request_id is null
    )
    or
    (
      event_type = 'process_step_run_comment_mentioned'
      and process_step_run_comment_id is not null
      and record_comment_id is null
      and record_input_request_id is null
      and process_step_run_input_request_id is null
    )
    or
    (
      event_type in ('record_input_request_created', 'record_input_request_responded', 'record_input_request_cancelled')
      and record_input_request_id is not null
      and record_comment_id is null
      and process_step_run_comment_id is null
      and process_step_run_input_request_id is null
    )
    or
    (
      event_type in ('process_step_run_input_request_created', 'process_step_run_input_request_responded', 'process_step_run_input_request_cancelled')
      and process_step_run_input_request_id is not null
      and record_comment_id is null
      and process_step_run_comment_id is null
      and record_input_request_id is null
    )
    or
    (
      event_type not in (
        'record_comment_mentioned',
        'process_step_run_comment_mentioned',
        'record_input_request_created',
        'record_input_request_responded',
        'record_input_request_cancelled',
        'process_step_run_input_request_created',
        'process_step_run_input_request_responded',
        'process_step_run_input_request_cancelled'
      )
      and record_comment_id is null
      and process_step_run_comment_id is null
      and record_input_request_id is null
      and process_step_run_input_request_id is null
    )
  );

alter table notifications
  add constraint notifications_process_step_run_input_request_fkey
  foreign key (workspace_id, process_step_run_input_request_id)
  references process_step_run_input_requests(workspace_id, id)
  on delete restrict;

create index notifications_process_step_run_input_request_idx
  on notifications (workspace_id, process_step_run_input_request_id)
  where process_step_run_input_request_id is not null;

create function list_process_step_run_input_request_recipient_candidates_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  return query
  select membership.user_id, users.email::text
  from workspace_memberships membership
  join auth.users users on users.id = membership.user_id
  where membership.workspace_id = p_workspace_id
    and membership.deactivated_at is null
    and private.has_workspace_capability_as(p_workspace_id, 'processes.operate', membership.user_id)
  order by users.email, membership.user_id;
end;
$$;

create function list_process_step_run_input_requests_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_process_step_run_id uuid,
  p_limit integer default 100
)
returns table (
  id uuid,
  workspace_id uuid,
  process_run_id uuid,
  process_step_run_id uuid,
  origin_process_step_run_comment_id uuid,
  recipient_user_id uuid,
  recipient_label text,
  response_process_step_run_comment_id uuid,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid,
  cancelled_by_real_actor_user_id uuid,
  origin_author_user_id uuid,
  origin_author_label text,
  origin_real_actor_user_id uuid,
  origin_real_actor_label text,
  origin_created_at timestamptz,
  origin_tombstoned_at timestamptz,
  response_author_user_id uuid,
  response_author_label text,
  response_real_actor_user_id uuid,
  response_real_actor_label text,
  response_created_at timestamptz,
  response_tombstoned_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Request limit must be between 1 and 200';
  end if;

  if not exists (
    select 1
    from process_step_runs step
    where step.workspace_id = p_workspace_id
      and step.process_run_id = p_process_run_id
      and step.id = p_process_step_run_id
      and step.node_type in ('human_task', 'approval')
  ) then
    raise exception 'Step not found';
  end if;

  return query
  select
    request.id,
    request.workspace_id,
    request.process_run_id,
    request.process_step_run_id,
    request.origin_process_step_run_comment_id,
    request.recipient_user_id,
    recipient.email::text as recipient_label,
    request.response_process_step_run_comment_id,
    request.cancelled_at,
    request.cancelled_by_user_id,
    request.cancelled_by_real_actor_user_id,
    origin.author_user_id,
    origin.author_label,
    origin.real_actor_user_id,
    origin.real_actor_label,
    origin.created_at,
    origin.tombstoned_at,
    response.author_user_id,
    response.author_label,
    response.real_actor_user_id,
    response.real_actor_label,
    response.created_at,
    response.tombstoned_at
  from process_step_run_input_requests request
  join process_step_run_comments origin
    on origin.workspace_id = request.workspace_id
   and origin.process_run_id = request.process_run_id
   and origin.process_step_run_id = request.process_step_run_id
   and origin.id = request.origin_process_step_run_comment_id
  join auth.users recipient on recipient.id = request.recipient_user_id
  left join process_step_run_comments response
    on response.workspace_id = request.workspace_id
   and response.process_run_id = request.process_run_id
   and response.process_step_run_id = request.process_step_run_id
   and response.id = request.response_process_step_run_comment_id
  where request.workspace_id = p_workspace_id
    and request.process_run_id = p_process_run_id
    and request.process_step_run_id = p_process_step_run_id
  order by origin.created_at asc, request.id asc
  limit p_limit;
end;
$$;

create function create_process_step_run_input_request_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_process_step_run_id uuid,
  p_recipient_user_id uuid,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid := gen_random_uuid();
  v_origin_comment_id uuid;
  v_origin_comment process_step_run_comments%rowtype;
  v_run process_runs%rowtype;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  if p_recipient_user_id is null then
    raise exception 'Request recipient is required';
  end if;

  if p_recipient_user_id = private.current_effective_user(p_workspace_id) then
    raise exception 'You cannot request input from yourself';
  end if;

  -- Not a visibility check (see migration header) -- required because
  -- responding means creating a step comment, which itself requires
  -- processes.operate.
  if not private.has_workspace_capability_as(p_workspace_id, 'processes.operate', p_recipient_user_id) then
    raise exception 'Request recipient must be an active processes.operate workspace member';
  end if;

  -- Delegates step-type/status eligibility, origin-record-archived, and
  -- body validation entirely to the same function plain step comments use
  -- (create_process_step_run_comment_with_mentions_authorized), rather than
  -- re-implementing that invariant a second time here where it could drift.
  v_origin_comment_id := create_process_step_run_comment_with_mentions_authorized(
    p_workspace_id,
    p_process_run_id,
    p_process_step_run_id,
    p_body,
    '{}'::uuid[]
  );

  select *
  into v_origin_comment
  from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.process_run_id = p_process_run_id
    and comment.process_step_run_id = p_process_step_run_id
    and comment.id = v_origin_comment_id;

  if not found then
    raise exception 'Request comment creation failed';
  end if;

  select *
  into v_run
  from process_runs run
  where run.workspace_id = p_workspace_id
    and run.id = p_process_run_id;

  insert into process_step_run_input_requests (
    id,
    workspace_id,
    process_run_id,
    process_step_run_id,
    origin_process_step_run_comment_id,
    recipient_user_id
  )
  values (
    v_request_id,
    p_workspace_id,
    p_process_run_id,
    p_process_step_run_id,
    v_origin_comment_id,
    p_recipient_user_id
  );

  insert into notifications (
    id,
    workspace_id,
    recipient_user_id,
    event_type,
    process_step_run_input_request_id,
    process_run_id,
    process_step_run_id,
    entity_type_id,
    entity_record_id,
    title,
    destination_href,
    dedup_key
  )
  values (
    gen_random_uuid(),
    p_workspace_id,
    p_recipient_user_id,
    'process_step_run_input_request_created',
    v_request_id,
    p_process_run_id,
    p_process_step_run_id,
    v_run.origin_entity_type_id,
    v_run.origin_record_id,
    v_origin_comment.author_label || ' requested your input on a process step',
    '/process-runs/' || p_process_run_id::text || '#step-input-request-' || v_request_id::text,
    'process_step_run_input_request_created:' || v_request_id::text || ':' || p_recipient_user_id::text
  )
  on conflict (workspace_id, dedup_key) do nothing;

  return v_request_id;
end;
$$;

create function respond_process_step_run_input_request_authorized(
  p_workspace_id uuid,
  p_request_id uuid,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request process_step_run_input_requests%rowtype;
  v_origin_comment process_step_run_comments%rowtype;
  v_response_comment_id uuid;
  v_response_comment process_step_run_comments%rowtype;
  v_responder_user_id uuid := private.current_effective_user(p_workspace_id);
  v_run process_runs%rowtype;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  select *
  into v_request
  from process_step_run_input_requests request
  where request.workspace_id = p_workspace_id
    and request.id = p_request_id
  for update;

  if not found then
    raise exception 'Request not found';
  end if;

  if v_request.response_process_step_run_comment_id is not null or v_request.cancelled_at is not null then
    raise exception 'Request is no longer open';
  end if;

  if v_request.recipient_user_id <> v_responder_user_id then
    raise exception 'Only the request recipient can respond';
  end if;

  -- Re-validates step eligibility and origin-record-archived state at
  -- response time, not just at request time -- a step or its origin record
  -- can change state between the two.
  v_response_comment_id := create_process_step_run_comment_with_mentions_authorized(
    p_workspace_id,
    v_request.process_run_id,
    v_request.process_step_run_id,
    p_body,
    '{}'::uuid[]
  );

  update process_step_run_input_requests
  set response_process_step_run_comment_id = v_response_comment_id
  where workspace_id = p_workspace_id
    and id = p_request_id;

  select *
  into v_origin_comment
  from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.process_run_id = v_request.process_run_id
    and comment.process_step_run_id = v_request.process_step_run_id
    and comment.id = v_request.origin_process_step_run_comment_id;

  select *
  into v_response_comment
  from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.process_run_id = v_request.process_run_id
    and comment.process_step_run_id = v_request.process_step_run_id
    and comment.id = v_response_comment_id;

  select *
  into v_run
  from process_runs run
  where run.workspace_id = p_workspace_id
    and run.id = v_request.process_run_id;

  insert into notifications (
    id,
    workspace_id,
    recipient_user_id,
    event_type,
    process_step_run_input_request_id,
    process_run_id,
    process_step_run_id,
    entity_type_id,
    entity_record_id,
    title,
    destination_href,
    dedup_key
  )
  values (
    gen_random_uuid(),
    p_workspace_id,
    v_origin_comment.author_user_id,
    'process_step_run_input_request_responded',
    p_request_id,
    v_request.process_run_id,
    v_request.process_step_run_id,
    v_run.origin_entity_type_id,
    v_run.origin_record_id,
    v_response_comment.author_label || ' responded to your request',
    '/process-runs/' || v_request.process_run_id::text || '#step-input-request-' || p_request_id::text,
    'process_step_run_input_request_responded:' || p_request_id::text || ':' || v_origin_comment.author_user_id::text
  )
  on conflict (workspace_id, dedup_key) do nothing;

  return v_response_comment_id;
end;
$$;

create function cancel_process_step_run_input_request_authorized(
  p_workspace_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request process_step_run_input_requests%rowtype;
  v_origin_comment process_step_run_comments%rowtype;
  v_canceller_user_id uuid := private.current_effective_user(p_workspace_id);
  v_real_canceller_user_id uuid := case
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id)
      then auth.uid()
    else null
  end;
  v_is_workspace_administrator boolean := false;
  v_run process_runs%rowtype;
begin
  if not private.is_workspace_member_as(p_workspace_id, v_canceller_user_id) then
    raise exception 'Workspace access denied';
  end if;

  select *
  into v_request
  from process_step_run_input_requests request
  where request.workspace_id = p_workspace_id
    and request.id = p_request_id
  for update;

  if not found then
    raise exception 'Request not found';
  end if;

  if v_request.response_process_step_run_comment_id is not null or v_request.cancelled_at is not null then
    raise exception 'Request is no longer open';
  end if;

  select *
  into v_origin_comment
  from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.process_run_id = v_request.process_run_id
    and comment.process_step_run_id = v_request.process_step_run_id
    and comment.id = v_request.origin_process_step_run_comment_id;

  select
    private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_members', v_canceller_user_id)
    and private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_roles', v_canceller_user_id)
  into v_is_workspace_administrator;

  if v_origin_comment.author_user_id <> v_canceller_user_id and not v_is_workspace_administrator then
    raise exception 'Only the requester or a workspace administrator can cancel this request';
  end if;

  update process_step_run_input_requests
  set cancelled_at = now(),
      cancelled_by_user_id = v_canceller_user_id,
      cancelled_by_real_actor_user_id = v_real_canceller_user_id
  where workspace_id = p_workspace_id
    and id = p_request_id;

  select *
  into v_run
  from process_runs run
  where run.workspace_id = p_workspace_id
    and run.id = v_request.process_run_id;

  insert into notifications (
    id,
    workspace_id,
    recipient_user_id,
    event_type,
    process_step_run_input_request_id,
    process_run_id,
    process_step_run_id,
    entity_type_id,
    entity_record_id,
    title,
    destination_href,
    dedup_key
  )
  values (
    gen_random_uuid(),
    p_workspace_id,
    v_request.recipient_user_id,
    'process_step_run_input_request_cancelled',
    p_request_id,
    v_request.process_run_id,
    v_request.process_step_run_id,
    v_run.origin_entity_type_id,
    v_run.origin_record_id,
    'Input request cancelled',
    '/process-runs/' || v_request.process_run_id::text || '#step-input-request-' || p_request_id::text,
    'process_step_run_input_request_cancelled:' || p_request_id::text || ':' || v_request.recipient_user_id::text
  )
  on conflict (workspace_id, dedup_key) do nothing;
end;
$$;

revoke all on function list_process_step_run_input_request_recipient_candidates_authorized(uuid) from public, anon;
grant execute on function list_process_step_run_input_request_recipient_candidates_authorized(uuid) to authenticated, service_role;

revoke all on function list_process_step_run_input_requests_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_process_step_run_input_requests_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;

revoke all on function create_process_step_run_input_request_authorized(uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function create_process_step_run_input_request_authorized(uuid, uuid, uuid, uuid, text) to authenticated, service_role;

revoke all on function respond_process_step_run_input_request_authorized(uuid, uuid, text) from public, anon;
grant execute on function respond_process_step_run_input_request_authorized(uuid, uuid, text) to authenticated, service_role;

revoke all on function cancel_process_step_run_input_request_authorized(uuid, uuid) from public, anon;
grant execute on function cancel_process_step_run_input_request_authorized(uuid, uuid) to authenticated, service_role;

comment on table process_step_run_input_requests
  is 'Lean Request for Input state for human-operable Process Step Runs (human_task, approval). Request and response prose/attribution live on linked process_step_run_comments; rows are cancelled/responded, never product-deleted. Collaboration overlay only -- never blocks step completion, affects routing, or alters assignment.';

comment on function create_process_step_run_input_request_authorized(uuid, uuid, uuid, uuid, text)
  is 'Atomically creates an originating process step run comment, lean input-request row, and recipient in-app notification for an eligible active/completed human-operable step.';

comment on function respond_process_step_run_input_request_authorized(uuid, uuid, text)
  is 'Atomically creates a response process step run comment, links it to an open request, and notifies the requester.';

comment on function cancel_process_step_run_input_request_authorized(uuid, uuid)
  is 'Cancels an open process step run input request by requester or effective workspace administrator and notifies the recipient.';
