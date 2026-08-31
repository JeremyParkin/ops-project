-- Phase 8F.2: Outbound Webhooks. Deliver selected durable workspace_events
-- rows to admin-configured external HTTPS endpoints, reliably and
-- inspectably -- not a generic integration platform.
--
-- Architecture, in order:
--  1. A new capability, workspace.manage_integrations, dedicated rather than
--     reusing workspace.manage_settings -- webhook management can transmit
--     workspace data externally and controls external secrets/endpoints, a
--     materially different trust boundary than ordinary workspace settings.
--     Backfilled onto the built-in "Workspace administrator" role only
--     (documented in 0045 as "Compatibility role with full workspace
--     access" -- the same reasoning 0068 used for workspace.impersonate_
--     users). Custom roles never receive it automatically. Chosen so 8F.3
--     API keys and later connectivity surfaces can reuse this same
--     capability rather than each minting their own.
--  2. webhook_subscriptions: one row per configured external endpoint.
--     signing_secret is stored in recoverable (plaintext) form with RLS
--     fully closed to every non-service_role caller -- the dispatcher must
--     be able to read the literal secret to compute each delivery's HMAC,
--     which a one-way hash (this app's 8F.3 API-key posture) cannot
--     support. Encryption-at-rest (pgcrypto envelope encryption) is
--     recorded as accepted production-hardening debt, not implemented here
--     -- RLS closure is the actual boundary today, matching every other
--     sensitive table in this schema.
--  3. webhook_deliveries: one row per (event, subscription) pair, unique on
--     (subscription_id, event_id) -- the same claim-before-side-effect
--     idempotency shape as record_import_batches/process_recurrence_
--     occurrences/notifications. Two terminal statuses (succeeded, failed),
--     one working status (pending) that covers both "never attempted" and
--     "will retry" -- next_attempt_at is what changes between those, not
--     status, so there is no separate "claimed"/"in-flight" status to leak
--     if a dispatcher run crashes mid-delivery (see the claim function).
--  4. An AFTER INSERT trigger on workspace_events fans out into
--     webhook_deliveries -- the same pattern already established by
--     entity_records_process_condition_wait_wakeup (0038): a small
--     private.enqueue_* function called from a trigger, requiring zero
--     changes to any of the ~7 existing call sites that insert into
--     workspace_events. Transactionally atomic with the event insert: there
--     is no window where an event exists but no delivery rows were queued
--     for its active, subscribed subscriptions. A subscription that is
--     inactive at the moment an event fires never gets a delivery row for
--     it, even if later reactivated -- consistent with this codebase's
--     standing no-historical-backfill posture (Activity, notifications).
--  5. Two service_role-only dispatcher RPCs, mirroring resume_due_process_
--     waits_system's for-update-skip-locked idiom, adapted because the
--     actual work here (an outbound HTTP call) cannot happen inside
--     Postgres and must happen in the calling Node route:
--       - claim_due_webhook_deliveries_system: locks and returns due
--         pending rows (status = 'pending', next_attempt_at <= now(),
--         subscription active), leasing each by pushing next_attempt_at
--         forward 2 minutes before returning it. A dispatcher that crashes
--         mid-batch self-heals once the lease expires -- no separate
--         "claimed" status, no orphaned rows.
--       - record_webhook_delivery_attempt_system: records one attempt's
--         outcome. p_retryable is decided by the calling app code (network/
--         timeout/429/5xx retry; any other 4xx is terminal), matching the
--         approved retry policy. A delivery always signs with whatever
--         secret is live on its subscription AT CLAIM TIME, never a secret
--         snapshotted at enqueue time -- so if a subscription's secret is
--         rotated while a delivery is mid-retry-backoff, every attempt from
--         that point forward (the remaining retries, not just new
--         deliveries) uses the new secret. This is a deliberate choice: the
--         receiver should only ever need to trust its current secret.
--  6. SSRF protection (URL canonical parsing, DNS resolution, IP-range
--     classification) lives entirely in the application layer (lib/domain/
--     webhook-url-safety.ts) since Postgres cannot make DNS/network calls
--     without an extension this project doesn't use. The one SQL-level
--     guard here (url ~ '^https://') is cheap defense-in-depth against a
--     hypothetical caller that bypasses the app layer, not the real check.

-- 1. Capability.
alter table workspace_role_capabilities drop constraint if exists workspace_role_capabilities_capability_check;
alter table workspace_role_capabilities add constraint workspace_role_capabilities_capability_check
  check (capability in (
    'workspace.manage_members', 'workspace.manage_roles', 'workspace.manage_organization', 'workspace.manage_settings',
    'schema.manage', 'automation.manage', 'records.operate', 'processes.operate', 'operations.view',
    'workspace.impersonate_users',
    'workspace.manage_integrations'
  ));

insert into workspace_role_capabilities (workspace_id, role_id, capability)
select role.workspace_id, role.id, 'workspace.manage_integrations'
from workspace_roles role
where role.is_builtin = true
  and not exists (
    select 1 from workspace_role_capabilities existing
    where existing.workspace_id = role.workspace_id and existing.role_id = role.id
      and existing.capability = 'workspace.manage_integrations'
  );

-- Reproduced in full from their current live bodies (0068) with the one new
-- value added to each inline vocabulary list -- these RPCs validate
-- incoming capability values independently of the table CHECK constraint
-- above, so without this the role editor would reject workspace.manage_
-- integrations as "Invalid capability" the moment anyone tried to grant it
-- to a custom role.
create or replace function create_workspace_role_authorized(
  p_workspace_id uuid,
  p_name text,
  p_description text,
  p_capabilities jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role_id uuid := gen_random_uuid();
  v_capability text;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');

  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;

  insert into workspace_roles (id, workspace_id, name, description)
  values (v_role_id, p_workspace_id, trim(p_name), nullif(trim(p_description), ''));

  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members',
      'workspace.manage_roles',
      'workspace.manage_organization',
      'workspace.manage_settings',
      'schema.manage',
      'automation.manage',
      'records.operate',
      'processes.operate',
      'operations.view',
      'workspace.impersonate_users',
      'workspace.manage_integrations'
    ) then
      raise exception 'Invalid capability';
    end if;

    insert into workspace_role_capabilities (workspace_id, role_id, capability)
    values (p_workspace_id, v_role_id, v_capability);
  end loop;

  return v_role_id;
end;
$$;

create or replace function update_workspace_role_authorized(
  p_workspace_id uuid,
  p_role_id uuid,
  p_name text,
  p_description text,
  p_capabilities jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_capability text;
  v_caller_role uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  select role_id into v_caller_role
  from workspace_memberships
  where workspace_id = p_workspace_id
    and user_id = auth.uid()
  for update;

  if v_caller_role = p_role_id then
    raise exception 'You cannot edit the capabilities of your own role';
  end if;
  if not exists (
    select 1
    from workspace_roles
    where workspace_id = p_workspace_id
      and id = p_role_id
  ) then
    raise exception 'Role not found';
  end if;
  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;

  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members',
      'workspace.manage_roles',
      'workspace.manage_organization',
      'workspace.manage_settings',
      'schema.manage',
      'automation.manage',
      'records.operate',
      'processes.operate',
      'operations.view',
      'workspace.impersonate_users',
      'workspace.manage_integrations'
    ) then
      raise exception 'Invalid capability';
    end if;
  end loop;

  update workspace_roles
  set name = trim(p_name),
      description = nullif(trim(p_description), ''),
      updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_role_id;

  delete from workspace_role_capabilities
  where workspace_id = p_workspace_id
    and role_id = p_role_id;

  insert into workspace_role_capabilities (workspace_id, role_id, capability)
  select p_workspace_id, p_role_id, value
  from jsonb_array_elements_text(p_capabilities) value;

  perform private.assert_workspace_administrator(p_workspace_id);
end;
$$;

-- 2. Subscriptions.
create table webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  url text not null check (url ~ '^https://'),
  event_types text[] not null check (array_length(event_types, 1) > 0),
  active boolean not null default true,
  signing_secret text not null,
  secret_preview text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index webhook_subscriptions_workspace_idx on webhook_subscriptions (workspace_id);

create trigger webhook_subscriptions_workspace_id_immutable
  before update on webhook_subscriptions
  for each row execute function private.reject_workspace_id_change();

alter table webhook_subscriptions enable row level security;
-- Deliberately closed: no select/insert/update policy at all, same posture
-- as workspace_events (0064). Every access goes through the _authorized/
-- _system RPCs below.
revoke all on table webhook_subscriptions from public, anon, authenticated;

-- 3. Delivery ledger.
create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  subscription_id uuid not null references webhook_subscriptions(id) on delete cascade,
  event_id uuid not null references workspace_events(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempted_at timestamptz,
  last_response_status integer,
  last_failure_summary text,
  created_at timestamptz not null default now(),
  unique (subscription_id, event_id)
);

create index webhook_deliveries_claim_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_subscription_created_idx on webhook_deliveries (workspace_id, subscription_id, created_at desc);

create trigger webhook_deliveries_workspace_id_immutable
  before update on webhook_deliveries
  for each row execute function private.reject_workspace_id_change();

alter table webhook_deliveries enable row level security;
revoke all on table webhook_deliveries from public, anon, authenticated;

-- 4. Fan-out trigger.
create or replace function private.enqueue_webhook_deliveries()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into webhook_deliveries (workspace_id, subscription_id, event_id)
  select NEW.workspace_id, ws.id, NEW.id
  from webhook_subscriptions ws
  where ws.workspace_id = NEW.workspace_id
    and ws.active = true
    and NEW.event_type = any(ws.event_types)
  on conflict (subscription_id, event_id) do nothing;
  return NEW;
end;
$$;

drop trigger if exists workspace_events_enqueue_webhook_deliveries on workspace_events;
create trigger workspace_events_enqueue_webhook_deliveries
after insert on workspace_events
for each row execute function private.enqueue_webhook_deliveries();

-- 5. Interactive management RPCs. Secrets are generated in the application
-- layer (Node's CSPRNG) and passed in, not generated here -- this project
-- has never depended on pgcrypto's gen_random_bytes and there is no need to
-- start now purely to mint a secret.
create function create_webhook_subscription_authorized(
  p_workspace_id uuid,
  p_name text,
  p_url text,
  p_event_types text[],
  p_signing_secret text
)
returns table (
  id uuid, name text, url text, event_types text[], active boolean,
  secret_preview text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_event_type text;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  if nullif(trim(p_name), '') is null then raise exception 'Webhook name is required'; end if;
  if nullif(trim(p_url), '') is null then raise exception 'Webhook URL is required'; end if;
  if nullif(trim(p_signing_secret), '') is null then raise exception 'Signing secret is required'; end if;
  if p_event_types is null or array_length(p_event_types, 1) is null then
    raise exception 'At least one event type is required';
  end if;

  foreach v_event_type in array p_event_types loop
    if v_event_type not in ('process_started', 'process_completed', 'approval_decided', 'step_assigned') then
      raise exception 'Invalid event type: %', v_event_type;
    end if;
  end loop;

  insert into webhook_subscriptions (id, workspace_id, name, url, event_types, signing_secret, secret_preview, created_by)
  values (v_id, p_workspace_id, trim(p_name), trim(p_url), p_event_types, p_signing_secret, right(p_signing_secret, 4), auth.uid());

  return query
  select ws.id, ws.name, ws.url, ws.event_types, ws.active, ws.secret_preview, ws.created_at
  from webhook_subscriptions ws
  where ws.id = v_id;
end;
$$;

create function update_webhook_subscription_authorized(
  p_workspace_id uuid,
  p_subscription_id uuid,
  p_name text,
  p_url text,
  p_event_types text[],
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_event_type text;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  if nullif(trim(p_name), '') is null then raise exception 'Webhook name is required'; end if;
  if nullif(trim(p_url), '') is null then raise exception 'Webhook URL is required'; end if;
  if p_event_types is null or array_length(p_event_types, 1) is null then
    raise exception 'At least one event type is required';
  end if;

  foreach v_event_type in array p_event_types loop
    if v_event_type not in ('process_started', 'process_completed', 'approval_decided', 'step_assigned') then
      raise exception 'Invalid event type: %', v_event_type;
    end if;
  end loop;

  update webhook_subscriptions
  set name = trim(p_name), url = trim(p_url), event_types = p_event_types, active = p_active
  where workspace_id = p_workspace_id and id = p_subscription_id;

  if not found then raise exception 'Webhook not found'; end if;
end;
$$;

create function regenerate_webhook_subscription_secret_authorized(
  p_workspace_id uuid,
  p_subscription_id uuid,
  p_signing_secret text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  if nullif(trim(p_signing_secret), '') is null then raise exception 'Signing secret is required'; end if;

  update webhook_subscriptions
  set signing_secret = p_signing_secret, secret_preview = right(p_signing_secret, 4)
  where workspace_id = p_workspace_id and id = p_subscription_id;

  if not found then raise exception 'Webhook not found'; end if;
end;
$$;

create function list_webhook_subscriptions_authorized(p_workspace_id uuid)
returns table (
  id uuid, name text, url text, event_types text[], active boolean,
  secret_preview text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  return query
  select ws.id, ws.name, ws.url, ws.event_types, ws.active, ws.secret_preview, ws.created_at
  from webhook_subscriptions ws
  where ws.workspace_id = p_workspace_id
  order by ws.created_at desc;
end;
$$;

create function list_webhook_deliveries_authorized(
  p_workspace_id uuid,
  p_subscription_id uuid,
  p_limit integer default 50
)
returns table (
  id uuid, event_type text, status text, attempts integer,
  next_attempt_at timestamptz, last_attempted_at timestamptz,
  last_response_status integer, last_failure_summary text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Delivery log limit must be between 1 and 200';
  end if;

  return query
  select wd.id, we.event_type, wd.status, wd.attempts,
         wd.next_attempt_at, wd.last_attempted_at, wd.last_response_status, wd.last_failure_summary, wd.created_at
  from webhook_deliveries wd
  join workspace_events we on we.id = wd.event_id
  where wd.workspace_id = p_workspace_id and wd.subscription_id = p_subscription_id
  order by wd.created_at desc
  limit p_limit;
end;
$$;

-- 6. Dispatcher RPCs (service_role only).
create function claim_due_webhook_deliveries_system(p_limit integer default 25)
returns table (
  delivery_id uuid,
  subscription_id uuid,
  url text,
  signing_secret text,
  attempts integer,
  event_id uuid,
  event_type text,
  event_occurred_at timestamptz,
  workspace_id uuid,
  actor_user_id uuid,
  real_actor_user_id uuid,
  entity_type_id uuid,
  entity_record_id uuid,
  process_template_id uuid,
  process_run_id uuid,
  process_step_run_id uuid,
  metadata jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery record;
  v_lease constant interval := interval '2 minutes';
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Webhook delivery claim limit must be between 1 and 200';
  end if;

  for v_delivery in
    select wd.id
    from webhook_deliveries wd
    join webhook_subscriptions ws on ws.id = wd.subscription_id
    where wd.status = 'pending'
      and wd.next_attempt_at <= now()
      and ws.active = true
    order by wd.next_attempt_at
    limit p_limit
    for update of wd skip locked
  loop
    update webhook_deliveries wd
    set next_attempt_at = now() + v_lease
    where wd.id = v_delivery.id;

    return query
    select wd.id, wd.subscription_id, ws.url, ws.signing_secret, wd.attempts,
           wd.event_id, we.event_type, we.created_at, we.workspace_id,
           we.actor_user_id, we.real_actor_user_id,
           we.entity_type_id, we.entity_record_id, we.process_template_id, we.process_run_id, we.process_step_run_id,
           we.metadata
    from webhook_deliveries wd
    join webhook_subscriptions ws on ws.id = wd.subscription_id
    join workspace_events we on we.id = wd.event_id
    where wd.id = v_delivery.id;
  end loop;
end;
$$;

create function record_webhook_delivery_attempt_system(
  p_delivery_id uuid,
  p_success boolean,
  p_response_status integer,
  p_failure_summary text,
  p_retryable boolean
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
  select attempts + 1 into v_attempts from webhook_deliveries where id = p_delivery_id for update;
  if not found then return; end if;

  if p_success then
    v_status := 'succeeded';
    v_next_attempt_at := null;
  elsif not p_retryable or v_attempts >= v_max_attempts then
    v_status := 'failed';
    v_next_attempt_at := null;
  else
    v_status := 'pending';
    v_next_attempt_at := now() + v_backoff[v_attempts];
  end if;

  update webhook_deliveries
  set attempts = v_attempts,
      last_attempted_at = now(),
      last_response_status = p_response_status,
      last_failure_summary = left(p_failure_summary, 500),
      status = v_status,
      next_attempt_at = coalesce(v_next_attempt_at, next_attempt_at)
  where id = p_delivery_id;
end;
$$;

revoke all on function create_webhook_subscription_authorized(uuid, text, text, text[], text) from public, anon;
grant execute on function create_webhook_subscription_authorized(uuid, text, text, text[], text) to authenticated;

revoke all on function update_webhook_subscription_authorized(uuid, uuid, text, text, text[], boolean) from public, anon;
grant execute on function update_webhook_subscription_authorized(uuid, uuid, text, text, text[], boolean) to authenticated;

revoke all on function regenerate_webhook_subscription_secret_authorized(uuid, uuid, text) from public, anon;
grant execute on function regenerate_webhook_subscription_secret_authorized(uuid, uuid, text) to authenticated;

revoke all on function list_webhook_subscriptions_authorized(uuid) from public, anon;
grant execute on function list_webhook_subscriptions_authorized(uuid) to authenticated;

revoke all on function list_webhook_deliveries_authorized(uuid, uuid, integer) from public, anon;
grant execute on function list_webhook_deliveries_authorized(uuid, uuid, integer) to authenticated;

revoke all on function claim_due_webhook_deliveries_system(integer) from public, anon, authenticated;
grant execute on function claim_due_webhook_deliveries_system(integer) to service_role;

revoke all on function record_webhook_delivery_attempt_system(uuid, boolean, integer, text, boolean) from public, anon, authenticated;
grant execute on function record_webhook_delivery_attempt_system(uuid, boolean, integer, text, boolean) to service_role;
