-- Phase 10.1 corrective migration for record comment RPC defects found
-- after 0085 was applied.
--
-- 0085 remains immutable. The replaced functions below are sourced from
-- the complete latest definitions in 0085_record_comments.sql and change
-- only the confirmed defects:
-- - create_record_comment_authorized trims plain-text PostgreSQL whitespace,
--   not just ordinary spaces.
-- - list_record_comments_authorized qualifies table references whose names
--   collide with RETURNS TABLE output variables.

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

revoke all on function list_record_comments_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_record_comments_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;

revoke all on function create_record_comment_authorized(uuid, uuid, uuid, text) from public, anon;
grant execute on function create_record_comment_authorized(uuid, uuid, uuid, text) to authenticated, service_role;

comment on function list_record_comments_authorized(uuid, uuid, uuid, integer)
  is 'Membership-checked oldest-first read of durable human comments for one business record.';

comment on function create_record_comment_authorized(uuid, uuid, uuid, text)
  is 'Creates a plain-text record comment as the current effective records.operate user. Body is trimmed, bounded, and rejected when empty; archived records are read-only.';
