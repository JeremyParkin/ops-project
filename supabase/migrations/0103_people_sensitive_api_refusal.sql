-- Phase 12.2: People-Sensitive Read Access -- public API refusal.
--
-- Approved conservative rule: people-sensitive EntityTypes are not
-- available through API-key reads in Phase 12.2 at all -- no attempt is
-- made to map interactive self/manager/author identity semantics onto an
-- API key, which has no analogous identity to check against. A
-- people-sensitive type is treated exactly like a nonexistent/archived one
-- by every object/record read RPC: an empty result (list/get-object,
-- get-record), never a distinguishable error.
--
-- Full latest bodies reproduced faithfully (list_objects_for_api_key:
-- 0074; get_object_for_api_key, list_records_for_api_key,
-- get_record_for_api_key: 0080). No signature or return-shape changes, so
-- every function uses `create or replace function`.

create or replace function list_objects_for_api_key(
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
    and et.people_sensitive is not true
    and (p_after_created_at is null or (et.created_at, et.id) > (p_after_created_at, p_after_id))
  order by et.created_at asc, et.id asc
  limit p_limit + 1;
end;
$$;

create or replace function get_object_for_api_key(p_key_hash text, p_entity_type_id uuid)
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
          'required', fd.required, 'relatedEntityTypeId', fd.related_entity_type_id,
          'options', case when fd.type = 'choice' then (
            select jsonb_agg(
              jsonb_build_object(
                'id', co.id, 'label', co.label, 'color', co.color,
                'archived', co.archived_at is not null
              )
              order by co.position
            )
            from public.field_choice_options co
            where co.workspace_id = v_workspace_id and co.field_definition_id = fd.id
          ) end
        )
        order by fd.position asc
      )
      from public.field_definitions fd
      where fd.entity_type_id = et.id and fd.workspace_id = v_workspace_id and fd.archived_at is null
    ), '[]'::jsonb)
  from public.entity_types et
  where et.id = p_entity_type_id and et.workspace_id = v_workspace_id and et.archived_at is null
    and et.people_sensitive is not true;
end;
$$;

create or replace function list_records_for_api_key(
  p_key_hash text,
  p_entity_type_id uuid,
  p_limit integer default 50,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
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
      and et.people_sensitive is not true
  ) then
    return;
  end if;

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
  active_fields as (
    select fd.id as field_id, fd.key, fd.type, fd.related_entity_type_id
    from public.field_definitions fd
    where fd.entity_type_id = p_entity_type_id
      and fd.workspace_id = v_workspace_id
      and fd.archived_at is null
  ),
  relation_targets as (
    select rv.source_record_id, af.key, rv.target_record_id, af.related_entity_type_id
    from public.entity_record_relation_values rv
    join active_fields af on af.field_id = rv.field_definition_id and af.type = 'relation'
    where rv.workspace_id = v_workspace_id
      and rv.source_record_id in (select p.id from page p)
  ),
  field_values as (
    select
      p.id as record_id,
      af.key,
      case
        when af.type = 'relation' then (
          select jsonb_build_object(
            'id', rt.target_record_id,
            'label', private.api_record_label(v_workspace_id, rt.related_entity_type_id, rt.target_record_id)
          )
          from relation_targets rt
          where rt.source_record_id = p.id and rt.key = af.key
        )
        when af.type = 'choice' then (
          select jsonb_build_object(
            'id', co.id, 'label', co.label, 'color', co.color,
            'archived', co.archived_at is not null
          )
          from public.field_choice_options co
          where co.workspace_id = v_workspace_id
            and co.field_definition_id = af.field_id
            and co.id = (p.values ->> af.key)::uuid
        )
        else p.values -> af.key
      end as value
    from page p
    cross join active_fields af
  )
  select
    p.id,
    coalesce(
      (select jsonb_object_agg(fv.key, coalesce(fv.value, 'null'::jsonb)) from field_values fv where fv.record_id = p.id),
      '{}'::jsonb
    ),
    p.created_at,
    p.updated_at
  from page p
  order by p.created_at asc, p.id asc;
end;
$$;

create or replace function get_record_for_api_key(p_key_hash text, p_entity_type_id uuid, p_record_id uuid)
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
      and et.people_sensitive is not true
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
  active_fields as (
    select fd.id as field_id, fd.key, fd.type, fd.related_entity_type_id
    from public.field_definitions fd
    where fd.entity_type_id = p_entity_type_id
      and fd.workspace_id = v_workspace_id
      and fd.archived_at is null
  ),
  relation_targets as (
    select rv.source_record_id, af.key, rv.target_record_id, af.related_entity_type_id
    from public.entity_record_relation_values rv
    join active_fields af on af.field_id = rv.field_definition_id and af.type = 'relation'
    where rv.workspace_id = v_workspace_id
      and rv.source_record_id = p_record_id
  ),
  field_values as (
    select
      af.key,
      case
        when af.type = 'relation' then (
          select jsonb_build_object(
            'id', rt.target_record_id,
            'label', private.api_record_label(v_workspace_id, rt.related_entity_type_id, rt.target_record_id)
          )
          from relation_targets rt
          where rt.key = af.key
        )
        when af.type = 'choice' then (
          select jsonb_build_object(
            'id', co.id, 'label', co.label, 'color', co.color,
            'archived', co.archived_at is not null
          )
          from public.field_choice_options co
          where co.workspace_id = v_workspace_id
            and co.field_definition_id = af.field_id
            and co.id = (t.values ->> af.key)::uuid
        )
        else t.values -> af.key
      end as value
    from target t
    cross join active_fields af
  )
  select
    t.id,
    coalesce((select jsonb_object_agg(fv.key, coalesce(fv.value, 'null'::jsonb)) from field_values fv), '{}'::jsonb),
    t.created_at,
    t.updated_at
  from target t;
end;
$$;

comment on function list_objects_for_api_key(text, integer, timestamptz, uuid)
  is 'Lists active EntityTypes for API-key read access, cursor-paginated. People-sensitive EntityTypes are never listed in Phase 12.2 -- no self/manager/author identity mapping exists for an API key.';

comment on function get_object_for_api_key(text, uuid)
  is 'Returns one EntityType''s metadata/fields for API-key read access. A people-sensitive EntityType returns no rows, identical to a nonexistent or archived one.';

comment on function list_records_for_api_key(text, uuid, integer, timestamptz, uuid)
  is 'Lists active records of one EntityType for API-key read access, cursor-paginated, active fields only. A people-sensitive EntityType returns no rows, identical to a nonexistent or archived one.';

comment on function get_record_for_api_key(text, uuid, uuid)
  is 'Returns one record''s active field values for API-key read access. A people-sensitive EntityType returns no rows, identical to a nonexistent or archived one.';
