-- Phase 8F.4: Outbound Email / Provider Infrastructure.
--
-- V1 sends only workspace invitation email through one provider (Resend).
-- This is deliberately email-specific infrastructure, not a generic
-- webhook/email/push delivery framework and not a notification preference
-- system.
--
-- Key security boundary: workspace_invitations.token is a bearer secret.
-- outbound_email_deliveries must never become a second durable store of
-- invitation tokens, invitation URLs, rendered subjects, or rendered bodies.
-- Delivery rows store only references, status, recipient, and provider
-- attempt metadata. The dispatcher renders from the authoritative current
-- invitation row immediately before the external provider call.
--
-- The final pre-send gate is prepare_workspace_invitation_email_delivery_
-- system(delivery_id): service_role-only, delivery-id-only input, derives
-- workspace/invitation/generation internally, marks stale rows superseded,
-- and returns the current token plus minimal non-secret context. There is
-- still a tiny check-to-provider-call race after that final check and before/during the Resend
-- request. V1 accepts that an already-in-flight provider request cannot be
-- cancelled after a concurrent resend. Since resend rotates the token, the
-- old token is invalid after rotation; this is a UX race, not an
-- authorization leak.

-- 1. Generation identity on invitations. Existing invitation rows get a
-- generation id but no historical email delivery row, so enabling email
-- later can never unexpectedly send old manual-link invitations.
alter table workspace_invitations add column if not exists email_generation_id uuid;

update workspace_invitations
set email_generation_id = gen_random_uuid()
where email_generation_id is null;

alter table workspace_invitations alter column email_generation_id set not null;

-- 2. Email delivery ledger. No raw rendered content, no token, no URL.
create table outbound_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  purpose text not null check (purpose in ('workspace_invitation')),
  workspace_invitation_id uuid not null references workspace_invitations(id) on delete cascade,
  invitation_generation_id uuid not null,
  recipient_email text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'failed', 'superseded')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempted_at timestamptz,
  last_response_status integer,
  last_failure_summary text,
  provider text not null default 'resend' check (provider in ('resend')),
  provider_message_id text,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  failed_at timestamptz,
  superseded_at timestamptz,

  unique (workspace_id, workspace_invitation_id, invitation_generation_id)
);

create index outbound_email_deliveries_claim_idx
  on outbound_email_deliveries (next_attempt_at)
  where status = 'pending';

create index outbound_email_deliveries_workspace_created_idx
  on outbound_email_deliveries (workspace_id, created_at desc);

create index outbound_email_deliveries_invitation_idx
  on outbound_email_deliveries (workspace_id, workspace_invitation_id, created_at desc);

create trigger outbound_email_deliveries_workspace_id_immutable
  before update on outbound_email_deliveries
  for each row execute function private.reject_workspace_id_change();

alter table outbound_email_deliveries enable row level security;
revoke all on table outbound_email_deliveries from public, anon, authenticated;

-- 3. Atomic invitation create/resend plus optional email enqueue. p_enqueue_
-- email is derived by the server action from deployment email config; it is
-- not a caller-selected recipient/content/provider surface.
drop function if exists create_workspace_invitation_authorized(uuid, text, uuid);

create function create_workspace_invitation_authorized(
  p_workspace_id uuid,
  p_email text,
  p_role_id uuid,
  p_enqueue_email boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(p_email));
  v_invitation_id uuid := gen_random_uuid();
  v_token uuid;
  v_generation_id uuid := gen_random_uuid();
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

  insert into workspace_invitations (id, workspace_id, email, role_id, invited_by_user_id, email_generation_id)
  values (v_invitation_id, p_workspace_id, v_email, p_role_id, auth.uid(), v_generation_id)
  returning token into v_token;

  if coalesce(p_enqueue_email, false) then
    insert into outbound_email_deliveries (
      id, workspace_id, purpose, workspace_invitation_id, invitation_generation_id,
      recipient_email, created_by_user_id
    )
    values (
      gen_random_uuid(), p_workspace_id, 'workspace_invitation', v_invitation_id, v_generation_id,
      v_email, auth.uid()
    )
    on conflict (workspace_id, workspace_invitation_id, invitation_generation_id) do nothing;
  end if;

  return v_token;
end;
$$;

drop function if exists resend_workspace_invitation_authorized(uuid, uuid);

create function resend_workspace_invitation_authorized(
  p_workspace_id uuid,
  p_invitation_id uuid,
  p_enqueue_email boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid;
  v_generation_id uuid := gen_random_uuid();
  v_invitation workspace_invitations%rowtype;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');

  update workspace_invitations
  set token = gen_random_uuid(),
      expires_at = now() + interval '14 days',
      email_generation_id = v_generation_id
  where workspace_id = p_workspace_id and id = p_invitation_id and status = 'pending'
  returning * into v_invitation;

  if v_invitation.id is null then raise exception 'Pending invitation not found'; end if;
  v_token := v_invitation.token;

  update outbound_email_deliveries
  set status = 'superseded',
      superseded_at = coalesce(superseded_at, now()),
      last_failure_summary = coalesce(last_failure_summary, 'Invitation was resent before this email was accepted by provider.')
  where workspace_id = p_workspace_id
    and workspace_invitation_id = p_invitation_id
    and status = 'pending'
    and invitation_generation_id <> v_generation_id;

  if coalesce(p_enqueue_email, false) then
    insert into outbound_email_deliveries (
      id, workspace_id, purpose, workspace_invitation_id, invitation_generation_id,
      recipient_email, created_by_user_id
    )
    values (
      gen_random_uuid(), p_workspace_id, 'workspace_invitation', p_invitation_id, v_generation_id,
      v_invitation.email, auth.uid()
    )
    on conflict (workspace_id, workspace_invitation_id, invitation_generation_id) do nothing;
  end if;

  return v_token;
end;
$$;

revoke all on function create_workspace_invitation_authorized(uuid, text, uuid, boolean) from public, anon;
grant execute on function create_workspace_invitation_authorized(uuid, text, uuid, boolean) to authenticated, service_role;

revoke all on function resend_workspace_invitation_authorized(uuid, uuid, boolean) from public, anon;
grant execute on function resend_workspace_invitation_authorized(uuid, uuid, boolean) to authenticated, service_role;

-- 4. Admin delivery history. No token/body/url is returned.
create function list_outbound_email_deliveries_authorized(
  p_workspace_id uuid,
  p_limit integer default 50
)
returns table (
  id uuid,
  purpose text,
  recipient_email text,
  status text,
  attempts integer,
  next_attempt_at timestamptz,
  last_attempted_at timestamptz,
  last_response_status integer,
  last_failure_summary text,
  provider text,
  provider_message_id text,
  created_at timestamptz,
  accepted_at timestamptz,
  failed_at timestamptz,
  superseded_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_members');

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Email delivery log limit must be between 1 and 200';
  end if;

  return query
  select
    delivery.id,
    delivery.purpose,
    delivery.recipient_email,
    delivery.status,
    delivery.attempts,
    delivery.next_attempt_at,
    delivery.last_attempted_at,
    delivery.last_response_status,
    delivery.last_failure_summary,
    delivery.provider,
    delivery.provider_message_id,
    delivery.created_at,
    delivery.accepted_at,
    delivery.failed_at,
    delivery.superseded_at
  from outbound_email_deliveries delivery
  where delivery.workspace_id = p_workspace_id
  order by delivery.created_at desc
  limit p_limit;
end;
$$;

revoke all on function list_outbound_email_deliveries_authorized(uuid, integer) from public, anon;
grant execute on function list_outbound_email_deliveries_authorized(uuid, integer) to authenticated, service_role;

-- 5. System dispatcher RPCs.
create function claim_due_outbound_email_deliveries_system(p_limit integer default 25)
returns table (delivery_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery record;
  v_lease constant interval := interval '2 minutes';
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Email delivery claim limit must be between 1 and 200';
  end if;

  for v_delivery in
    select delivery.id
    from outbound_email_deliveries delivery
    where delivery.status = 'pending'
      and delivery.next_attempt_at <= now()
    order by delivery.next_attempt_at
    limit p_limit
    for update of delivery skip locked
  loop
    update outbound_email_deliveries delivery
    set next_attempt_at = now() + v_lease
    where delivery.id = v_delivery.id;

    return query select v_delivery.id;
  end loop;
end;
$$;

create function prepare_workspace_invitation_email_delivery_system(p_delivery_id uuid)
returns table (
  delivery_id uuid,
  workspace_id uuid,
  invitation_id uuid,
  invitation_token uuid,
  recipient_email text,
  workspace_name text,
  role_name text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery outbound_email_deliveries%rowtype;
  v_invitation workspace_invitations%rowtype;
begin
  select * into v_delivery
  from outbound_email_deliveries
  where id = p_delivery_id
  for update;

  if not found or v_delivery.status <> 'pending' then
    return;
  end if;

  select * into v_invitation
  from workspace_invitations
  where id = v_delivery.workspace_invitation_id
  for update;

  if not found then
    update outbound_email_deliveries
    set status = 'failed',
        failed_at = coalesce(failed_at, now()),
        last_failure_summary = 'Invitation no longer exists.'
    where id = p_delivery_id;
    return;
  end if;

  if v_delivery.purpose <> 'workspace_invitation'
     or v_delivery.workspace_id <> v_invitation.workspace_id
     or v_delivery.invitation_generation_id <> v_invitation.email_generation_id then
    update outbound_email_deliveries
    set status = 'superseded',
        superseded_at = coalesce(superseded_at, now()),
        last_failure_summary = 'Invitation was updated before this email was accepted by provider.'
    where id = p_delivery_id;
    return;
  end if;

  if v_invitation.status <> 'pending' then
    update outbound_email_deliveries
    set status = 'superseded',
        superseded_at = coalesce(superseded_at, now()),
        last_failure_summary = 'Invitation is no longer pending.'
    where id = p_delivery_id;
    return;
  end if;

  if v_invitation.expires_at <= now() then
    update outbound_email_deliveries
    set status = 'failed',
        failed_at = coalesce(failed_at, now()),
        last_failure_summary = 'Invitation expired before email was accepted by provider.'
    where id = p_delivery_id;
    return;
  end if;

  return query
  select
    v_delivery.id,
    v_delivery.workspace_id,
    v_invitation.id,
    v_invitation.token,
    v_invitation.email,
    workspace.name,
    role.name,
    v_invitation.expires_at
  from workspaces workspace
  join workspace_roles role
    on role.workspace_id = v_invitation.workspace_id
   and role.id = v_invitation.role_id
  where workspace.id = v_invitation.workspace_id;
end;
$$;

create function record_outbound_email_delivery_attempt_system(
  p_delivery_id uuid,
  p_accepted boolean,
  p_response_status integer,
  p_failure_summary text,
  p_retryable boolean,
  p_retry_after_seconds integer default null,
  p_provider_message_id text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_max_attempts constant integer := 6;
  v_backoff constant interval[] := array[
    interval '1 minute', interval '5 minutes', interval '30 minutes',
    interval '2 hours', interval '6 hours', interval '24 hours'
  ];
  v_attempts integer;
  v_status text;
  v_next_attempt_at timestamptz;
begin
  select attempts + 1 into v_attempts
  from outbound_email_deliveries
  where id = p_delivery_id and status = 'pending'
  for update;

  if not found then return; end if;

  if p_accepted then
    v_status := 'accepted';
    v_next_attempt_at := null;
  elsif not p_retryable or v_attempts >= v_max_attempts then
    v_status := 'failed';
    v_next_attempt_at := null;
  else
    v_status := 'pending';
    if p_retry_after_seconds is not null and p_retry_after_seconds > 0 and p_retry_after_seconds <= 86400 then
      v_next_attempt_at := now() + make_interval(secs => p_retry_after_seconds);
    else
      v_next_attempt_at := now() + v_backoff[v_attempts];
    end if;
  end if;

  update outbound_email_deliveries
  set attempts = v_attempts,
      last_attempted_at = now(),
      last_response_status = p_response_status,
      last_failure_summary = left(p_failure_summary, 500),
      status = v_status,
      next_attempt_at = case when v_next_attempt_at is null then next_attempt_at else v_next_attempt_at end,
      provider_message_id = coalesce(nullif(p_provider_message_id, ''), provider_message_id),
      accepted_at = case when v_status = 'accepted' then now() else accepted_at end,
      failed_at = case when v_status = 'failed' then now() else failed_at end
  where id = p_delivery_id;
end;
$$;

revoke all on function claim_due_outbound_email_deliveries_system(integer) from public, anon, authenticated;
grant execute on function claim_due_outbound_email_deliveries_system(integer) to service_role;

revoke all on function prepare_workspace_invitation_email_delivery_system(uuid) from public, anon, authenticated;
grant execute on function prepare_workspace_invitation_email_delivery_system(uuid) to service_role;

revoke all on function record_outbound_email_delivery_attempt_system(uuid, boolean, integer, text, boolean, integer, text) from public, anon, authenticated;
grant execute on function record_outbound_email_delivery_attempt_system(uuid, boolean, integer, text, boolean, integer, text) to service_role;
