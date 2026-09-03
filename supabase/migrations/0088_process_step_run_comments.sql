-- Phase 10.3: durable human discussion on process step runs.
--
-- Process step discussion deliberately uses a dedicated table rather than
-- polymorphizing record_comments. The target is the stable process_step_runs
-- identity for human-operable work surfaces only: human_task and approval.
-- workspace_events remains deterministic system/process Activity; comments
-- are human-authored collaboration and are tombstoned, never product-deleted.

create table process_step_run_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_run_id uuid not null,
  process_step_run_id uuid not null,
  body text not null,
  author_user_id uuid not null,
  author_label text not null,
  real_actor_user_id uuid,
  real_actor_label text,
  created_at timestamptz not null default now(),
  tombstoned_at timestamptz,
  tombstoned_by_user_id uuid,
  tombstoned_by_label text,
  tombstoned_by_real_actor_user_id uuid,
  tombstoned_by_real_actor_label text,

  foreign key (workspace_id, process_run_id)
    references process_runs(workspace_id, id)
    on delete restrict,
  foreign key (workspace_id, process_run_id, process_step_run_id)
    references process_step_runs(workspace_id, process_run_id, id)
    on delete restrict,

  check (body = regexp_replace(body, '^[[:space:]]+|[[:space:]]+$', '', 'g') and char_length(body) between 1 and 4000),
  check (nullif(btrim(author_label), '') is not null),
  check (
    (real_actor_user_id is null and real_actor_label is null)
    or (real_actor_user_id is not null and nullif(btrim(real_actor_label), '') is not null)
  ),
  check (
    (tombstoned_at is null and tombstoned_by_user_id is null and tombstoned_by_label is null
      and tombstoned_by_real_actor_user_id is null and tombstoned_by_real_actor_label is null)
    or (tombstoned_at is not null and tombstoned_by_user_id is not null
      and nullif(btrim(tombstoned_by_label), '') is not null)
  ),
  check (
    (tombstoned_by_real_actor_user_id is null and tombstoned_by_real_actor_label is null)
    or (
      tombstoned_by_real_actor_user_id is not null
      and nullif(btrim(tombstoned_by_real_actor_label), '') is not null
    )
  )
);

alter table process_step_run_comments
  add constraint process_step_run_comments_workspace_id_id_key unique (workspace_id, id);

create index process_step_run_comments_step_created_idx
  on process_step_run_comments (workspace_id, process_run_id, process_step_run_id, created_at, id);

create index process_step_run_comments_workspace_author_idx
  on process_step_run_comments (workspace_id, author_user_id, created_at desc);

alter table process_step_run_comments enable row level security;
revoke all on table process_step_run_comments from public, anon, authenticated;

create table process_step_run_comment_mentions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_step_run_comment_id uuid not null,
  mentioned_user_id uuid not null,
  created_at timestamptz not null default now(),

  unique (workspace_id, process_step_run_comment_id, mentioned_user_id),
  foreign key (workspace_id, process_step_run_comment_id)
    references process_step_run_comments(workspace_id, id) on delete cascade,
  foreign key (workspace_id, mentioned_user_id)
    references workspace_memberships(workspace_id, user_id) on delete restrict
);

create index process_step_run_comment_mentions_recipient_idx
  on process_step_run_comment_mentions (workspace_id, mentioned_user_id, created_at desc);

create index process_step_run_comment_mentions_comment_idx
  on process_step_run_comment_mentions (workspace_id, process_step_run_comment_id);

alter table process_step_run_comment_mentions enable row level security;
revoke all on table process_step_run_comment_mentions from public, anon, authenticated;

alter table notifications
  add column process_step_run_comment_id uuid;

alter table notifications
  drop constraint if exists notifications_event_type_check;

alter table notifications
  add constraint notifications_event_type_check
  check (event_type in (
    'step_assigned',
    'step_due_soon',
    'step_overdue',
    'record_comment_mentioned',
    'process_step_run_comment_mentioned'
  ));

alter table notifications
  drop constraint if exists notifications_record_comment_mentioned_shape_check;

alter table notifications
  add constraint notifications_comment_mention_shape_check
  check (
    (
      event_type = 'record_comment_mentioned'
      and record_comment_id is not null
      and process_step_run_comment_id is null
    )
    or
    (
      event_type = 'process_step_run_comment_mentioned'
      and process_step_run_comment_id is not null
      and record_comment_id is null
    )
    or
    (
      event_type not in ('record_comment_mentioned', 'process_step_run_comment_mentioned')
      and record_comment_id is null
      and process_step_run_comment_id is null
    )
  );

alter table notifications
  add constraint notifications_process_step_run_comment_mention_fkey
  foreign key (workspace_id, process_step_run_comment_id, recipient_user_id)
  references process_step_run_comment_mentions(workspace_id, process_step_run_comment_id, mentioned_user_id)
  on delete restrict;

create index notifications_process_step_run_comment_idx
  on notifications (workspace_id, process_step_run_comment_id)
  where process_step_run_comment_id is not null;

create function list_process_step_run_comments_authorized(
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
    comment.id,
    comment.workspace_id,
    comment.process_run_id,
    comment.process_step_run_id,
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
  from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.process_run_id = p_process_run_id
    and comment.process_step_run_id = p_process_step_run_id
  order by comment.created_at asc, comment.id asc
  limit p_limit;
end;
$$;

create function create_process_step_run_comment_with_mentions_authorized(
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
  v_real_actor_user_id uuid := case
    when auth.uid() is not null and auth.uid() <> private.current_effective_user(p_workspace_id)
      then auth.uid()
    else null
  end;
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

  if v_author_user_id is null then
    raise exception 'Comment author is required';
  end if;

  if v_body = '' then
    raise exception 'Comment body is required';
  end if;

  if char_length(v_body) > 4000 then
    raise exception 'Comment body must be 4000 characters or fewer';
  end if;

  select *
  into v_run
  from process_runs run
  where run.workspace_id = p_workspace_id
    and run.id = p_process_run_id;

  if not found then
    raise exception 'Process run not found';
  end if;

  select *
  into v_step
  from process_step_runs step
  where step.workspace_id = p_workspace_id
    and step.process_run_id = p_process_run_id
    and step.id = p_process_step_run_id
    and step.node_type in ('human_task', 'approval')
    and step.status in ('active', 'completed');

  if not found then
    raise exception 'Step not found or not open for discussion';
  end if;

  if not exists (
    select 1
    from entity_records record
    where record.workspace_id = p_workspace_id
      and record.entity_type_id = v_run.origin_entity_type_id
      and record.id = v_run.origin_record_id
      and record.archived_at is null
  ) then
    raise exception 'Origin record not found or archived';
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

  insert into process_step_run_comments (
    id,
    workspace_id,
    process_run_id,
    process_step_run_id,
    body,
    author_user_id,
    author_label,
    real_actor_user_id,
    real_actor_label
  )
  values (
    v_comment_id,
    p_workspace_id,
    p_process_run_id,
    p_process_step_run_id,
    v_body,
    v_author_user_id,
    v_author_label,
    v_real_actor_user_id,
    v_real_actor_label
  );

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

  insert into process_step_run_comment_mentions (
    workspace_id,
    process_step_run_comment_id,
    mentioned_user_id
  )
  select
    p_workspace_id,
    v_comment_id,
    mentioned.mentioned_user_id
  from unnest(v_mentioned_user_ids) as mentioned(mentioned_user_id)
  on conflict (workspace_id, process_step_run_comment_id, mentioned_user_id) do nothing;

  for v_mentioned_user_id in
    select mention.mentioned_user_id
    from process_step_run_comment_mentions mention
    where mention.workspace_id = p_workspace_id
      and mention.process_step_run_comment_id = v_comment_id
      and mention.mentioned_user_id <> v_author_user_id
    order by mention.mentioned_user_id
  loop
    insert into notifications (
      id,
      workspace_id,
      recipient_user_id,
      event_type,
      process_run_id,
      process_step_run_id,
      process_step_run_comment_id,
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
      'process_step_run_comment_mentioned',
      p_process_run_id,
      p_process_step_run_id,
      v_comment_id,
      v_run.origin_entity_type_id,
      v_run.origin_record_id,
      v_author_label || ' mentioned you in a process step',
      '/process-runs/' || p_process_run_id::text || '#step-comment-' || v_comment_id::text,
      'process_step_run_comment_mention:' || v_comment_id::text || ':' || v_mentioned_user_id::text
    )
    on conflict (workspace_id, dedup_key) do nothing;
  end loop;

  return v_comment_id;
end;
$$;

create function tombstone_process_step_run_comment_authorized(
  p_workspace_id uuid,
  p_comment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment process_step_run_comments%rowtype;
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
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'processes.operate');

  if v_deleter_user_id is null then
    raise exception 'Comment deleter is required';
  end if;

  select *
  into v_comment
  from process_step_run_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.id = p_comment_id
  for update;

  if not found then
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

  update process_step_run_comments
  set tombstoned_at = now(),
      tombstoned_by_user_id = v_deleter_user_id,
      tombstoned_by_label = v_deleter_label,
      tombstoned_by_real_actor_user_id = v_real_deleter_user_id,
      tombstoned_by_real_actor_label = v_real_deleter_label
  where workspace_id = p_workspace_id
    and id = p_comment_id;
end;
$$;

revoke all on function list_process_step_run_comments_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_process_step_run_comments_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;

revoke all on function create_process_step_run_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[]) from public, anon;
grant execute on function create_process_step_run_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[]) to authenticated, service_role;

revoke all on function tombstone_process_step_run_comment_authorized(uuid, uuid) from public, anon;
grant execute on function tombstone_process_step_run_comment_authorized(uuid, uuid) to authenticated, service_role;

comment on table process_step_run_comments
  is 'Durable, process-step-scoped human discussion for human_task and approval step runs. Comments are separate from system Activity and tombstoned, never physically deleted through product paths.';

comment on table process_step_run_comment_mentions
  is 'Durable stable-user mention identities for process step run comments. Mention text in the plain comment body is presentation only.';

comment on function list_process_step_run_comments_authorized(uuid, uuid, uuid, integer)
  is 'Membership-checked oldest-first read of durable human comments for one human-operable process step run.';

comment on function create_process_step_run_comment_with_mentions_authorized(uuid, uuid, uuid, text, uuid[])
  is 'Creates a plain-text process step run comment and, atomically, durable mentions plus one notification per distinct non-self active workspace recipient.';

comment on function tombstone_process_step_run_comment_authorized(uuid, uuid)
  is 'Tombstones a process step run comment without modifying its body. The effective author may remove their own comment; effective workspace administrators may remove any comment.';
