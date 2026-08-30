-- Phase 8E.1: workspace member/invitation lifecycle. No invite flow existed
-- before this migration -- memberships were created entirely by manual SQL
-- (see supabase/README.md). Adds invitations (shareable link, no email
-- delivery), soft member deactivation (never hard delete, preserving every
-- historical FK reference the way this codebase already treats every other
-- entity), and extends the existing last-admin guard and assignee-picker
-- read to respect deactivation.

-- 1. Deactivation. Soft state, mirroring entity_types.archived_at /
-- entity_records.archived_at / process_templates.archived_at everywhere
-- else in this codebase -- a deactivated membership is never deleted, so
-- process assignments, approval decisions, notifications, and
-- workspace_events all keep resolving exactly as they do today.
alter table workspace_memberships add column if not exists deactivated_at timestamptz;

-- 2. The two foundational authorization primitives every RLS policy and
-- capability check in this codebase is built on. Updating these two
-- functions is the entire DB-level enforcement boundary for deactivation --
-- every downstream RLS policy and _authorized wrapper calls one of these,
-- so nothing else needs to change to make deactivation actually cut off
-- access, not just hide it in the UI.
create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_memberships membership
    where membership.workspace_id = p_workspace_id
      and membership.user_id = (select auth.uid())
      and membership.deactivated_at is null
  )
$$;

create or replace function private.has_workspace_capability(p_workspace_id uuid, p_capability text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_memberships membership
    join public.workspace_role_capabilities capability
      on capability.workspace_id = membership.workspace_id and capability.role_id = membership.role_id
    where membership.workspace_id = p_workspace_id
      and membership.user_id = (select auth.uid())
      and membership.deactivated_at is null
      and capability.capability = p_capability
  )
$$;

-- 3. The existing last-admin guard (0049): a deactivated member must not
-- count toward "the workspace still has someone who can manage members and
-- roles", or deactivating the workspace's only qualifying admin would
-- silently lock the workspace out of its own governance.
create or replace function private.assert_workspace_administrator(p_workspace_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$ begin
  if not exists (
    select 1 from workspace_memberships membership
    where membership.workspace_id = p_workspace_id
      and membership.deactivated_at is null
      and exists (select 1 from workspace_role_capabilities c where c.workspace_id = p_workspace_id and c.role_id = membership.role_id and c.capability = 'workspace.manage_members')
      and exists (select 1 from workspace_role_capabilities c where c.workspace_id = p_workspace_id and c.role_id = membership.role_id and c.capability = 'workspace.manage_roles')
  ) then raise exception 'A workspace must retain a member able to manage members and roles'; end if;
end; $$;

-- 4. Assignee picker (0028): a deactivated member must never be offered as
-- a new assignment target. Existing assignments made before deactivation
-- are untouched -- 8E.3's Workspace Health is where "stale active
-- assignment to a deactivated member" becomes a flaggable, previewable
-- finding, not something this migration auto-remediates.
create or replace function list_workspace_member_identities_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select membership.user_id, au.email::text
  from public.workspace_memberships membership
  join auth.users au on au.id = membership.user_id
  where membership.workspace_id = p_workspace_id
    and membership.deactivated_at is null
  order by au.email;
end;
$$;

-- 5. Member list (0053): deliberately keeps showing deactivated members
-- (with their status) rather than hiding them -- an admin needs to see who
-- is deactivated in order to reactivate them. Adding the deactivated_at
-- output column changes the function's row type, which `create or replace`
-- cannot do in place -- the existing function must be dropped first.
drop function if exists list_workspace_members_with_roles_authorized(uuid);

create function list_workspace_members_with_roles_authorized(p_workspace_id uuid)
returns table (user_id uuid, email text, role_id uuid, role_name text, deactivated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if not private.has_workspace_capability(p_workspace_id, 'workspace.manage_members') then raise exception 'Permission denied: workspace.manage_members'; end if;

  return query
  select membership.user_id, users.email::text, membership.role_id, role.name, membership.deactivated_at
  from public.workspace_memberships membership
  join auth.users users on users.id = membership.user_id
  join public.workspace_roles role on role.workspace_id = membership.workspace_id and role.id = membership.role_id
  where membership.workspace_id = p_workspace_id
  order by (membership.deactivated_at is not null), users.email, membership.user_id;
end;
$$;

revoke all on function list_workspace_members_with_roles_authorized(uuid) from public, anon;
grant execute on function list_workspace_members_with_roles_authorized(uuid) to authenticated, service_role;

-- 6. Deactivate / reactivate. Self-deactivation is blocked outright, not
-- merely UI-discouraged the way self-role-downgrade is (0050): deactivating
-- yourself would immediately strip workspace.manage_members from your own
-- session mid-transaction, an unrecoverable self-lockout in a way a role
-- downgrade -- which the last-admin guard still catches -- is not. The
-- workspace-serialized advisory lock and final-state guard both match
-- set_workspace_member_role_authorized's established shape exactly.
create or replace function deactivate_workspace_member_authorized(p_workspace_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');
  if p_user_id = auth.uid() then raise exception 'You cannot deactivate your own membership'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  update workspace_memberships
  set deactivated_at = now()
  where workspace_id = p_workspace_id and user_id = p_user_id and deactivated_at is null;
  if not found then raise exception 'Workspace member not found or already deactivated'; end if;
  perform private.assert_workspace_administrator(p_workspace_id);
end;
$$;

create or replace function reactivate_workspace_member_authorized(p_workspace_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');
  update workspace_memberships
  set deactivated_at = null
  where workspace_id = p_workspace_id and user_id = p_user_id and deactivated_at is not null;
  if not found then raise exception 'Workspace member not found or already active'; end if;
end;
$$;

revoke all on function deactivate_workspace_member_authorized(uuid, uuid), reactivate_workspace_member_authorized(uuid, uuid) from public, anon;
grant execute on function deactivate_workspace_member_authorized(uuid, uuid), reactivate_workspace_member_authorized(uuid, uuid) to authenticated, service_role;

-- 7. Invitations. A shareable link the inviting admin sends themselves (no
-- email delivery in v1, deliberately -- this app has no email provider).
-- `token` is the sole bearer credential; a real, random uuid is
-- unguessable. status stays 'pending' until explicitly accepted/cancelled
-- -- "expired" is a plain time comparison at read/accept time, not a
-- separate status a background job needs to flip.
create table workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role_id uuid not null,
  invited_by_user_id uuid not null,
  token uuid not null default gen_random_uuid(),
  status text not null check (status in ('pending', 'accepted', 'cancelled')) default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  cancelled_at timestamptz,

  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),

  foreign key (workspace_id, role_id) references workspace_roles(workspace_id, id) on delete restrict
);

-- At most one pending invitation per email per workspace -- resend/cancel
-- are how an admin manages an existing one, rather than accumulating
-- parallel invitations for the same address.
create unique index workspace_invitations_pending_email_idx
  on workspace_invitations (workspace_id, lower(email))
  where status = 'pending';

-- Token lookup (get_invitation_by_token, accept) needs to find a row
-- without already knowing its workspace_id.
create unique index workspace_invitations_token_idx on workspace_invitations (token);

create index workspace_invitations_workspace_idx on workspace_invitations (workspace_id, created_at desc);

-- Closed, matching the notifications/workspace_events posture: sensitive
-- (email, token) and not workspace-membership-gated for the one read path
-- that must work before the visitor is a member (get_invitation_by_token,
-- below) -- everything else goes through SECURITY DEFINER RPCs, never a
-- raw table grant.
alter table workspace_invitations enable row level security;
revoke all on table workspace_invitations from public, anon, authenticated;

create or replace function create_workspace_invitation_authorized(
  p_workspace_id uuid,
  p_email text,
  p_role_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(p_email));
  v_token uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');

  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if not exists (select 1 from workspace_roles where workspace_id = p_workspace_id and id = p_role_id) then
    raise exception 'Role not found';
  end if;
  if exists (
    select 1 from workspace_memberships m join auth.users u on u.id = m.user_id
    where m.workspace_id = p_workspace_id and lower(u.email) = v_email and m.deactivated_at is null
  ) then
    raise exception 'This email already belongs to an active member of this workspace';
  end if;
  if exists (
    select 1 from workspace_invitations where workspace_id = p_workspace_id and lower(email) = v_email and status = 'pending'
  ) then
    raise exception 'An invitation is already pending for this email -- resend or cancel it instead';
  end if;

  insert into workspace_invitations (id, workspace_id, email, role_id, invited_by_user_id)
  values (gen_random_uuid(), p_workspace_id, v_email, p_role_id, auth.uid())
  returning token into v_token;

  return v_token;
end;
$$;

create or replace function resend_workspace_invitation_authorized(
  p_workspace_id uuid,
  p_invitation_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');

  update workspace_invitations
  set token = gen_random_uuid(), expires_at = now() + interval '14 days'
  where workspace_id = p_workspace_id and id = p_invitation_id and status = 'pending'
  returning token into v_token;

  if v_token is null then raise exception 'Pending invitation not found'; end if;
  return v_token;
end;
$$;

create or replace function cancel_workspace_invitation_authorized(
  p_workspace_id uuid,
  p_invitation_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');

  update workspace_invitations
  set status = 'cancelled', cancelled_at = now()
  where workspace_id = p_workspace_id and id = p_invitation_id and status = 'pending';

  if not found then raise exception 'Pending invitation not found'; end if;
end;
$$;

create or replace function list_workspace_invitations_authorized(p_workspace_id uuid)
returns table (
  id uuid,
  email text,
  role_id uuid,
  role_name text,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  token uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');

  return query
  select inv.id, inv.email, inv.role_id, role.name, inv.status, inv.created_at, inv.expires_at, inv.token
  from workspace_invitations inv
  join workspace_roles role on role.workspace_id = inv.workspace_id and role.id = inv.role_id
  where inv.workspace_id = p_workspace_id
  order by (inv.status = 'pending') desc, inv.created_at desc;
end;
$$;

revoke all on function create_workspace_invitation_authorized(uuid, text, uuid), resend_workspace_invitation_authorized(uuid, uuid), cancel_workspace_invitation_authorized(uuid, uuid), list_workspace_invitations_authorized(uuid) from public, anon;
grant execute on function create_workspace_invitation_authorized(uuid, text, uuid), resend_workspace_invitation_authorized(uuid, uuid), cancel_workspace_invitation_authorized(uuid, uuid), list_workspace_invitations_authorized(uuid) to authenticated, service_role;

-- 8. Public token lookup -- deliberately the one narrow exception to "no
-- raw/broad access to workspace_invitations": a visitor following an
-- invitation link is by definition not yet a workspace member, so this
-- cannot be gated on membership. Returns only what the accept page needs to
-- render (workspace/role names, the invited email, status, expiry, and
-- whether that email already has a Kinema account elsewhere) -- never the
-- token itself back out, never other invitations, never anything stored
-- about who invited them.
create or replace function get_invitation_by_token(p_token uuid)
returns table (
  workspace_id uuid,
  workspace_name text,
  role_name text,
  email text,
  status text,
  expires_at timestamptz,
  email_has_account boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select
    inv.workspace_id,
    w.name,
    role.name,
    inv.email,
    inv.status,
    inv.expires_at,
    exists (select 1 from auth.users u where lower(u.email) = inv.email)
  from workspace_invitations inv
  join workspaces w on w.id = inv.workspace_id
  join workspace_roles role on role.workspace_id = inv.workspace_id and role.id = inv.role_id
  where inv.token = p_token;
end;
$$;

revoke all on function get_invitation_by_token(uuid) from public;
grant execute on function get_invitation_by_token(uuid) to anon, authenticated, service_role;

-- 9. Accept. Requires a real authenticated session whose email matches the
-- invitation (case-insensitive) -- the token identifies *which*
-- invitation, the session's own verified email is what actually
-- authorizes accepting it, so a leaked/forwarded link cannot be redeemed
-- under a different identity. ON CONFLICT DO UPDATE handles the
-- previously-deactivated-member case (re-invited into the same workspace)
-- as a clean reactivation-with-possibly-new-role rather than colliding on
-- the (workspace_id, user_id) primary key. Idempotent: accepting an
-- already-accepted invitation while already a member simply no-ops rather
-- than erroring, so re-visiting a stale link/double-click is harmless.
create or replace function accept_workspace_invitation_authorized(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation workspace_invitations%rowtype;
  v_caller_email text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;

  select * into v_invitation from workspace_invitations where token = p_token for update;
  if not found then raise exception 'Invitation not found'; end if;

  select email into v_caller_email from auth.users where id = auth.uid();
  if v_caller_email is null or lower(v_caller_email) <> v_invitation.email then
    raise exception 'This invitation was sent to a different email address';
  end if;

  if v_invitation.status = 'accepted' then
    return v_invitation.workspace_id;
  end if;
  if v_invitation.status = 'cancelled' then raise exception 'This invitation has been cancelled'; end if;
  if v_invitation.expires_at <= now() then raise exception 'This invitation has expired'; end if;

  insert into workspace_memberships (workspace_id, user_id, role_id)
  values (v_invitation.workspace_id, auth.uid(), v_invitation.role_id)
  on conflict (workspace_id, user_id) do update
    set role_id = excluded.role_id, deactivated_at = null;

  update workspace_invitations
  set status = 'accepted', accepted_at = now()
  where id = v_invitation.id;

  return v_invitation.workspace_id;
end;
$$;

revoke all on function accept_workspace_invitation_authorized(uuid) from public, anon;
grant execute on function accept_workspace_invitation_authorized(uuid) to authenticated, service_role;
