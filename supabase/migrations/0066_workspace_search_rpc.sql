-- Phase 8D.4: push global Search's filtering, ranking, and per-entity-type
-- cap into Postgres instead of fetching every active record in the
-- workspace into Node and matching/ranking/slicing in JavaScript.
--
-- Architecture: one query-time SQL pushdown, no new column, no new
-- extension. Case-insensitive substring matching (`lower(...) like
-- '%query%'`) is preserved exactly as the pre-existing JS behavior --
-- deliberately NOT full-text search (tsvector/to_tsquery match whole/
-- stemmed lexemes, not arbitrary mid-word substrings like "cme" inside
-- "Acme", so it would silently change matching behavior) and deliberately
-- NOT a trigram-indexed projection (unjustified until the Phase 8D.4 scale
-- benchmark shows plain substring matching over the existing
-- (workspace_id, entity_type_id, archived_at) index is actually too slow;
-- see docs/PROJECT_CONTEXT.md's Phase 8D.4 section for the measured
-- numbers this decision was based on).
--
-- Only `type = 'text'`, non-archived fields on non-archived entity types are
-- ever searchable -- numbers/dates/booleans/relation UUIDs are never
-- matched just because they happen to live in the same values jsonb blob.
--
-- Ranking mirrors the pre-existing JS ranking exactly for its three
-- meaningful signals (identity/display-field match first, prefix match
-- beats weaker substring match, then field position), with one disclosed
-- simplification for the rare remaining tie: the JS version's final
-- tiebreak was the record's full display label; this version orders ties by
-- the identity field's raw value (falling back to record id) rather than
-- replicating getRecordLabel's complete empty-value/shortened-id fallback
-- chain in SQL for what is, by that point, an already-fully-tied ordering
-- with no meaningful ranking signal left to differentiate.
create or replace function search_workspace_records_authorized(
  p_workspace_id uuid,
  p_query text,
  p_entity_type_id uuid default null,
  p_limit_per_type integer default 20
)
returns table (
  entity_type_id uuid,
  record_id uuid,
  matched_field_id uuid,
  matched_field_name text,
  is_identity_match boolean,
  is_prefix_match boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_query text;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if p_limit_per_type is null or p_limit_per_type < 1 or p_limit_per_type > 100 then
    raise exception 'Search limit per entity type must be between 1 and 100';
  end if;

  v_query := lower(btrim(coalesce(p_query, '')));

  if v_query = '' then
    return;
  end if;

  -- LIKE's own wildcard characters (and its default escape character
  -- itself) must be escaped, or a literal "%"/"_" typed by the user would
  -- be interpreted as a wildcard rather than matched as plain text --
  -- preserving the old JS `.includes()`'s literal-substring semantics
  -- exactly, not just approximately.
  v_query := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  with identity_fields as (
    -- The same resolution order as getRecordIdentityField: the configured
    -- display field if it's still a live text field, else the first
    -- non-archived text field by position. Resolved once per entity type
    -- here (both id and key), not re-derived per candidate field below.
    select
      et.id as entity_type_id,
      coalesce(configured.id, fallback.id) as identity_field_id,
      coalesce(configured.key, fallback.key) as identity_key
    from entity_types et
    left join field_definitions configured
      on configured.workspace_id = p_workspace_id
      and configured.id = et.display_field_definition_id
      and configured.type = 'text'
      and configured.archived_at is null
    left join lateral (
      select fd.id, fd.key from field_definitions fd
      where fd.workspace_id = p_workspace_id
        and fd.entity_type_id = et.id
        and fd.type = 'text'
        and fd.archived_at is null
      order by fd.position, fd.id
      limit 1
    ) fallback on configured.id is null
    where et.workspace_id = p_workspace_id
      and et.archived_at is null
      and (p_entity_type_id is null or et.id = p_entity_type_id)
  ),
  matches as (
    select
      er.entity_type_id,
      er.id as record_id,
      best.field_id as matched_field_id,
      best.field_name as matched_field_name,
      best.field_position as matched_field_position,
      best.is_identity as is_identity_match,
      best.is_prefix as is_prefix_match,
      coalesce(er.values ->> idf.identity_key, '') as tiebreak_value
    from entity_records er
    join identity_fields idf on idf.entity_type_id = er.entity_type_id
    join lateral (
      select
        fd.id as field_id,
        fd.name as field_name,
        fd.position as field_position,
        (fd.id = idf.identity_field_id) as is_identity,
        (lower(er.values ->> fd.key) like v_query || '%') as is_prefix
      from field_definitions fd
      where fd.workspace_id = p_workspace_id
        and fd.entity_type_id = er.entity_type_id
        and fd.type = 'text'
        and fd.archived_at is null
        and er.values ? fd.key
        and lower(er.values ->> fd.key) like '%' || v_query || '%'
      order by
        (fd.id = idf.identity_field_id) desc,
        (lower(er.values ->> fd.key) like v_query || '%') desc,
        fd.position asc,
        fd.id asc
      limit 1
    ) best on true
    where er.workspace_id = p_workspace_id
      and er.archived_at is null
  ),
  ranked as (
    select
      m.*,
      row_number() over (
        partition by m.entity_type_id
        order by
          m.is_identity_match desc,
          m.is_prefix_match desc,
          m.matched_field_position asc,
          m.tiebreak_value asc,
          m.record_id asc
      ) as rn
    from matches m
  )
  select
    ranked.entity_type_id,
    ranked.record_id,
    ranked.matched_field_id,
    ranked.matched_field_name,
    ranked.is_identity_match,
    ranked.is_prefix_match
  from ranked
  where ranked.rn <= p_limit_per_type
  order by ranked.entity_type_id, ranked.rn;
end;
$$;

revoke all on function search_workspace_records_authorized(uuid, text, uuid, integer) from public, anon;
grant execute on function search_workspace_records_authorized(uuid, text, uuid, integer) to authenticated, service_role;
