-- Phase 10.1: durable record-level human discussion.
--
-- Comments are authored human discussion, not system-generated Activity.
-- They therefore live in a dedicated table rather than workspace_events.
-- workspace_events remains the closed historical system/process log; record
-- comments have their own closed table plus narrow authorized RPCs.
--
-- Current history conventions use snapshots where human attribution must stay
-- durable (process_step_runs.assignee_label, decided_by_label) and live lookup
-- only for lighter Activity presentation. Comments are durable human-authored
-- history, so this table stores both stable user ids and label snapshots.
--
-- The same-workspace FK to entity_records is structural and restrictive:
-- comments, including tombstoned comments, must block hard record deletion.
-- The safe-delete RPC below also reports that block deliberately, so callers
-- get a useful product message instead of a raw FK error.

create table record_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type_id uuid not null,
  entity_record_id uuid not null,
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

  foreign key (workspace_id, entity_type_id, entity_record_id)
    references entity_records(workspace_id, entity_type_id, id)
    on delete restrict,

  check (body = btrim(body) and char_length(body) between 1 and 4000),
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

create index record_comments_record_created_idx
  on record_comments (workspace_id, entity_type_id, entity_record_id, created_at, id);

create index record_comments_workspace_author_idx
  on record_comments (workspace_id, author_user_id, created_at desc);

alter table record_comments enable row level security;
revoke all on table record_comments from public, anon, authenticated;

create function list_record_comments_authorized(
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
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_entity_record_id
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
  from record_comments comment
  where comment.workspace_id = p_workspace_id
    and comment.entity_type_id = p_entity_type_id
    and comment.entity_record_id = p_entity_record_id
  order by comment.created_at asc, comment.id asc
  limit p_limit;
end;
$$;

create function create_record_comment_authorized(
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
  v_body text := btrim(coalesce(p_body, ''));
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

create function tombstone_record_comment_authorized(
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

-- Latest defining migration for delete_entity_record_if_unreferenced:
-- 0027_process_templates_and_runs.sql. Later migration 0068 updates only
-- the authorized wrapper for effective-user capability checks; it does not
-- change this inner function body. Body below is copied complete from 0027,
-- with the single intended behavior change: any record_comments row blocks
-- hard deletion alongside incoming relations and originating Process runs.
drop function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid);
drop function delete_entity_record_if_unreferenced(uuid, uuid, uuid);

create function delete_entity_record_if_unreferenced(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns table (
  deleted boolean,
  reference_count integer,
  process_run_count integer,
  comment_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_reference_count integer := 0;
  v_process_run_count integer := 0;
  v_comment_count integer := 0;
begin
  if not exists (
    select 1
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_record_id
  ) then
    raise exception 'Record not found';
  end if;

  select count(*)
    into v_reference_count
  from entity_record_relation_values
  where workspace_id = p_workspace_id
    and target_entity_type_id = p_entity_type_id
    and target_record_id = p_record_id;

  select count(*)
    into v_process_run_count
  from process_runs
  where workspace_id = p_workspace_id
    and origin_entity_type_id = p_entity_type_id
    and origin_record_id = p_record_id;

  select count(*)
    into v_comment_count
  from record_comments
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and entity_record_id = p_record_id;

  if v_reference_count > 0 or v_process_run_count > 0 or v_comment_count > 0 then
    return query select false, v_reference_count, v_process_run_count, v_comment_count;
    return;
  end if;

  delete from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  return query select true, 0, 0, 0;
end;
$$;

-- Latest defining migration for the authorized wrapper:
-- 0068_impersonation.sql. Body below is copied complete from 0068 and only
-- its return shape changes to match the inner safe-delete function above.
create function delete_entity_record_if_unreferenced_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid
)
returns table (deleted boolean, reference_count integer, process_run_count integer, comment_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return query select * from delete_entity_record_if_unreferenced(p_workspace_id, p_entity_type_id, p_record_id);
end;
$$;

revoke all on function list_record_comments_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_record_comments_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;

revoke all on function create_record_comment_authorized(uuid, uuid, uuid, text) from public, anon;
grant execute on function create_record_comment_authorized(uuid, uuid, uuid, text) to authenticated, service_role;

revoke all on function tombstone_record_comment_authorized(uuid, uuid) from public, anon;
grant execute on function tombstone_record_comment_authorized(uuid, uuid) to authenticated, service_role;

revoke all on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) from public, authenticated;
grant execute on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) to service_role;

revoke all on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on table record_comments
  is 'Durable, record-scoped human discussion. Comments are separate from system Activity and are tombstoned, never physically deleted through product paths.';

comment on function list_record_comments_authorized(uuid, uuid, uuid, integer)
  is 'Membership-checked oldest-first read of durable human comments for one business record.';

comment on function create_record_comment_authorized(uuid, uuid, uuid, text)
  is 'Creates a plain-text record comment as the current effective records.operate user. Body is trimmed, bounded, and rejected when empty; archived records are read-only.';

comment on function tombstone_record_comment_authorized(uuid, uuid)
  is 'Tombstones a record comment without modifying its body. The effective author may remove their own comment; effective workspace administrators may remove any comment.';

comment on function delete_entity_record_if_unreferenced(uuid, uuid, uuid)
  is 'Safely hard-deletes a record. Blocks deletion when another record relation references it, when any process run originates from it, or when any durable comment exists for it.';

comment on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid)
  is 'Effective records.operate security-definer wrapper for safe record deletion.';
