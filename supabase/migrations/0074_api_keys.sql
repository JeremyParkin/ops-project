-- Phase 8F.3: Read-only API Foundations. Workspace-scoped API keys and a
-- small, bounded, versioned read surface (/api/v1/objects/...) -- no writes.
--
-- Core architectural invariant, driven directly by review: an API key is an
-- external authorization principal, not trusted system authority. Every
-- externally-reachable function below takes p_key_hash, never a workspace
-- id -- the workspace comes ONLY from the active, non-revoked key row that
-- hash resolves to (private.resolve_api_key_workspace), and every requested
-- object/record id is constrained against that derived workspace inside the
-- function itself. app/api/v1 route handlers never issue a direct table
-- read; they only ever call one of these RPCs. This means a bug in a route
-- handler cannot turn possession of the service-role client into a
-- cross-workspace read -- there is no parameter path into these functions
-- that could name a different workspace than the one the key actually
-- belongs to.
--
-- Rate limiting: a first draft raised an exception for "over limit" inside
-- the same transaction as the counter update, which would have rolled the
-- counter back along with everything else -- caught before this was
-- applied. The fix is two independent, separately-transacted RPC calls, not
-- one: check_api_key_rate_limit_for_api_key (called first, always commits
-- its last_used_at/counter mutation whether or not the caller is over
-- limit, and never raises for "over limit" -- only for a truly invalid/
-- revoked key, where nothing has been written yet) and the four data-
-- serving RPCs, each of which independently re-derives its own workspace
-- from the key rather than trusting the rate check's prior resolution --
-- the rate call is a cheap gate the route can skip data-fetching behind,
-- not a component the tenant boundary depends on.
--
-- Pre-application review caught two further issues, fixed before this
-- migration was ever applied:
--  - Relation values do not live in entity_records.values (see the comment
--    directly above list_records_for_api_key/get_record_for_api_key below)
--    -- an earlier draft read a relation's raw target id from there, which
--    would always have been null.
--  - list_objects_for_api_key/list_records_for_api_key now select p_limit +
--    1 rows internally so nextCursor (built in the app layer) is only ever
--    non-null when a page's worth of rows beyond the requested limit
--    genuinely exist, not guessed from "a full page was returned" (which is
--    also true on the last page when the true count is an exact multiple of
--    the limit).
--
-- Function posture for every new function below: set search_path = '' with
-- every table/function reference fully schema-qualified -- a deliberately
-- tighter posture than this codebase's existing `set search_path = public,
-- pg_temp` convention, warranted here because this is the one surface an
-- external, non-interactive bearer credential drives end to end.
-- private.resolve_api_key_workspace and private.api_record_label are
-- revoked from every role, including service_role -- they are reachable
-- only via an internal function-to-function call from the RPCs below (which
-- executes under the calling SECURITY DEFINER function's own rights, not
-- the original caller's grants -- the same mechanism private.require_
-- workspace_capability already relies on throughout this schema).

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_preview text not null,
  scopes text[] not null default array['records:read'],
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_workspace_idx on api_keys (workspace_id);

create trigger api_keys_workspace_id_immutable
  before update on api_keys
  for each row execute function private.reject_workspace_id_change();

alter table api_keys enable row level security;
-- Deliberately closed, same posture as webhook_subscriptions (0073): no
-- select/insert/update policy at all. Interactive access goes through the
-- _authorized RPCs below; API-serving access goes through the _for_api_key
-- RPCs below, both service_role/security-definer mediated, never RLS.
revoke all on table api_keys from public, anon, authenticated;

-- A separate, small, high-frequency-write primitive -- deliberately not
-- columns on api_keys itself, so the durable credential row stays
-- write-quiet (only last_used_at) and the rate counter's own write
-- contention/WAL churn is isolated to a table that holds nothing
-- security-sensitive. One row per key, created transactionally alongside
-- the key (create_api_key_authorized below) so there is never a
-- first-request race needing an upsert-or-insert.
create table api_key_rate_limits (
  api_key_id uuid primary key references api_keys(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0
);

alter table api_key_rate_limits enable row level security;
revoke all on table api_key_rate_limits from public, anon, authenticated;

-- Internal-only: resolves a key hash to its workspace/scopes, or raises
-- invalid_api_key if the key is unknown or revoked. No side effects (no
-- last_used_at touch, no rate-limit mutation) -- those are check_api_key_
-- rate_limit_for_api_key's job, so this function can be called redundantly
-- (once per RPC, by design) without double-counting anything.
create function private.resolve_api_key_workspace(p_key_hash text)
returns table(workspace_id uuid, key_id uuid, scopes text[])
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  return query
  select ak.workspace_id, ak.id, ak.scopes
  from public.api_keys ak
  where ak.key_hash = p_key_hash and ak.revoked_at is null;

  if not found then
    raise exception 'invalid_api_key';
  end if;
end;
$$;

-- Internal-only: faithfully mirrors getRecordLabel/getRecordIdentityField
-- (lib/domain/record-repository.ts) -- configured display field (must be
-- type=text, unarchived) else the first unarchived type=text field by
-- position; if no such field exists, a shortened id. Once a label field is
-- chosen, only a jsonb string value that is non-empty after trimming is
-- used (matching `typeof value === "string" && value.trim()`), and the
-- ORIGINAL untrimmed value is what's returned -- any other case (missing
-- key, json null, non-string, empty/whitespace-only) falls through to the
-- shortened-id form. No archived-target decoration, matching 8F.1's export
-- choice to always use the undecorated label, never getRelationOptionLabel.
create function private.api_record_label(p_workspace_id uuid, p_entity_type_id uuid, p_record_id uuid)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_display_field_id uuid;
  v_label_field_key text;
  v_raw_value jsonb;
begin
  select et.display_field_definition_id into v_display_field_id
  from public.entity_types et
  where et.id = p_entity_type_id and et.workspace_id = p_workspace_id;

  select fd.key into v_label_field_key
  from public.field_definitions fd
  where fd.id = v_display_field_id
    and fd.entity_type_id = p_entity_type_id
    and fd.workspace_id = p_workspace_id
    and fd.type = 'text'
    and fd.archived_at is null;

  if v_label_field_key is null then
    select fd.key into v_label_field_key
    from public.field_definitions fd
    where fd.entity_type_id = p_entity_type_id
      and fd.workspace_id = p_workspace_id
      and fd.type = 'text'
      and fd.archived_at is null
    order by fd.position asc
    limit 1;
  end if;

  if v_label_field_key is null then
    return left(p_record_id::text, 8) || '...';
  end if;

  select er.values -> v_label_field_key into v_raw_value
  from public.entity_records er
  where er.id = p_record_id and er.workspace_id = p_workspace_id and er.entity_type_id = p_entity_type_id;

  if jsonb_typeof(v_raw_value) = 'string' and trim(both from (v_raw_value #>> '{}')) <> '' then
    return v_raw_value #>> '{}';
  end if;

  return left(p_record_id::text, 8) || '...';
end;
$$;

-- The one function that mutates last_used_at/the rate counter. Called
-- first, awaited, on its own -- never raises for "over limit" (only for an
-- unknown/revoked key, where no rate row has been touched yet), so its
-- mutation always commits regardless of the outcome the caller acts on.
create function check_api_key_rate_limit_for_api_key(p_key_hash text)
returns table(key_id uuid, workspace_id uuid, scopes text[], allowed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_key_id uuid;
  v_scopes text[];
  v_request_count integer;
begin
  select r.workspace_id, r.key_id, r.scopes
  into v_workspace_id, v_key_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  update public.api_keys set last_used_at = now() where id = v_key_id;

  update public.api_key_rate_limits
  set request_count = case when window_started_at <= now() - interval '60 seconds' then 1 else request_count + 1 end,
      window_started_at = case when window_started_at <= now() - interval '60 seconds' then now() else window_started_at end
  where api_key_id = v_key_id
  returning request_count into v_request_count;

  return query select v_key_id, v_workspace_id, v_scopes, (v_request_count <= 60);
end;
$$;

create function list_objects_for_api_key(
  p_key_hash text,
  p_limit integer default 50,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
returns table(id uuid, name text, slug text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_scopes text[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_limit';
  end if;

  select r.workspace_id, r.scopes into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  if not ('records:read' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  -- limit p_limit + 1, not p_limit: the extra row (trimmed by the app
  -- layer, which returns at most p_limit externally) is what makes
  -- nextCursor truthful -- it is only ever emitted when a page's worth of
  -- rows beyond the requested limit actually exist, never guessed from a
  -- full page alone (which could be the last page if the true count is an
  -- exact multiple of the limit).
  return query
  select et.id, et.name, et.slug, et.created_at
  from public.entity_types et
  where et.workspace_id = v_workspace_id
    and et.archived_at is null
    and (p_after_created_at is null or (et.created_at, et.id) > (p_after_created_at, p_after_id))
  order by et.created_at asc, et.id asc
  limit p_limit + 1;
end;
$$;

create function get_object_for_api_key(p_key_hash text, p_entity_type_id uuid)
returns table(id uuid, name text, slug text, created_at timestamptz, updated_at timestamptz, fields jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_scopes text[];
begin
  select r.workspace_id, r.scopes into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  if not ('records:read' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  return query
  select
    et.id, et.name, et.slug, et.created_at, et.updated_at,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', fd.id, 'key', fd.key, 'name', fd.name, 'type', fd.type,
          'required', fd.required, 'relatedEntityTypeId', fd.related_entity_type_id
        )
        order by fd.position asc
      )
      from public.field_definitions fd
      where fd.entity_type_id = et.id and fd.workspace_id = v_workspace_id and fd.archived_at is null
    ), '[]'::jsonb)
  from public.entity_types et
  where et.id = p_entity_type_id and et.workspace_id = v_workspace_id and et.archived_at is null;
end;
$$;

-- Relation values are never present in entity_records.values -- Kinema's
-- canonical persistence keeps primitive values there and relation values
-- exclusively in the normalized entity_record_relation_values table (see
-- create_entity_record_with_relations, 0003: p_values and p_relations are
-- inserted as two entirely separate operations). The ordinary interactive
-- repository (listEntityRecords) merges the two only on read, in Node; both
-- RPCs below do the equivalent merge in SQL, reading relation targets from
-- entity_record_relation_values and overlaying them onto entity_records.
-- values as {id, label} -- never assuming a relation's raw target id was
-- ever stored inside the values jsonb itself.
create function list_records_for_api_key(
  p_key_hash text,
  p_entity_type_id uuid,
  p_limit integer default 50,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
-- Output column is record_values, not values -- an unquoted `values` is
-- rejected by PostgreSQL's RETURNS TABLE(...) grammar (it parses as the
-- VALUES keyword there, even though the identical bare name is perfectly
-- legal as an ordinary table column, e.g. entity_records.values itself).
-- The external API contract is unaffected: the app layer still maps this
-- to a `values` key in the JSON response.
returns table(id uuid, record_values jsonb, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_scopes text[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_limit';
  end if;

  select r.workspace_id, r.scopes into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  if not ('records:read' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  if not exists (
    select 1 from public.entity_types et
    where et.id = p_entity_type_id and et.workspace_id = v_workspace_id and et.archived_at is null
  ) then
    return;
  end if;

  -- limit p_limit + 1 (see list_objects_for_api_key above for why), applied
  -- to the `page` CTE only -- every downstream CTE operates solely on that
  -- already-bounded set, so the final output never exceeds p_limit + 1 rows
  -- regardless of how many relation values a record has.
  return query
  with page as (
    select er.id, er.values, er.created_at, er.updated_at
    from public.entity_records er
    where er.workspace_id = v_workspace_id
      and er.entity_type_id = p_entity_type_id
      and er.archived_at is null
      and (p_after_created_at is null or (er.created_at, er.id) > (p_after_created_at, p_after_id))
    order by er.created_at asc, er.id asc
    limit p_limit + 1
  ),
  relation_fields as (
    select fd.id as field_id, fd.key, fd.related_entity_type_id
    from public.field_definitions fd
    where fd.entity_type_id = p_entity_type_id
      and fd.workspace_id = v_workspace_id
      and fd.type = 'relation'
      and fd.archived_at is null
  ),
  relation_values as (
    select rv.source_record_id, rf.key, rv.target_record_id, rf.related_entity_type_id
    from public.entity_record_relation_values rv
    join relation_fields rf on rf.field_id = rv.field_definition_id
    where rv.workspace_id = v_workspace_id
      and rv.source_record_id in (select p.id from page p)
  )
  select
    p.id,
    p.values || coalesce(
      (
        select jsonb_object_agg(
          rvals.key,
          jsonb_build_object('id', rvals.target_record_id, 'label', private.api_record_label(v_workspace_id, rvals.related_entity_type_id, rvals.target_record_id))
        )
        from relation_values rvals
        where rvals.source_record_id = p.id
      ),
      '{}'::jsonb
    ),
    p.created_at,
    p.updated_at
  from page p
  order by p.created_at asc, p.id asc;
end;
$$;

create function get_record_for_api_key(p_key_hash text, p_entity_type_id uuid, p_record_id uuid)
-- record_values, not values -- see list_records_for_api_key above.
returns table(id uuid, record_values jsonb, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_scopes text[];
begin
  select r.workspace_id, r.scopes into v_workspace_id, v_scopes
  from private.resolve_api_key_workspace(p_key_hash) r;

  if not ('records:read' = any(v_scopes)) then
    raise exception 'insufficient_scope';
  end if;

  if not exists (
    select 1 from public.entity_types et
    where et.id = p_entity_type_id and et.workspace_id = v_workspace_id and et.archived_at is null
  ) then
    return;
  end if;

  return query
  with target as (
    select er.id, er.values, er.created_at, er.updated_at
    from public.entity_records er
    where er.id = p_record_id
      and er.workspace_id = v_workspace_id
      and er.entity_type_id = p_entity_type_id
      and er.archived_at is null
  ),
  relation_fields as (
    select fd.id as field_id, fd.key, fd.related_entity_type_id
    from public.field_definitions fd
    where fd.entity_type_id = p_entity_type_id
      and fd.workspace_id = v_workspace_id
      and fd.type = 'relation'
      and fd.archived_at is null
  ),
  relation_overlay as (
    select coalesce(
      jsonb_object_agg(
        rf.key,
        jsonb_build_object('id', rv.target_record_id, 'label', private.api_record_label(v_workspace_id, rf.related_entity_type_id, rv.target_record_id))
      ),
      '{}'::jsonb
    ) as overlay
    from public.entity_record_relation_values rv
    join relation_fields rf on rf.field_id = rv.field_definition_id
    where rv.workspace_id = v_workspace_id
      and rv.source_record_id = p_record_id
  )
  select t.id, t.values || (select overlay from relation_overlay), t.created_at, t.updated_at
  from target t;
end;
$$;

-- Interactive management, capability-gated exactly like webhook subscription
-- management (0073) -- workspace.manage_integrations, no new capability.
create function create_api_key_authorized(
  p_workspace_id uuid,
  p_name text,
  p_key_hash text,
  p_key_preview text
)
returns table(id uuid, name text, key_preview text, scopes text[], created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  if nullif(trim(p_name), '') is null then raise exception 'Key name is required'; end if;
  if nullif(trim(p_key_hash), '') is null or nullif(trim(p_key_preview), '') is null then
    raise exception 'Key material is required';
  end if;

  insert into public.api_keys (workspace_id, name, key_hash, key_preview, created_by)
  values (p_workspace_id, trim(p_name), p_key_hash, p_key_preview, auth.uid())
  returning api_keys.id into v_id;

  insert into public.api_key_rate_limits (api_key_id) values (v_id);

  return query
  select ak.id, ak.name, ak.key_preview, ak.scopes, ak.created_at
  from public.api_keys ak
  where ak.id = v_id;
end;
$$;

create function list_api_keys_authorized(p_workspace_id uuid)
returns table(
  id uuid, name text, key_preview text, scopes text[],
  created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  return query
  select ak.id, ak.name, ak.key_preview, ak.scopes, ak.created_at, ak.last_used_at, ak.revoked_at
  from public.api_keys ak
  where ak.workspace_id = p_workspace_id
  order by ak.created_at desc;
end;
$$;

create function revoke_api_key_authorized(p_workspace_id uuid, p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_integrations');

  update public.api_keys
  set revoked_at = now()
  where workspace_id = p_workspace_id and id = p_key_id and revoked_at is null;

  if not found then
    raise exception 'API key not found or already revoked';
  end if;
end;
$$;

-- Interactive management: authenticated (real member, capability-checked
-- inside the function body).
revoke all on function create_api_key_authorized(uuid, text, text, text) from public, anon;
grant execute on function create_api_key_authorized(uuid, text, text, text) to authenticated;

revoke all on function list_api_keys_authorized(uuid) from public, anon;
grant execute on function list_api_keys_authorized(uuid) to authenticated;

revoke all on function revoke_api_key_authorized(uuid, uuid) from public, anon;
grant execute on function revoke_api_key_authorized(uuid, uuid) to authenticated;

-- Internal-only helpers: never directly callable by any role, including
-- service_role. Reachable only via an internal call from the functions
-- below, which runs under those functions' own SECURITY DEFINER rights.
revoke all on function private.resolve_api_key_workspace(text) from public, anon, authenticated, service_role;
revoke all on function private.api_record_label(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- API-serving: service_role only (the /api/v1 route handlers' admin
-- client). Never granted to authenticated/anon -- an ordinary interactive
-- session has no business calling these directly, and a route handler must
-- never fall back to cookie/session auth on this surface.
revoke all on function check_api_key_rate_limit_for_api_key(text) from public, anon, authenticated;
grant execute on function check_api_key_rate_limit_for_api_key(text) to service_role;

revoke all on function list_objects_for_api_key(text, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function list_objects_for_api_key(text, integer, timestamptz, uuid) to service_role;

revoke all on function get_object_for_api_key(text, uuid) from public, anon, authenticated;
grant execute on function get_object_for_api_key(text, uuid) to service_role;

revoke all on function list_records_for_api_key(text, uuid, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function list_records_for_api_key(text, uuid, integer, timestamptz, uuid) to service_role;

revoke all on function get_record_for_api_key(text, uuid, uuid) from public, anon, authenticated;
grant execute on function get_record_for_api_key(text, uuid, uuid) to service_role;
