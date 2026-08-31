-- Phase 8F.3 follow-up, found by live verification after 0074 was applied:
-- list_records_for_api_key/get_record_for_api_key returned entity_records.
-- values as-is (overlaid with relation values), which means a field's value
-- written BEFORE it was archived stayed visible in the API response forever
-- -- entity_records.values is never pruned when a field is archived, so the
-- stale key was simply still sitting in the stored jsonb. get_object_for_
-- api_key already correctly excludes archived fields from its field list;
-- the record endpoints did not apply the same exclusion to record values,
-- violating the approved "active objects/fields/records only" scope.
--
-- Fix: both functions now build record_values by projecting onto the
-- entity type's currently-active field set (cross-joined against the page/
-- target record(s)), rather than passing the raw stored values jsonb
-- through. Every active field's key is always present -- a primitive field
-- with no value is `null`, a relation field with no linked target is
-- `null`, and (as before) a relation field with a linked target is
-- {id, label}. An archived field's key never appears, regardless of what
-- is still sitting in entity_records.values for it. Same search_path=''
-- posture and identical external signatures as 0074 (create or replace,
-- not a new function).
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
