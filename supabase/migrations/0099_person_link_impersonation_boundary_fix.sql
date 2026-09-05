-- Corrective migration for 0097. Applied migrations are immutable -- 0097
-- and 0098 are both untouched by this file.
--
-- Defect found by focused Phase 12.1 verification: set_person_entity_type_
-- authorized, set_person_link_authorized, and remove_person_link_
-- authorized each gate on private.require_interactive_workspace_
-- capability(...), which evaluates the capability against auth.uid() (the
-- real actor) rather than private.current_effective_user(...) -- correct
-- for "whose permission counts," but that alone does not reject the call
-- merely because an impersonation session happens to be concurrently
-- active. A real admin who holds workspace.manage_members/schema.manage
-- could therefore still create, change, or remove an identity link (or
-- change the Person-type designation) *while* impersonating someone else
-- -- confirmed empirically: "rejects linking while the caller is
-- impersonating another member" failed, the link silently succeeded.
--
-- This is the exact same class of gap Phase 11.3's administrative-
-- reassignment RPC deliberately closed with an explicit, first-statement
-- impersonation-session check -- that check was designed for here too (per
-- the approved 12.1 plan's "governance actions remain outside
-- impersonation/effective-user authority") but was never actually written
-- into the SQL. Fix: add the identical explicit check -- reject if the
-- real actor (auth.uid()) has any open impersonation_sessions row for the
-- workspace -- as the first statement in all three functions, before any
-- capability check, matching reassign_process_step_run_administrative_
-- authorized (0095) verbatim in shape. No signature or return-type change,
-- so create or replace is used directly; no DROP FUNCTION is needed and
-- none of the three functions' grants are affected.
--
-- Full latest bodies (0097) copied faithfully below; the only change in
-- each is the new leading impersonation check.

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
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

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
