-- Phase 10.2: durable record-comment mentions and mention notifications.
--
-- 0085/0086 remain immutable. Plain comments continue to use
-- create_record_comment_authorized(uuid, uuid, uuid, text). The new RPC has
-- a distinct name to avoid Supabase/PostgREST overload ambiguity and wraps the
-- existing create RPC in the same transaction before adding mentions and
-- notifications.

alter table record_comments
  add constraint record_comments_workspace_id_id_key unique (workspace_id, id);

create table record_comment_mentions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  record_comment_id uuid not null,
  mentioned_user_id uuid not null,
  created_at timestamptz not null default now(),

  unique (workspace_id, record_comment_id, mentioned_user_id),
  foreign key (workspace_id, record_comment_id)
    references record_comments(workspace_id, id) on delete cascade,
  foreign key (workspace_id, mentioned_user_id)
    references workspace_memberships(workspace_id, user_id) on delete restrict
);

create index record_comment_mentions_recipient_idx
  on record_comment_mentions (workspace_id, mentioned_user_id, created_at desc);
create index record_comment_mentions_comment_idx
  on record_comment_mentions (workspace_id, record_comment_id);

alter table record_comment_mentions enable row level security;

revoke all on table record_comment_mentions from public, anon, authenticated;

alter table notifications
  add column record_comment_id uuid;

alter table notifications
  drop constraint if exists notifications_event_type_check;

alter table notifications
  add constraint notifications_event_type_check
  check (event_type in ('step_assigned', 'step_due_soon', 'step_overdue', 'record_comment_mentioned'));

alter table notifications
  add constraint notifications_record_comment_mention_fkey
  foreign key (workspace_id, record_comment_id, recipient_user_id)
  references record_comment_mentions(workspace_id, record_comment_id, mentioned_user_id)
  on delete restrict;

alter table notifications
  add constraint notifications_record_comment_mentioned_shape_check
  check (
    (event_type = 'record_comment_mentioned' and record_comment_id is not null)
    or
    (event_type <> 'record_comment_mentioned' and record_comment_id is null)
  );

create index notifications_record_comment_idx
  on notifications (workspace_id, record_comment_id)
  where record_comment_id is not null;

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
    p_workspace_id,
    p_entity_type_id,
    p_entity_record_id,
    p_body
  );

  select *
  into v_comment
  from record_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.id = v_comment_id;

  if not found then
    raise exception 'Comment creation failed';
  end if;

  select coalesce(array_agg(distinct requested.mentioned_user_id order by requested.mentioned_user_id), '{}'::uuid[])
  into v_mentioned_user_ids
  from unnest(coalesce(p_mentioned_user_ids, '{}'::uuid[])) as requested(mentioned_user_id)
  where requested.mentioned_user_id is not null;

  v_requested_count := coalesce(array_length(v_mentioned_user_ids, 1), 0);

  if v_requested_count = 0 then
    return v_comment_id;
  end if;

  select count(*)::integer
  into v_valid_count
  from workspace_memberships membership
  where membership.workspace_id = p_workspace_id
    and membership.deactivated_at is null
    and membership.user_id = any(v_mentioned_user_ids);

  if v_valid_count <> v_requested_count then
    raise exception 'Mention recipients must be active workspace members';
  end if;

  insert into record_comment_mentions (
    workspace_id,
    record_comment_id,
    mentioned_user_id
  )
  select
    p_workspace_id,
    v_comment_id,
    mentioned.mentioned_user_id
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
    insert into notifications (
      id,
      workspace_id,
      recipient_user_id,
      event_type,
      record_comment_id,
      entity_type_id,
      entity_record_id,
      title,
      destination_href,
      dedup_key
    )
    values (
      gen_random_uuid(),
      p_workspace_id,
      v_mentioned_user_id,
      'record_comment_mentioned',
      v_comment_id,
      p_entity_type_id,
      p_entity_record_id,
      v_comment.author_label || ' mentioned you',
      '/entities/' || p_entity_type_id::text || '/records/' || p_entity_record_id::text || '#comment-' || v_comment_id::text,
      'record_comment_mention:' || v_comment_id::text || ':' || v_mentioned_user_id::text
    )
    on conflict (workspace_id, dedup_key) do nothing;
  end loop;

  return v_comment_id;
end;
$$;

revoke all on function create_record_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[]) from public, anon;
grant execute on function create_record_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[]) to authenticated, service_role;

comment on table record_comment_mentions
  is 'Durable stable-user mention identities for record comments. Mention text in the plain comment body is presentation only.';

comment on function create_record_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[])
  is 'Creates a record comment and, atomically, durable mentions plus one notification per distinct non-self active workspace recipient.';
