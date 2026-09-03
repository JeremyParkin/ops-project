-- Phase 10.4: record-level Request for Input.
--
-- Requests are structured response obligations inside record Discussion,
-- not tasks, reminders, or process work. The request text and human
-- attribution stay authoritative on the linked record comments: the request
-- row stores only state and stable links.

alter table record_comments
  add constraint record_comments_workspace_record_id_key
  unique (workspace_id, entity_type_id, entity_record_id, id);

create table record_input_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type_id uuid not null,
  entity_record_id uuid not null,
  origin_record_comment_id uuid not null,
  recipient_user_id uuid not null,
  response_record_comment_id uuid,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid,
  cancelled_by_real_actor_user_id uuid,

  unique (workspace_id, id),
  foreign key (workspace_id, entity_type_id, entity_record_id)
    references entity_records(workspace_id, entity_type_id, id)
    on delete restrict,
  foreign key (workspace_id, entity_type_id, entity_record_id, origin_record_comment_id)
    references record_comments(workspace_id, entity_type_id, entity_record_id, id)
    on delete restrict,
  foreign key (workspace_id, entity_type_id, entity_record_id, response_record_comment_id)
    references record_comments(workspace_id, entity_type_id, entity_record_id, id)
    on delete restrict,
  foreign key (workspace_id, recipient_user_id)
    references workspace_memberships(workspace_id, user_id)
    on delete restrict,
  check (
    (response_record_comment_id is null and cancelled_at is null and cancelled_by_user_id is null and cancelled_by_real_actor_user_id is null)
    or
    (response_record_comment_id is not null and cancelled_at is null and cancelled_by_user_id is null and cancelled_by_real_actor_user_id is null)
    or
    (response_record_comment_id is null and cancelled_at is not null and cancelled_by_user_id is not null)
  ),
  check (
    cancelled_by_real_actor_user_id is null
    or cancelled_by_user_id is not null
  )
);

create index record_input_requests_record_origin_idx
  on record_input_requests (workspace_id, entity_type_id, entity_record_id, origin_record_comment_id);

create index record_input_requests_recipient_open_idx
  on record_input_requests (workspace_id, recipient_user_id, origin_record_comment_id)
  where response_record_comment_id is null and cancelled_at is null;

alter table record_input_requests enable row level security;
revoke all on table record_input_requests from public, anon, authenticated;

alter table notifications
  add column record_input_request_id uuid;

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
    'record_input_request_cancelled'
  ));

alter table notifications
  drop constraint if exists notifications_comment_mention_shape_check;

alter table notifications
  add constraint notifications_collaboration_target_shape_check
  check (
    (
      event_type = 'record_comment_mentioned'
      and record_comment_id is not null
      and process_step_run_comment_id is null
      and record_input_request_id is null
    )
    or
    (
      event_type = 'process_step_run_comment_mentioned'
      and process_step_run_comment_id is not null
      and record_comment_id is null
      and record_input_request_id is null
    )
    or
    (
      event_type in ('record_input_request_created', 'record_input_request_responded', 'record_input_request_cancelled')
      and record_input_request_id is not null
      and record_comment_id is null
      and process_step_run_comment_id is null
    )
    or
    (
      event_type not in (
        'record_comment_mentioned',
        'process_step_run_comment_mentioned',
        'record_input_request_created',
        'record_input_request_responded',
        'record_input_request_cancelled'
      )
      and record_comment_id is null
      and process_step_run_comment_id is null
      and record_input_request_id is null
    )
  );

alter table notifications
  add constraint notifications_record_input_request_fkey
  foreign key (workspace_id, record_input_request_id)
  references record_input_requests(workspace_id, id)
  on delete restrict;

create index notifications_record_input_request_idx
  on notifications (workspace_id, record_input_request_id)
  where record_input_request_id is not null;

create function list_record_input_request_recipient_candidates_authorized(
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
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  return query
  select membership.user_id, users.email::text
  from workspace_memberships membership
  join auth.users users on users.id = membership.user_id
  where membership.workspace_id = p_workspace_id
    and membership.deactivated_at is null
    and private.has_workspace_capability_as(p_workspace_id, 'records.operate', membership.user_id)
  order by users.email, membership.user_id;
end;
$$;

create function list_record_input_requests_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_record_id uuid,
  p_limit integer default 100
)
returns table (
  id uuid,
  workspace_id uuid,
  entity_type_id uuid,
  entity_record_id uuid,
  origin_record_comment_id uuid,
  recipient_user_id uuid,
  recipient_label text,
  response_record_comment_id uuid,
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
    from entity_records record
    where record.workspace_id = p_workspace_id
      and record.entity_type_id = p_entity_type_id
      and record.id = p_entity_record_id
  ) then
    raise exception 'Record not found';
  end if;

  return query
  select
    request.id,
    request.workspace_id,
    request.entity_type_id,
    request.entity_record_id,
    request.origin_record_comment_id,
    request.recipient_user_id,
    recipient.email::text as recipient_label,
    request.response_record_comment_id,
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
  from record_input_requests request
  join record_comments origin
    on origin.workspace_id = request.workspace_id
   and origin.entity_type_id = request.entity_type_id
   and origin.entity_record_id = request.entity_record_id
   and origin.id = request.origin_record_comment_id
  join auth.users recipient on recipient.id = request.recipient_user_id
  left join record_comments response
    on response.workspace_id = request.workspace_id
   and response.entity_type_id = request.entity_type_id
   and response.entity_record_id = request.entity_record_id
   and response.id = request.response_record_comment_id
  where request.workspace_id = p_workspace_id
    and request.entity_type_id = p_entity_type_id
    and request.entity_record_id = p_entity_record_id
  order by origin.created_at asc, request.id asc
  limit p_limit;
end;
$$;

create function create_record_input_request_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_record_id uuid,
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
  v_origin_comment record_comments%rowtype;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if p_recipient_user_id is null then
    raise exception 'Request recipient is required';
  end if;

  if p_recipient_user_id = private.current_effective_user(p_workspace_id) then
    raise exception 'You cannot request input from yourself';
  end if;

  if not private.has_workspace_capability_as(p_workspace_id, 'records.operate', p_recipient_user_id) then
    raise exception 'Request recipient must be an active records.operate workspace member';
  end if;

  if not exists (
    select 1
    from entity_records record
    where record.workspace_id = p_workspace_id
      and record.entity_type_id = p_entity_type_id
      and record.id = p_entity_record_id
      and record.archived_at is null
  ) then
    raise exception 'Record not found or archived';
  end if;

  v_origin_comment_id := create_record_comment_authorized(
    p_workspace_id,
    p_entity_type_id,
    p_entity_record_id,
    p_body
  );

  select *
  into v_origin_comment
  from record_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.id = v_origin_comment_id;

  if not found then
    raise exception 'Request comment creation failed';
  end if;

  insert into record_input_requests (
    id,
    workspace_id,
    entity_type_id,
    entity_record_id,
    origin_record_comment_id,
    recipient_user_id
  )
  values (
    v_request_id,
    p_workspace_id,
    p_entity_type_id,
    p_entity_record_id,
    v_origin_comment_id,
    p_recipient_user_id
  );

  insert into notifications (
    id,
    workspace_id,
    recipient_user_id,
    event_type,
    record_input_request_id,
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
    'record_input_request_created',
    v_request_id,
    p_entity_type_id,
    p_entity_record_id,
    v_origin_comment.author_label || ' requested your input',
    '/entities/' || p_entity_type_id::text || '/records/' || p_entity_record_id::text || '#input-request-' || v_request_id::text,
    'record_input_request_created:' || v_request_id::text || ':' || p_recipient_user_id::text
  )
  on conflict (workspace_id, dedup_key) do nothing;

  return v_request_id;
end;
$$;

create function respond_record_input_request_authorized(
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
  v_request record_input_requests%rowtype;
  v_origin_comment record_comments%rowtype;
  v_response_comment_id uuid;
  v_response_comment record_comments%rowtype;
  v_responder_user_id uuid := private.current_effective_user(p_workspace_id);
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  select *
  into v_request
  from record_input_requests request
  where request.workspace_id = p_workspace_id
    and request.id = p_request_id
  for update;

  if not found then
    raise exception 'Request not found';
  end if;

  if v_request.response_record_comment_id is not null or v_request.cancelled_at is not null then
    raise exception 'Request is no longer open';
  end if;

  if v_request.recipient_user_id <> v_responder_user_id then
    raise exception 'Only the request recipient can respond';
  end if;

  if not exists (
    select 1
    from entity_records record
    where record.workspace_id = p_workspace_id
      and record.entity_type_id = v_request.entity_type_id
      and record.id = v_request.entity_record_id
      and record.archived_at is null
  ) then
    raise exception 'Record not found or archived';
  end if;

  v_response_comment_id := create_record_comment_authorized(
    p_workspace_id,
    v_request.entity_type_id,
    v_request.entity_record_id,
    p_body
  );

  update record_input_requests
  set response_record_comment_id = v_response_comment_id
  where workspace_id = p_workspace_id
    and id = p_request_id;

  select *
  into v_origin_comment
  from record_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.id = v_request.origin_record_comment_id;

  select *
  into v_response_comment
  from record_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.id = v_response_comment_id;

  insert into notifications (
    id,
    workspace_id,
    recipient_user_id,
    event_type,
    record_input_request_id,
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
    'record_input_request_responded',
    p_request_id,
    v_request.entity_type_id,
    v_request.entity_record_id,
    v_response_comment.author_label || ' responded to your request',
    '/entities/' || v_request.entity_type_id::text || '/records/' || v_request.entity_record_id::text || '#input-request-' || p_request_id::text,
    'record_input_request_responded:' || p_request_id::text || ':' || v_origin_comment.author_user_id::text
  )
  on conflict (workspace_id, dedup_key) do nothing;

  return v_response_comment_id;
end;
$$;

create function cancel_record_input_request_authorized(
  p_workspace_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request record_input_requests%rowtype;
  v_origin_comment record_comments%rowtype;
  v_canceller_user_id uuid := private.current_effective_user(p_workspace_id);
  v_real_canceller_user_id uuid := case
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id)
      then auth.uid()
    else null
  end;
  v_is_workspace_administrator boolean := false;
begin
  if not private.is_workspace_member_as(p_workspace_id, v_canceller_user_id) then
    raise exception 'Workspace access denied';
  end if;

  select *
  into v_request
  from record_input_requests request
  where request.workspace_id = p_workspace_id
    and request.id = p_request_id
  for update;

  if not found then
    raise exception 'Request not found';
  end if;

  if v_request.response_record_comment_id is not null or v_request.cancelled_at is not null then
    raise exception 'Request is no longer open';
  end if;

  select *
  into v_origin_comment
  from record_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.id = v_request.origin_record_comment_id;

  select
    private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_members', v_canceller_user_id)
    and private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_roles', v_canceller_user_id)
  into v_is_workspace_administrator;

  if v_origin_comment.author_user_id <> v_canceller_user_id and not v_is_workspace_administrator then
    raise exception 'Only the requester or a workspace administrator can cancel this request';
  end if;

  update record_input_requests
  set cancelled_at = now(),
      cancelled_by_user_id = v_canceller_user_id,
      cancelled_by_real_actor_user_id = v_real_canceller_user_id
  where workspace_id = p_workspace_id
    and id = p_request_id;

  insert into notifications (
    id,
    workspace_id,
    recipient_user_id,
    event_type,
    record_input_request_id,
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
    'record_input_request_cancelled',
    p_request_id,
    v_request.entity_type_id,
    v_request.entity_record_id,
    'Input request cancelled',
    '/entities/' || v_request.entity_type_id::text || '/records/' || v_request.entity_record_id::text || '#input-request-' || p_request_id::text,
    'record_input_request_cancelled:' || p_request_id::text || ':' || v_request.recipient_user_id::text
  )
  on conflict (workspace_id, dedup_key) do nothing;
end;
$$;

revoke all on function list_record_input_request_recipient_candidates_authorized(uuid) from public, anon;
grant execute on function list_record_input_request_recipient_candidates_authorized(uuid) to authenticated, service_role;

revoke all on function list_record_input_requests_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_record_input_requests_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;

revoke all on function create_record_input_request_authorized(uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function create_record_input_request_authorized(uuid, uuid, uuid, uuid, text) to authenticated, service_role;

revoke all on function respond_record_input_request_authorized(uuid, uuid, text) from public, anon;
grant execute on function respond_record_input_request_authorized(uuid, uuid, text) to authenticated, service_role;

revoke all on function cancel_record_input_request_authorized(uuid, uuid) from public, anon;
grant execute on function cancel_record_input_request_authorized(uuid, uuid) to authenticated, service_role;

comment on table record_input_requests
  is 'Lean record-level Request for Input state. Request and response prose/attribution live on linked record comments; rows are cancelled/responded, never product-deleted.';

comment on function create_record_input_request_authorized(uuid, uuid, uuid, uuid, text)
  is 'Atomically creates an originating record comment, lean input-request row, and recipient in-app notification for an active record.';

comment on function respond_record_input_request_authorized(uuid, uuid, text)
  is 'Atomically creates a response record comment, links it to an open request, and notifies the requester.';

comment on function cancel_record_input_request_authorized(uuid, uuid)
  is 'Cancels an open record input request by requester or effective workspace administrator and notifies the recipient.';
