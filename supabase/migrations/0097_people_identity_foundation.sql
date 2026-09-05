-- Phase 12.1: People Identity Foundation.
--
-- Lets a workspace designate exactly one EntityType as its "Person" type and
-- explicitly, durably link an eligible Person EntityRecord 1:1 to a
-- workspace member identity -- the missing primitive the Phase 12
-- investigation identified. Deliberately narrow: no sensitive-record
-- visibility model (12.2), no Quality Review/Goal/Performance Cycle
-- objects, no performance/trend UX. workspace_memberships itself is not
-- turned into an extensible business-object table -- this is a thin,
-- optional, one-directional bridge alongside it.
--
-- Designation: workspaces.person_entity_type_id, mirroring the existing
-- workspaces.timezone precedent (0063) -- a workspace-level singleton
-- configuration value set through its own narrow RPC
-- (set_person_entity_type_authorized), not a generic "update workspace"
-- endpoint or a new entity-type classification framework. The composite FK
-- (id, person_entity_type_id) -> entity_types(workspace_id, id) makes a
-- cross-workspace designation structurally impossible; `on delete set
-- null` is safe because entity_type deletion is already blocked the
-- instant any record of that type exists (delete_entity_type_if_safe,
-- 0007), so the only entity type that could ever be deleted while still
-- designated is one with zero records -- and therefore zero possible links
-- either.
--
-- Redesignation is deliberately blocked while any link exists (approved
-- correction 1): changing or clearing person_entity_type_id while
-- entity_record_person_links has rows would strand those links -- they
-- would still occupy the unique(workspace_id, user_id) identity slot for a
-- record that is no longer the designated type, with no coherent way for
-- the Identity UI to manage them. No migration/reinterpretation semantics
-- are invented to handle that case; the builder must explicitly unlink
-- first. Setting the designation to its current value is a clean no-op,
-- skipping the link check entirely, since nothing is actually changing.
--
-- Identity link: a dedicated mapping table, not a user_id column on
-- entity_records (which would cost every non-Person entity type a
-- meaningless column). Both FKs are composite and workspace-qualified --
-- (workspace_id, entity_type_id, entity_record_id) ->
-- entity_records(workspace_id, entity_type_id, id) and (workspace_id,
-- user_id) -> workspace_memberships(workspace_id, user_id) -- so a
-- cross-workspace link is structurally impossible, not merely
-- RPC-validated. `primary key (workspace_id, entity_record_id)` plus
-- `unique (workspace_id, user_id)` make the 1:1 mapping structural on both
-- sides and serve as the race backstop for concurrent linking attempts
-- (approved correction 2) -- no advisory lock is introduced, since the
-- unique constraints alone already guarantee at most one of two racing
-- inserts can succeed.
--
-- set_person_link_authorized is deliberately not an upsert (approved
-- correction 2): if either the record or the target member already has a
-- link, it is rejected outright rather than silently replacing the prior
-- mapping. Identity linkage may become authorization-relevant in 12.2, so
-- changing it must always be an explicit, visible act -- unlink, then
-- link. No dedicated "relink" RPC is added; explicit unlink -> link is
-- sufficient.
--
-- Both link/unlink RPCs and the designation RPC use
-- private.require_interactive_workspace_capability directly (the same
-- auth.uid()-based, non-effective-user helper set_workspace_timezone_
-- authorized already uses for workspace.manage_settings) rather than any
-- current_effective_user path -- workspace.manage_members and
-- schema.manage stay real-actor-only governance actions, never reachable
-- through impersonation, exactly as approved.
--
-- Link/unlink each record a durable workspace_events row (person_linked /
-- person_unlinked) -- not optional, per approved correction 3. actor_user_id
-- is always auth.uid() (there is no effective/real distinction possible
-- here, since the capability check itself is real-actor-only); real_actor_
-- user_id is left unpopulated, mirroring impersonation_started/
-- impersonation_ended's own real-actor-only event shape (0068), which also
-- never populates that column. Surfacing these events through
-- list_record_activity_authorized is deliberately deferred -- not a
-- correctness requirement for 12.1, and not worth another return-shape
-- migration on that function without a concrete need.
--
-- delete_entity_record_if_unreferenced(_authorized): faithfully copied in
-- full from its latest bodies (0085_record_comments.sql), widened with one
-- new check (approved correction 4) -- an active entity_record_person_links
-- row now counts as a real reference, exactly like an incoming relation, an
-- originating process run, or a durable comment. This does not lean on
-- `on delete cascade` for correctness: the link table's FK to entity_records
-- keeps `on delete cascade` purely as a teardown backstop (full workspace/
-- account deletion), never as the mechanism that makes deleting a linked
-- Person record "safe."

alter table workspaces add column if not exists person_entity_type_id uuid;

alter table workspaces
  drop constraint if exists workspaces_person_entity_type_fk;
alter table workspaces
  add constraint workspaces_person_entity_type_fk
  foreign key (id, person_entity_type_id)
  references entity_types (workspace_id, id)
  on delete set null;

create table if not exists entity_record_person_links (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type_id uuid not null,
  entity_record_id uuid not null,
  user_id uuid not null,
  linked_by_user_id uuid,
  created_at timestamptz not null default now(),

  primary key (workspace_id, entity_record_id),
  unique (workspace_id, user_id),

  foreign key (workspace_id, entity_type_id, entity_record_id)
    references entity_records (workspace_id, entity_type_id, id)
    on delete cascade,

  foreign key (workspace_id, user_id)
    references workspace_memberships (workspace_id, user_id)
    on delete cascade
);

alter table entity_record_person_links enable row level security;

drop policy if exists entity_record_person_links_member_read on entity_record_person_links;
create policy entity_record_person_links_member_read
  on entity_record_person_links for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));

revoke all on table entity_record_person_links from public, anon, authenticated;
grant select on table entity_record_person_links to authenticated;

-- Designation RPC. Mirrors set_workspace_timezone_authorized (0063)
-- exactly in shape: schema.manage, a single-column workspace update, no
-- effective-user awareness.
create or replace function set_person_entity_type_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_entity_type_id uuid;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  select person_entity_type_id into v_current_entity_type_id
  from workspaces
  where id = p_workspace_id;

  if v_current_entity_type_id is not distinct from p_entity_type_id then
    return;
  end if;

  if exists (
    select 1 from entity_record_person_links where workspace_id = p_workspace_id
  ) then
    raise exception 'Cannot change the Person type while identity links exist. Remove all links first.';
  end if;

  if p_entity_type_id is not null then
    if not exists (
      select 1 from entity_types
      where workspace_id = p_workspace_id
        and id = p_entity_type_id
        and archived_at is null
    ) then
      raise exception 'Entity type not found or archived';
    end if;
  end if;

  update workspaces
  set person_entity_type_id = p_entity_type_id, updated_at = now()
  where id = p_workspace_id;
end;
$$;

revoke all on function set_person_entity_type_authorized(uuid, uuid) from public, anon, authenticated;
grant execute on function set_person_entity_type_authorized(uuid, uuid) to authenticated, service_role;

-- Link RPC. Not an upsert (see migration header, correction 2) -- rejects
-- outright if either side already has a link. Unique constraints on
-- entity_record_person_links are the structural race backstop; no
-- advisory lock is introduced.
create or replace function set_person_link_authorized(
  p_workspace_id uuid,
  p_entity_record_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_person_entity_type_id uuid;
  v_record entity_records%rowtype;
  v_linked_email text;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'workspace.manage_members');

  select person_entity_type_id into v_person_entity_type_id
  from workspaces
  where id = p_workspace_id;
  if v_person_entity_type_id is null then
    raise exception 'No Person type is designated for this workspace';
  end if;

  select * into v_record
  from entity_records
  where workspace_id = p_workspace_id and id = p_entity_record_id;
  if not found then
    raise exception 'Record not found';
  end if;
  if v_record.entity_type_id <> v_person_entity_type_id then
    raise exception 'This record is not a Person record';
  end if;
  if v_record.archived_at is not null then
    raise exception 'Cannot link an archived record';
  end if;

  if not exists (
    select 1 from workspace_memberships
    where workspace_id = p_workspace_id and user_id = p_user_id and deactivated_at is null
  ) then
    raise exception 'Target is not a current member of this workspace';
  end if;

  if exists (
    select 1 from entity_record_person_links
    where workspace_id = p_workspace_id and entity_record_id = p_entity_record_id
  ) then
    raise exception 'This record is already linked to a workspace member';
  end if;

  if exists (
    select 1 from entity_record_person_links
    where workspace_id = p_workspace_id and user_id = p_user_id
  ) then
    raise exception 'This workspace member is already linked to a record';
  end if;

  select email::text into v_linked_email from auth.users where id = p_user_id;

  insert into entity_record_person_links (
    workspace_id, entity_type_id, entity_record_id, user_id, linked_by_user_id
  ) values (
    p_workspace_id, v_person_entity_type_id, p_entity_record_id, p_user_id, auth.uid()
  );

  insert into workspace_events (
    id, workspace_id, actor_user_id, event_type, entity_type_id, entity_record_id, metadata
  ) values (
    gen_random_uuid(), p_workspace_id, auth.uid(), 'person_linked',
    v_person_entity_type_id, p_entity_record_id,
    jsonb_build_object('linked_user_id', p_user_id, 'linked_email', v_linked_email)
  );
end;
$$;

revoke all on function set_person_link_authorized(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function set_person_link_authorized(uuid, uuid, uuid) to authenticated, service_role;

-- Unlink RPC. The only way to change an existing mapping is unlink, then a
-- separate set_person_link_authorized call.
create or replace function remove_person_link_authorized(
  p_workspace_id uuid,
  p_entity_record_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link entity_record_person_links%rowtype;
  v_unlinked_email text;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'workspace.manage_members');

  select * into v_link
  from entity_record_person_links
  where workspace_id = p_workspace_id and entity_record_id = p_entity_record_id;
  if not found then
    raise exception 'This record is not currently linked';
  end if;

  select email::text into v_unlinked_email from auth.users where id = v_link.user_id;

  delete from entity_record_person_links
  where workspace_id = p_workspace_id and entity_record_id = p_entity_record_id;

  insert into workspace_events (
    id, workspace_id, actor_user_id, event_type, entity_type_id, entity_record_id, metadata
  ) values (
    gen_random_uuid(), p_workspace_id, auth.uid(), 'person_unlinked',
    v_link.entity_type_id, p_entity_record_id,
    jsonb_build_object('unlinked_user_id', v_link.user_id, 'unlinked_email', v_unlinked_email)
  );
end;
$$;

revoke all on function remove_person_link_authorized(uuid, uuid) from public, anon, authenticated;
grant execute on function remove_person_link_authorized(uuid, uuid) to authenticated, service_role;

-- Widen workspace_events.event_type for the two new durable event types.
alter table workspace_events
  drop constraint if exists workspace_events_event_type_check;
alter table workspace_events
  add constraint workspace_events_event_type_check
  check (event_type in (
    'step_assigned', 'step_due_soon', 'step_overdue', 'recurrence_started_process',
    'process_started', 'process_completed', 'approval_decided',
    'impersonation_started', 'impersonation_ended',
    'process_cancelled', 'step_reassigned',
    'person_linked', 'person_unlinked'
  ));

-- delete_entity_record_if_unreferenced(_authorized): full latest bodies
-- (0085_record_comments.sql) copied faithfully, widened with one new
-- reference check (approved correction 4). Return shape changes, so both
-- functions are dropped and recreated exactly like 0085 did for the prior
-- shape change.
drop function if exists delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid);
drop function if exists delete_entity_record_if_unreferenced(uuid, uuid, uuid);

create function delete_entity_record_if_unreferenced(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns table (
  deleted boolean,
  reference_count integer,
  process_run_count integer,
  comment_count integer,
  person_link_count integer
)
language plpgsql
set search_path = public
as $$
declare
  v_reference_count integer := 0;
  v_process_run_count integer := 0;
  v_comment_count integer := 0;
  v_person_link_count integer := 0;
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

  select count(*)
    into v_person_link_count
  from entity_record_person_links
  where workspace_id = p_workspace_id
    and entity_record_id = p_record_id;

  if v_reference_count > 0 or v_process_run_count > 0 or v_comment_count > 0 or v_person_link_count > 0 then
    return query select false, v_reference_count, v_process_run_count, v_comment_count, v_person_link_count;
    return;
  end if;

  delete from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  return query select true, 0, 0, 0, 0;
end;
$$;

create function delete_entity_record_if_unreferenced_authorized(
  p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid
)
returns table (
  deleted boolean, reference_count integer, process_run_count integer,
  comment_count integer, person_link_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');
  return query select * from delete_entity_record_if_unreferenced(p_workspace_id, p_entity_type_id, p_record_id);
end;
$$;

revoke all on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) from public, authenticated;
grant execute on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) to service_role;

revoke all on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function delete_entity_record_if_unreferenced_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on table entity_record_person_links
  is 'Explicit, durable 1:1 bridge between a designated-Person-type EntityRecord and a workspace member (auth) identity. Optional both directions; created/removed only through set_person_link_authorized/remove_person_link_authorized. Never turns workspace_memberships itself into a configurable business-object table.';

comment on function set_person_entity_type_authorized(uuid, uuid)
  is 'Designates (or clears) the workspace''s single Person EntityType. Blocked while any entity_record_person_links row exists, to avoid stranding links across a redesignation. schema.manage, real-actor-only.';

comment on function set_person_link_authorized(uuid, uuid, uuid)
  is 'Links a Person-type EntityRecord to a current workspace member. Rejects outright (never replaces) if either side already has a link -- explicit unlink, then link, is the only way to change a mapping. workspace.manage_members, real-actor-only.';

comment on function remove_person_link_authorized(uuid, uuid)
  is 'Removes an existing Person-record identity link. workspace.manage_members, real-actor-only.';

comment on function delete_entity_record_if_unreferenced(uuid, uuid, uuid)
  is 'Safely hard-deletes a record. Blocks deletion when another record relation references it, when any process run originates from it, when any durable comment exists for it, or when it is linked to a workspace member identity.';
