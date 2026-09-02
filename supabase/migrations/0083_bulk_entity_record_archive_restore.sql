-- Phase 9.5: a narrow, purpose-built bulk archive/restore RPC. Confirmed by
-- grepping every migration for the name below that this is a genuinely new
-- function -- there is no prior definition to source from and nothing here
-- alters an existing policy or function.
--
-- Architecture, reviewed and revised before this migration was written:
--
-- Authority: the same `private.require_effective_interactive_workspace_capability`
-- every other interactive `_authorized` write RPC already calls (0068) --
-- records.operate, effective-user/impersonation-aware, no new authority
-- model invented.
--
-- Atomicity: a single `language plpgsql` function body executes inside the
-- caller's one implicit transaction -- any `raise exception` aborts
-- everything done so far, so this is genuinely all-or-nothing, not
-- "validate then hope nothing changed before the next statement." The
-- earlier draft of this design proposed `select count(*) ... for update`,
-- which Postgres rejects outright (FOR UPDATE cannot be combined with an
-- aggregate). Corrected shape: a plain, non-aggregate `select id ... for
-- update` subquery actually takes the row locks, and an outer
-- `array_agg(...)` over that already-locked result derives the found set.
-- Locking the exact matching rows first -- before comparing them against
-- the complete requested id set -- is what makes that comparison
-- trustworthy: nothing else can delete or move any of these specific rows
-- out from under this check before the UPDATE below runs, for the
-- lifetime of this transaction.
--
-- Boundary: workspace_id and entity_type_id are filtered explicitly on
-- both the locking query and the final UPDATE, not merely implied by an
-- intermediate id list -- a foreign-workspace, wrong-entity-type, or
-- nonexistent id is simply never found, which the count comparison
-- catches before anything is written.
--
-- Input validation, explicit rather than indirect: p_archived must not be
-- null (NULL must never silently fall through a `case when p_archived
-- then ... else null end` and be mistaken for "restore" -- rejected
-- up front instead); p_record_ids must be a non-empty array with no null
-- elements (a null element would otherwise never match any real row,
-- silently surfacing only as an indirect count mismatch rather than a
-- clear rejection). Duplicate (non-null) ids are normalized -- deduplicated
-- before comparing counts -- rather than rejected: archiving or restoring
-- the same record twice has no additional effect, so rejecting a
-- duplicate (e.g. from a UI double-submit) would only add friction without
-- protecting anything real.
--
-- No cascade, deletion, relation rewrite, or process mutation: only
-- entity_records.archived_at/updated_at are ever written, and only for a
-- row that actually changes state -- a record already archived (or already
-- active) inside a mixed batch is left with its original archived_at
-- untouched rather than bumped to now, so a no-op member of the batch never
-- has its own history rewritten to look like it changed just now. id,
-- values, created_at, and every entity_record_relation_values row are
-- untouched by construction either way, so restoring re-exposes the exact
-- same record identity and
-- history. The existing entity_records_process_condition_wait_wakeup
-- trigger (0038, `after ... update of values, archived_at`) already fires
-- on today's single-record archive/restore; this RPC's UPDATE fires it
-- identically per row -- inherited existing behavior, not a new cascade.
--
-- No inner/outer split: the two-layer pattern other record-write RPCs use
-- (a plain inner function plus a security definer `_authorized` wrapper)
-- exists because record create/update also needs a non-interactive call
-- path (workflow/automation-triggered writes). Nothing else will ever call
-- bulk archive/restore, so one small self-contained function is the right
-- size here, not a reflexive copy of the larger pattern.
create function set_entity_records_archived_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_ids uuid[],
  p_archived boolean
)
returns table (updated_record_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_ids uuid[];
  v_requested_count integer;
  v_locked_ids uuid[];
  v_locked_count integer;
  v_now timestamptz := now();
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if p_archived is null then
    raise exception 'p_archived must not be null';
  end if;

  if p_record_ids is null or array_length(p_record_ids, 1) is null then
    raise exception 'p_record_ids must be a non-empty array';
  end if;

  if exists (select 1 from unnest(p_record_ids) as id where id is null) then
    raise exception 'p_record_ids must not contain null elements';
  end if;

  select array_agg(distinct id) into v_record_ids from unnest(p_record_ids) as id;
  v_requested_count := array_length(v_record_ids, 1);

  -- Lock the actual matching rows first (a plain, non-aggregate select --
  -- FOR UPDATE cannot be combined with an aggregate directly), then derive
  -- the found set/count from that already-locked row set.
  select array_agg(locked.id) into v_locked_ids
  from (
    select id
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = any(v_record_ids)
    for update
  ) as locked;
  v_locked_count := coalesce(array_length(v_locked_ids, 1), 0);

  if v_locked_count <> v_requested_count then
    raise exception '% of % selected records could not be found in this object; nothing was changed.',
      v_requested_count - v_locked_count, v_requested_count;
  end if;

  -- Only rows not already in the target state are written -- a record
  -- already archived (or already active) inside the batch is left with its
  -- original archived_at/updated_at untouched, not bumped to now. The
  -- returned count is still the full validated request count: every
  -- selected record ends this call in the requested state, whether it
  -- just changed or already was, which is what the caller actually asked
  -- for -- but a no-op member of the batch never has its own history
  -- rewritten to look like it changed just now.
  update entity_records
  set archived_at = case when p_archived then v_now else null end,
      updated_at = v_now
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = any(v_locked_ids)
    and (archived_at is null) = p_archived;

  return query select v_requested_count;
end;
$$;

comment on function set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean)
  is 'Sets archived_at (and updated_at) for a complete, workspace/entity-type-validated set of records in one transaction -- all-or-nothing, no cascade, no relation rewrite. p_archived selects archive (true) vs restore (false); both directions share this one primitive.';

revoke all on function set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean) from public, anon;
grant execute on function set_entity_records_archived_authorized(uuid, uuid, uuid[], boolean) to authenticated, service_role;
