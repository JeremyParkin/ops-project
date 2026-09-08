-- Phase 14.2: owner-controlled suppression for optional in-app notifications.
-- Operational notifications remain mandatory and are intentionally untouched.

alter table user_preferences
  add column notify_comment_mentions boolean not null default true,
  add column notify_input_request_status_updates boolean not null default true;

drop function if exists get_user_preferences_authorized();
create function get_user_preferences_authorized()
returns table(
  theme text,
  timezone text,
  notify_comment_mentions boolean,
  notify_input_request_status_updates boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  select preferences.theme,
         preferences.timezone,
         preferences.notify_comment_mentions,
         preferences.notify_input_request_status_updates
  from user_preferences preferences
  where preferences.user_id = auth.uid();
end;
$$;

drop function if exists update_user_preferences_authorized(text, text);
create function update_user_preferences_authorized(
  p_theme text,
  p_timezone text,
  p_notify_comment_mentions boolean,
  p_notify_input_request_status_updates boolean
)
returns table(
  theme text,
  timezone text,
  notify_comment_mentions boolean,
  notify_input_request_status_updates boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text := nullif(btrim(p_timezone), '');
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_theme not in ('system', 'light', 'dark') then
    raise exception 'Invalid theme';
  end if;

  if v_timezone is not null and not exists (
    select 1 from pg_timezone_names where name = v_timezone
  ) then
    raise exception 'Unrecognized timezone: %', v_timezone;
  end if;

  if exists (
    select 1 from impersonation_sessions
    where real_actor_user_id = v_user_id and ended_at is null
  ) then
    raise exception 'Exit impersonation before changing personal settings';
  end if;

  insert into user_preferences (
    user_id, theme, timezone,
    notify_comment_mentions, notify_input_request_status_updates
  )
  values (
    v_user_id, p_theme, v_timezone,
    coalesce(p_notify_comment_mentions, true),
    coalesce(p_notify_input_request_status_updates, true)
  )
  on conflict (user_id) do update
    set theme = excluded.theme,
        timezone = excluded.timezone,
        notify_comment_mentions = excluded.notify_comment_mentions,
        notify_input_request_status_updates = excluded.notify_input_request_status_updates,
        updated_at = now();

  return query
  select preferences.theme,
         preferences.timezone,
         preferences.notify_comment_mentions,
         preferences.notify_input_request_status_updates
  from user_preferences preferences
  where preferences.user_id = v_user_id;
end;
$$;

revoke all on function get_user_preferences_authorized() from public, anon, service_role;
grant execute on function get_user_preferences_authorized() to authenticated;
revoke all on function update_user_preferences_authorized(text, text, boolean, boolean) from public, anon, service_role;
grant execute on function update_user_preferences_authorized(text, text, boolean, boolean) to authenticated;

create function private.should_create_optional_notification(
  p_recipient_user_id uuid,
  p_event_type text
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_event_type in ('record_comment_mentioned', 'process_step_run_comment_mentioned') then
      coalesce((select preferences.notify_comment_mentions
                from user_preferences preferences
                where preferences.user_id = p_recipient_user_id), true)
    when p_event_type in (
      'record_input_request_responded',
      'record_input_request_cancelled',
      'process_step_run_input_request_responded',
      'process_step_run_input_request_cancelled'
    ) then
      coalesce((select preferences.notify_input_request_status_updates
                from user_preferences preferences
                where preferences.user_id = p_recipient_user_id), true)
    else true
  end;
$$;

revoke all on function private.should_create_optional_notification(uuid, text)
  from public, anon, authenticated, service_role;

-- The following six definitions are copied from the latest canonical bodies
-- in migrations 0087-0090. Each changes only whether its optional
-- notification row is inserted for the intended recipient.

create or replace function create_record_comment_with_mentions_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_record_id uuid,
  p_body text,
  p_mentioned_user_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment_id uuid;
  v_comment record_comments%rowtype;
  v_mentioned_user_ids uuid[];
  v_requested_count integer;
  v_valid_count integer;
  v_mentioned_user_id uuid;
begin
  v_comment_id := create_record_comment_authorized(
    p_workspace_id, p_entity_type_id, p_entity_record_id, p_body
  );

  select * into v_comment
  from record_comments comment
  where comment.workspace_id = p_workspace_id and comment.id = v_comment_id;

  if not found then raise exception 'Comment creation failed'; end if;

  select coalesce(array_agg(distinct requested.mentioned_user_id order by requested.mentioned_user_id), '{}'::uuid[])
  into v_mentioned_user_ids
  from unnest(coalesce(p_mentioned_user_ids, '{}'::uuid[])) as requested(mentioned_user_id)
  where requested.mentioned_user_id is not null;

  v_requested_count := coalesce(array_length(v_mentioned_user_ids, 1), 0);
  if v_requested_count = 0 then return v_comment_id; end if;

  select count(*)::integer into v_valid_count
  from workspace_memberships membership
  where membership.workspace_id = p_workspace_id
    and membership.deactivated_at is null
    and membership.user_id = any(v_mentioned_user_ids);

  if v_valid_count <> v_requested_count then
    raise exception 'Mention recipients must be active workspace members';
  end if;

  insert into record_comment_mentions (workspace_id, record_comment_id, mentioned_user_id)
  select p_workspace_id, v_comment_id, mentioned.mentioned_user_id
  from unnest(v_mentioned_user_ids) as mentioned(mentioned_user_id)
  on conflict (workspace_id, record_comment_id, mentioned_user_id) do nothing;

  for v_mentioned_user_id in
    select mention.mentioned_user_id
    from record_comment_mentions mention
    where mention.workspace_id = p_workspace_id
      and mention.record_comment_id = v_comment_id
      and mention.mentioned_user_id <> v_comment.author_user_id
    order by mention.mentioned_user_id
  loop
    if private.should_create_optional_notification(v_mentioned_user_id, 'record_comment_mentioned') then
      insert into notifications (
        id, workspace_id, recipient_user_id, event_type, record_comment_id,
        entity_type_id, entity_record_id, title, destination_href, dedup_key
      )
      values (
        gen_random_uuid(), p_workspace_id, v_mentioned_user_id, 'record_comment_mentioned',
        v_comment_id, p_entity_type_id, p_entity_record_id, v_comment.author_label || ' mentioned you',
        '/entities/' || p_entity_type_id::text || '/records/' || p_entity_record_id::text || '#comment-' || v_comment_id::text,
        'record_comment_mention:' || v_comment_id::text || ':' || v_mentioned_user_id::text
      )
      on conflict (workspace_id, dedup_key) do nothing;
    end if;
  end loop;

  return v_comment_id;
end;
$$;

create or replace function create_process_step_run_comment_with_mentions_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_process_step_run_id uuid,
  p_body text,
  p_mentioned_user_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment_id uuid := gen_random_uuid();
  v_body text := regexp_replace(coalesce(p_body, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_author_user_id uuid := private.current_effective_user(p_workspace_id);
  v_real_actor_user_id uuid := case when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id) then auth.uid() else null end;
  v_author_label text;
  v_real_actor_label text;
  v_run process_runs%rowtype;
  v_step process_step_runs%rowtype;
  v_mentioned_user_ids uuid[];
  v_requested_count integer;
  v_valid_count integer;
  v_mentioned_user_id uuid;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');
  if v_author_user_id is null then raise exception 'Comment author is required'; end if;
  if v_body = '' then raise exception 'Comment body is required'; end if;
  if char_length(v_body) > 4000 then raise exception 'Comment body must be 4000 characters or fewer'; end if;

  select * into v_run from process_runs run
  where run.workspace_id = p_workspace_id and run.id = p_process_run_id;
  if not found then raise exception 'Process run not found'; end if;

  select * into v_step from process_step_runs step
  where step.workspace_id = p_workspace_id and step.process_run_id = p_process_run_id
    and step.id = p_process_step_run_id and step.node_type in ('human_task', 'approval')
    and step.status in ('active', 'completed');
  if not found then raise exception 'Step not found or not open for discussion'; end if;

  if not exists (
    select 1 from entity_records record
    where record.workspace_id = p_workspace_id and record.entity_type_id = v_run.origin_entity_type_id
      and record.id = v_run.origin_record_id and record.archived_at is null
  ) then raise exception 'Origin record not found or archived'; end if;

  select email::text into v_author_label from auth.users where id = v_author_user_id;
  if nullif(btrim(coalesce(v_author_label, '')), '') is null then raise exception 'Comment author was not found'; end if;
  if v_real_actor_user_id is not null then
    select email::text into v_real_actor_label from auth.users where id = v_real_actor_user_id;
    if nullif(btrim(coalesce(v_real_actor_label, '')), '') is null then raise exception 'Real actor was not found'; end if;
  end if;

  insert into process_step_run_comments (
    id, workspace_id, process_run_id, process_step_run_id, body,
    author_user_id, author_label, real_actor_user_id, real_actor_label
  ) values (
    v_comment_id, p_workspace_id, p_process_run_id, p_process_step_run_id, v_body,
    v_author_user_id, v_author_label, v_real_actor_user_id, v_real_actor_label
  );

  select coalesce(array_agg(distinct requested.mentioned_user_id order by requested.mentioned_user_id), '{}'::uuid[])
  into v_mentioned_user_ids
  from unnest(coalesce(p_mentioned_user_ids, '{}'::uuid[])) as requested(mentioned_user_id)
  where requested.mentioned_user_id is not null;
  v_requested_count := coalesce(array_length(v_mentioned_user_ids, 1), 0);
  if v_requested_count = 0 then return v_comment_id; end if;

  select count(*)::integer into v_valid_count
  from workspace_memberships membership
  where membership.workspace_id = p_workspace_id and membership.deactivated_at is null
    and membership.user_id = any(v_mentioned_user_ids);
  if v_valid_count <> v_requested_count then raise exception 'Mention recipients must be active workspace members'; end if;

  insert into process_step_run_comment_mentions (workspace_id, process_step_run_comment_id, mentioned_user_id)
  select p_workspace_id, v_comment_id, mentioned.mentioned_user_id
  from unnest(v_mentioned_user_ids) as mentioned(mentioned_user_id)
  on conflict (workspace_id, process_step_run_comment_id, mentioned_user_id) do nothing;

  for v_mentioned_user_id in
    select mention.mentioned_user_id from process_step_run_comment_mentions mention
    where mention.workspace_id = p_workspace_id and mention.process_step_run_comment_id = v_comment_id
      and mention.mentioned_user_id <> v_author_user_id
    order by mention.mentioned_user_id
  loop
    if private.should_create_optional_notification(v_mentioned_user_id, 'process_step_run_comment_mentioned') then
      insert into notifications (
        id, workspace_id, recipient_user_id, event_type, process_run_id, process_step_run_id,
        process_step_run_comment_id, entity_type_id, entity_record_id, title, destination_href, dedup_key
      ) values (
        gen_random_uuid(), p_workspace_id, v_mentioned_user_id, 'process_step_run_comment_mentioned',
        p_process_run_id, p_process_step_run_id, v_comment_id, v_run.origin_entity_type_id, v_run.origin_record_id,
        v_author_label || ' mentioned you in a process step',
        '/process-runs/' || p_process_run_id::text || '#step-comment-' || v_comment_id::text,
        'process_step_run_comment_mention:' || v_comment_id::text || ':' || v_mentioned_user_id::text
      ) on conflict (workspace_id, dedup_key) do nothing;
    end if;
  end loop;
  return v_comment_id;
end;
$$;

create or replace function respond_record_input_request_authorized(
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
  select * into v_request from record_input_requests request
  where request.workspace_id = p_workspace_id and request.id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_request.response_record_comment_id is not null or v_request.cancelled_at is not null then
    raise exception 'Request is no longer open';
  end if;
  if v_request.recipient_user_id <> v_responder_user_id then
    raise exception 'Only the request recipient can respond';
  end if;
  if not exists (
    select 1 from entity_records record
    where record.workspace_id = p_workspace_id and record.entity_type_id = v_request.entity_type_id
      and record.id = v_request.entity_record_id and record.archived_at is null
  ) then raise exception 'Record not found or archived'; end if;
  if not private.can_view_people_sensitive_record(
    p_workspace_id, v_request.entity_type_id, v_request.entity_record_id, v_responder_user_id
  ) then raise exception 'Record not found or archived'; end if;

  v_response_comment_id := create_record_comment_authorized(
    p_workspace_id, v_request.entity_type_id, v_request.entity_record_id, p_body
  );
  update record_input_requests set response_record_comment_id = v_response_comment_id
  where workspace_id = p_workspace_id and id = p_request_id;
  select * into v_origin_comment from record_comments comment
  where comment.workspace_id = p_workspace_id and comment.id = v_request.origin_record_comment_id;
  select * into v_response_comment from record_comments comment
  where comment.workspace_id = p_workspace_id and comment.id = v_response_comment_id;

  if private.should_create_optional_notification(v_origin_comment.author_user_id, 'record_input_request_responded') then
    insert into notifications (
      id, workspace_id, recipient_user_id, event_type, record_input_request_id,
      entity_type_id, entity_record_id, title, destination_href, dedup_key
    ) values (
      gen_random_uuid(), p_workspace_id, v_origin_comment.author_user_id, 'record_input_request_responded',
      p_request_id, v_request.entity_type_id, v_request.entity_record_id,
      v_response_comment.author_label || ' responded to your request',
      '/entities/' || v_request.entity_type_id::text || '/records/' || v_request.entity_record_id::text || '#input-request-' || p_request_id::text,
      'record_input_request_responded:' || p_request_id::text || ':' || v_origin_comment.author_user_id::text
    ) on conflict (workspace_id, dedup_key) do nothing;
  end if;
  return v_response_comment_id;
end;
$$;

create or replace function cancel_record_input_request_authorized(
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
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id) then auth.uid()
    else null
  end;
  v_is_workspace_administrator boolean := false;
begin
  if not private.is_workspace_member_as(p_workspace_id, v_canceller_user_id) then
    raise exception 'Workspace access denied';
  end if;
  select * into v_request from record_input_requests request
  where request.workspace_id = p_workspace_id and request.id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if not private.can_view_people_sensitive_record(
    p_workspace_id, v_request.entity_type_id, v_request.entity_record_id, v_canceller_user_id
  ) then raise exception 'Request not found'; end if;
  if v_request.response_record_comment_id is not null or v_request.cancelled_at is not null then
    raise exception 'Request is no longer open';
  end if;
  select * into v_origin_comment from record_comments comment
  where comment.workspace_id = p_workspace_id and comment.id = v_request.origin_record_comment_id;
  select
    private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_members', v_canceller_user_id)
    and private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_roles', v_canceller_user_id)
  into v_is_workspace_administrator;
  if v_origin_comment.author_user_id <> v_canceller_user_id and not v_is_workspace_administrator then
    raise exception 'Only the requester or a workspace administrator can cancel this request';
  end if;
  update record_input_requests
  set cancelled_at = now(), cancelled_by_user_id = v_canceller_user_id,
      cancelled_by_real_actor_user_id = v_real_canceller_user_id
  where workspace_id = p_workspace_id and id = p_request_id;

  if private.should_create_optional_notification(v_request.recipient_user_id, 'record_input_request_cancelled') then
    insert into notifications (
      id, workspace_id, recipient_user_id, event_type, record_input_request_id,
      entity_type_id, entity_record_id, title, destination_href, dedup_key
    ) values (
      gen_random_uuid(), p_workspace_id, v_request.recipient_user_id, 'record_input_request_cancelled',
      p_request_id, v_request.entity_type_id, v_request.entity_record_id, 'Input request cancelled',
      '/entities/' || v_request.entity_type_id::text || '/records/' || v_request.entity_record_id::text || '#input-request-' || p_request_id::text,
      'record_input_request_cancelled:' || p_request_id::text || ':' || v_request.recipient_user_id::text
    ) on conflict (workspace_id, dedup_key) do nothing;
  end if;
end;
$$;

create or replace function respond_process_step_run_input_request_authorized(
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
  select * into v_request from process_step_run_input_requests request
  where request.workspace_id = p_workspace_id and request.id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_request.response_process_step_run_comment_id is not null or v_request.cancelled_at is not null then
    raise exception 'Request is no longer open';
  end if;
  if v_request.recipient_user_id <> v_responder_user_id then
    raise exception 'Only the request recipient can respond';
  end if;
  v_response_comment_id := create_process_step_run_comment_with_mentions_authorized(
    p_workspace_id, v_request.process_run_id, v_request.process_step_run_id, p_body, '{}'::uuid[]
  );
  update process_step_run_input_requests set response_process_step_run_comment_id = v_response_comment_id
  where workspace_id = p_workspace_id and id = p_request_id;
  select * into v_origin_comment from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id and comment.process_run_id = v_request.process_run_id
    and comment.process_step_run_id = v_request.process_step_run_id and comment.id = v_request.origin_process_step_run_comment_id;
  select * into v_response_comment from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id and comment.process_run_id = v_request.process_run_id
    and comment.process_step_run_id = v_request.process_step_run_id and comment.id = v_response_comment_id;
  select * into v_run from process_runs run
  where run.workspace_id = p_workspace_id and run.id = v_request.process_run_id;

  if private.should_create_optional_notification(v_origin_comment.author_user_id, 'process_step_run_input_request_responded') then
    insert into notifications (
      id, workspace_id, recipient_user_id, event_type, process_step_run_input_request_id,
      process_run_id, process_step_run_id, entity_type_id, entity_record_id, title, destination_href, dedup_key
    ) values (
      gen_random_uuid(), p_workspace_id, v_origin_comment.author_user_id, 'process_step_run_input_request_responded',
      p_request_id, v_request.process_run_id, v_request.process_step_run_id, v_run.origin_entity_type_id, v_run.origin_record_id,
      v_response_comment.author_label || ' responded to your request',
      '/process-runs/' || v_request.process_run_id::text || '#step-input-request-' || p_request_id::text,
      'process_step_run_input_request_responded:' || p_request_id::text || ':' || v_origin_comment.author_user_id::text
    ) on conflict (workspace_id, dedup_key) do nothing;
  end if;
  return v_response_comment_id;
end;
$$;

create or replace function cancel_process_step_run_input_request_authorized(
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
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id) then auth.uid()
    else null
  end;
  v_is_workspace_administrator boolean := false;
  v_run process_runs%rowtype;
begin
  if not private.is_workspace_member_as(p_workspace_id, v_canceller_user_id) then
    raise exception 'Workspace access denied';
  end if;
  select * into v_request from process_step_run_input_requests request
  where request.workspace_id = p_workspace_id and request.id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_request.response_process_step_run_comment_id is not null or v_request.cancelled_at is not null then
    raise exception 'Request is no longer open';
  end if;
  select * into v_origin_comment from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id and comment.process_run_id = v_request.process_run_id
    and comment.process_step_run_id = v_request.process_step_run_id and comment.id = v_request.origin_process_step_run_comment_id;
  select
    private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_members', v_canceller_user_id)
    and private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_roles', v_canceller_user_id)
  into v_is_workspace_administrator;
  if v_origin_comment.author_user_id <> v_canceller_user_id and not v_is_workspace_administrator then
    raise exception 'Only the requester or a workspace administrator can cancel this request';
  end if;
  update process_step_run_input_requests
  set cancelled_at = now(), cancelled_by_user_id = v_canceller_user_id,
      cancelled_by_real_actor_user_id = v_real_canceller_user_id
  where workspace_id = p_workspace_id and id = p_request_id;
  select * into v_run from process_runs run
  where run.workspace_id = p_workspace_id and run.id = v_request.process_run_id;

  if private.should_create_optional_notification(v_request.recipient_user_id, 'process_step_run_input_request_cancelled') then
    insert into notifications (
      id, workspace_id, recipient_user_id, event_type, process_step_run_input_request_id,
      process_run_id, process_step_run_id, entity_type_id, entity_record_id, title, destination_href, dedup_key
    ) values (
      gen_random_uuid(), p_workspace_id, v_request.recipient_user_id, 'process_step_run_input_request_cancelled',
      p_request_id, v_request.process_run_id, v_request.process_step_run_id, v_run.origin_entity_type_id, v_run.origin_record_id,
      'Input request cancelled',
      '/process-runs/' || v_request.process_run_id::text || '#step-input-request-' || p_request_id::text,
      'process_step_run_input_request_cancelled:' || p_request_id::text || ':' || v_request.recipient_user_id::text
    ) on conflict (workspace_id, dedup_key) do nothing;
  end if;
end;
$$;

revoke all on function create_record_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[]) from public, anon;
grant execute on function create_record_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[]) to authenticated, service_role;
revoke all on function create_process_step_run_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[]) from public, anon;
grant execute on function create_process_step_run_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[]) to authenticated, service_role;
revoke all on function respond_record_input_request_authorized(uuid, uuid, text) from public, anon;
grant execute on function respond_record_input_request_authorized(uuid, uuid, text) to authenticated, service_role;
revoke all on function cancel_record_input_request_authorized(uuid, uuid) from public, anon;
grant execute on function cancel_record_input_request_authorized(uuid, uuid) to authenticated, service_role;
revoke all on function respond_process_step_run_input_request_authorized(uuid, uuid, text) from public, anon;
grant execute on function respond_process_step_run_input_request_authorized(uuid, uuid, text) to authenticated, service_role;
revoke all on function cancel_process_step_run_input_request_authorized(uuid, uuid) from public, anon;
grant execute on function cancel_process_step_run_input_request_authorized(uuid, uuid) to authenticated, service_role;
