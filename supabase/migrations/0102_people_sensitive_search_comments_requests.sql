-- Phase 12.2: People-Sensitive Read Access -- search, comments, and Request
-- for Input enforcement.
--
-- All of these are SECURITY DEFINER RPCs that read entity_records/
-- entity_record_relation_values directly with definer privilege, bypassing
-- RLS entirely (search_workspace_records_authorized queries entity_records
-- itself; the comment/input-request RPCs each independently check for the
-- parent record's existence). None of them previously had any sensitivity
-- awareness. Every check added reuses the exact error text the function
-- already produces for a genuinely nonexistent/archived record, so a
-- hidden sensitive record and a real 404 remain indistinguishable to the
-- caller -- comments/input-requests are a backend enforcement path, not UI
-- polish, and this migration audits every list/create/mutate RPC in both
-- families, not only the most visible one.
--
-- Full latest bodies reproduced faithfully (search: 0066; comments: 0086 for
-- list/create, 0085 for tombstone; input requests: 0089 for all four). No
-- signature or return-shape changes anywhere, so every function uses
-- `create or replace function`.

-- 1. search_workspace_records_authorized (latest body: 0066). One addition
-- to the `matches` CTE's WHERE clause: a candidate record must be visible
-- to the effective user, exactly as an ordinary read would require -- a
-- hidden sensitive record now behaves as if it were absent from search
-- entirely, not merely unlisted.
create or replace function search_workspace_records_authorized(
  p_workspace_id uuid,
  p_query text,
  p_entity_type_id uuid default null,
  p_limit_per_type integer default 20
)
returns table (
  entity_type_id uuid,
  record_id uuid,
  matched_field_id uuid,
  matched_field_name text,
  is_identity_match boolean,
  is_prefix_match boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_query text;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if p_limit_per_type is null or p_limit_per_type < 1 or p_limit_per_type > 100 then
    raise exception 'Search limit per entity type must be between 1 and 100';
  end if;

  v_query := lower(btrim(coalesce(p_query, '')));

  if v_query = '' then
    return;
  end if;

  -- LIKE's own wildcard characters (and its default escape character
  -- itself) must be escaped, or a literal "%"/"_" typed by the user would
  -- be interpreted as a wildcard rather than matched as plain text --
  -- preserving the old JS `.includes()`'s literal-substring semantics
  -- exactly, not just approximately.
  v_query := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  with identity_fields as (
    -- The same resolution order as getRecordIdentityField: the configured
    -- display field if it's still a live text field, else the first
    -- non-archived text field by position. Resolved once per entity type
    -- here (both id and key), not re-derived per candidate field below.
    select
      et.id as entity_type_id,
      coalesce(configured.id, fallback.id) as identity_field_id,
      coalesce(configured.key, fallback.key) as identity_key
    from entity_types et
    left join field_definitions configured
      on configured.workspace_id = p_workspace_id
      and configured.id = et.display_field_definition_id
      and configured.type = 'text'
      and configured.archived_at is null
    left join lateral (
      select fd.id, fd.key from field_definitions fd
      where fd.workspace_id = p_workspace_id
        and fd.entity_type_id = et.id
        and fd.type = 'text'
        and fd.archived_at is null
      order by fd.position, fd.id
      limit 1
    ) fallback on configured.id is null
    where et.workspace_id = p_workspace_id
      and et.archived_at is null
      and (p_entity_type_id is null or et.id = p_entity_type_id)
  ),
  matches as (
    select
      er.entity_type_id,
      er.id as record_id,
      best.field_id as matched_field_id,
      best.field_name as matched_field_name,
      best.field_position as matched_field_position,
      best.is_identity as is_identity_match,
      best.is_prefix as is_prefix_match,
      coalesce(er.values ->> idf.identity_key, '') as tiebreak_value
    from entity_records er
    join identity_fields idf on idf.entity_type_id = er.entity_type_id
    join lateral (
      select
        fd.id as field_id,
        fd.name as field_name,
        fd.position as field_position,
        (fd.id = idf.identity_field_id) as is_identity,
        (lower(er.values ->> fd.key) like v_query || '%') as is_prefix
      from field_definitions fd
      where fd.workspace_id = p_workspace_id
        and fd.entity_type_id = er.entity_type_id
        and fd.type = 'text'
        and fd.archived_at is null
        and er.values ? fd.key
        and lower(er.values ->> fd.key) like '%' || v_query || '%'
      order by
        (fd.id = idf.identity_field_id) desc,
        (lower(er.values ->> fd.key) like v_query || '%') desc,
        fd.position asc,
        fd.id asc
      limit 1
    ) best on true
    where er.workspace_id = p_workspace_id
      and er.archived_at is null
      and private.can_view_people_sensitive_record(
        p_workspace_id, er.entity_type_id, er.id, private.current_effective_user(p_workspace_id)
      )
  ),
  ranked as (
    select
      m.*,
      row_number() over (
        partition by m.entity_type_id
        order by
          m.is_identity_match desc,
          m.is_prefix_match desc,
          m.matched_field_position asc,
          m.tiebreak_value asc,
          m.record_id asc
      ) as rn
    from matches m
  )
  select
    ranked.entity_type_id,
    ranked.record_id,
    ranked.matched_field_id,
    ranked.matched_field_name,
    ranked.is_identity_match,
    ranked.is_prefix_match
  from ranked
  where ranked.rn <= p_limit_per_type
  order by ranked.entity_type_id, ranked.rn;
end;
$$;

-- 2. list_record_comments_authorized (latest body: 0086). Visibility folded
-- into the existing record-existence check, same "Record not found" text.
create or replace function list_record_comments_authorized(
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
  body text,
  author_user_id uuid,
  author_label text,
  real_actor_user_id uuid,
  real_actor_label text,
  created_at timestamptz,
  tombstoned_at timestamptz,
  tombstoned_by_user_id uuid,
  tombstoned_by_label text,
  tombstoned_by_real_actor_user_id uuid,
  tombstoned_by_real_actor_label text
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
    raise exception 'Comment limit must be between 1 and 200';
  end if;

  if not exists (
    select 1
    from public.entity_records record
    where record.workspace_id = p_workspace_id
      and record.entity_type_id = p_entity_type_id
      and record.id = p_entity_record_id
  ) then
    raise exception 'Record not found';
  end if;

  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_entity_record_id, private.current_effective_user(p_workspace_id)
  ) then
    raise exception 'Record not found';
  end if;

  return query
  select
    comment.id,
    comment.workspace_id,
    comment.entity_type_id,
    comment.entity_record_id,
    case when comment.tombstoned_at is null then comment.body else null end as body,
    comment.author_user_id,
    comment.author_label,
    comment.real_actor_user_id,
    comment.real_actor_label,
    comment.created_at,
    comment.tombstoned_at,
    comment.tombstoned_by_user_id,
    comment.tombstoned_by_label,
    comment.tombstoned_by_real_actor_user_id,
    comment.tombstoned_by_real_actor_label
  from public.record_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.entity_type_id = p_entity_type_id
    and comment.entity_record_id = p_entity_record_id
  order by comment.created_at asc, comment.id asc
  limit p_limit;
end;
$$;

-- 3. create_record_comment_authorized (latest body: 0086). Visibility
-- folded into the existing "Record not found or archived" check.
create or replace function create_record_comment_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_record_id uuid,
  p_body text
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
  v_real_actor_user_id uuid := case
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id)
      then auth.uid()
    else null
  end;
  v_author_label text;
  v_real_actor_label text;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if v_author_user_id is null then
    raise exception 'Comment author is required';
  end if;

  if v_body = '' then
    raise exception 'Comment body is required';
  end if;

  if char_length(v_body) > 4000 then
    raise exception 'Comment body must be 4000 characters or fewer';
  end if;

  if not exists (
    select 1
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_entity_record_id
      and archived_at is null
  ) then
    raise exception 'Record not found or archived';
  end if;

  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_entity_record_id, v_author_user_id
  ) then
    raise exception 'Record not found or archived';
  end if;

  select email::text into v_author_label from auth.users where id = v_author_user_id;
  if nullif(btrim(coalesce(v_author_label, '')), '') is null then
    raise exception 'Comment author was not found';
  end if;

  if v_real_actor_user_id is not null then
    select email::text into v_real_actor_label from auth.users where id = v_real_actor_user_id;
    if nullif(btrim(coalesce(v_real_actor_label, '')), '') is null then
      raise exception 'Real actor was not found';
    end if;
  end if;

  insert into record_comments (
    id,
    workspace_id,
    entity_type_id,
    entity_record_id,
    body,
    author_user_id,
    author_label,
    real_actor_user_id,
    real_actor_label
  )
  values (
    v_comment_id,
    p_workspace_id,
    p_entity_type_id,
    p_entity_record_id,
    v_body,
    v_author_user_id,
    v_author_label,
    v_real_actor_user_id,
    v_real_actor_label
  );

  return v_comment_id;
end;
$$;

comment on function list_record_comments_authorized(uuid, uuid, uuid, integer)
  is 'Membership-checked oldest-first read of durable human comments for one business record. A hidden people-sensitive record behaves identically to a nonexistent one.';

comment on function create_record_comment_authorized(uuid, uuid, uuid, text)
  is 'Creates a plain-text record comment as the current effective records.operate user. Body is trimmed, bounded, and rejected when empty; archived or hidden people-sensitive records are treated identically to a nonexistent record.';

-- 4. tombstone_record_comment_authorized (latest and only body: 0085).
-- Visibility folded into the existing "Comment not found" check, using the
-- comment's own recorded entity_type_id/entity_record_id.
create or replace function tombstone_record_comment_authorized(
  p_workspace_id uuid,
  p_comment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment record_comments%rowtype;
  v_deleter_user_id uuid := private.current_effective_user(p_workspace_id);
  v_real_deleter_user_id uuid := case
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id)
      then auth.uid()
    else null
  end;
  v_deleter_label text;
  v_real_deleter_label text;
  v_is_workspace_administrator boolean := false;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if v_deleter_user_id is null then
    raise exception 'Comment deleter is required';
  end if;

  select * into v_comment
  from record_comments
  where workspace_id = p_workspace_id
    and id = p_comment_id
  for update;

  if not found then
    raise exception 'Comment not found';
  end if;

  if not private.can_view_people_sensitive_record(
    p_workspace_id, v_comment.entity_type_id, v_comment.entity_record_id, v_deleter_user_id
  ) then
    raise exception 'Comment not found';
  end if;

  select
    private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_members', v_deleter_user_id)
    and private.has_workspace_capability_as(p_workspace_id, 'workspace.manage_roles', v_deleter_user_id)
  into v_is_workspace_administrator;

  if v_comment.author_user_id <> v_deleter_user_id and not v_is_workspace_administrator then
    raise exception 'You can only remove your own comments';
  end if;

  if v_comment.tombstoned_at is not null then
    return;
  end if;

  select email::text into v_deleter_label from auth.users where id = v_deleter_user_id;
  if nullif(btrim(coalesce(v_deleter_label, '')), '') is null then
    raise exception 'Comment deleter was not found';
  end if;

  if v_real_deleter_user_id is not null then
    select email::text into v_real_deleter_label from auth.users where id = v_real_deleter_user_id;
    if nullif(btrim(coalesce(v_real_deleter_label, '')), '') is null then
      raise exception 'Real deleter was not found';
    end if;
  end if;

  update record_comments
  set tombstoned_at = now(),
      tombstoned_by_user_id = v_deleter_user_id,
      tombstoned_by_label = v_deleter_label,
      tombstoned_by_real_actor_user_id = v_real_deleter_user_id,
      tombstoned_by_real_actor_label = v_real_deleter_label
  where workspace_id = p_workspace_id
    and id = p_comment_id;
end;
$$;

-- 5. list_record_input_requests_authorized (latest and only body: 0089).
-- Visibility folded into the existing "Record not found" check.
create or replace function list_record_input_requests_authorized(
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

  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_entity_record_id, private.current_effective_user(p_workspace_id)
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

-- 6. create_record_input_request_authorized (latest and only body: 0089).
-- Visibility folded into the existing "Record not found or archived"
-- check.
create or replace function create_record_input_request_authorized(
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

  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_entity_record_id, private.current_effective_user(p_workspace_id)
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

-- 7. respond_record_input_request_authorized (latest and only body: 0089).
-- Visibility folded into the existing "Record not found or archived"
-- check (evaluated after the request row is fetched, against the
-- request's own recorded entity_type_id/entity_record_id).
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

  if not private.can_view_people_sensitive_record(
    p_workspace_id, v_request.entity_type_id, v_request.entity_record_id, v_responder_user_id
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

-- 8. cancel_record_input_request_authorized (latest and only body: 0089).
-- Previously had NO record-level check at all (only the request's own
-- open/cancelled state and requester-or-admin authority). Adds a
-- visibility check reusing the exact same "Request not found" text the
-- function already raises for a genuinely nonexistent request id.
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

  if not private.can_view_people_sensitive_record(
    p_workspace_id, v_request.entity_type_id, v_request.entity_record_id, v_canceller_user_id
  ) then
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

comment on function tombstone_record_comment_authorized(uuid, uuid)
  is 'Tombstones (soft-deletes) a record comment. Author or effective workspace administrator only. A comment on a hidden people-sensitive record behaves identically to a nonexistent comment.';

comment on function list_record_input_requests_authorized(uuid, uuid, uuid, integer)
  is 'Membership-checked oldest-first read of Request for Input state for one business record. A hidden people-sensitive record behaves identically to a nonexistent one.';

comment on function create_record_input_request_authorized(uuid, uuid, uuid, uuid, text)
  is 'Atomically creates an originating record comment, lean input-request row, and recipient in-app notification for an active, visible record.';

comment on function respond_record_input_request_authorized(uuid, uuid, text)
  is 'Atomically creates a response record comment, links it to an open request, and notifies the requester. The parent record must remain active and visible to the responder.';

comment on function cancel_record_input_request_authorized(uuid, uuid)
  is 'Cancels an open record input request by requester or effective workspace administrator and notifies the recipient. A request on a hidden people-sensitive record behaves identically to a nonexistent request.';
