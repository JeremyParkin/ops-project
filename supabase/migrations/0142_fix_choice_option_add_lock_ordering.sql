-- Corrective migration for a real concurrency defect in
-- 0141_safe_pristine_field_type_change.sql (applied to development/E2E
-- only so far; 0141 itself is not edited here, per this project's
-- immutable-migration convention).
--
-- 0141 hardened add_field_choice_option_core to take the shared entity-
-- type advisory lock before inserting a new option, so a concurrent safe
-- field-type change could no longer race a Choice-option creation. The
-- lock was added, but in the wrong position: the function's `type =
-- 'choice'` validity check ran in the SAME query used to resolve
-- entity_type_id for the lock, and that query runs BEFORE the lock is
-- acquired. A caller who read `type = 'choice'` as true, then waited on
-- the lock (held by a concurrent change_field_definition_type_if_safe_
-- authorized transaction changing the field away from Choice), proceeded
-- to insert the option anyway once the lock was released -- the type
-- check was never re-validated against the now-current, post-lock state.
--
-- Found via this migration's own real concurrent-pair test (lib/domain/
-- field-type-change-commit.test.ts, "Choice-option creation vs type
-- change"), which is exactly the class of proof this whole feature exists
-- to require -- not discovered by inspection alone. Confirmed live
-- against development: a field's type could be changed away from
-- 'choice' by one transaction while a concurrent add_field_choice_option
-- call, racing it, still successfully inserted a new field_choice_options
-- row for that now-non-choice field.
--
-- Fix: add_field_choice_option_core's initial lookup now only resolves
-- entity_type_id (for the lock) and confirms the field exists at all;
-- the `type = 'choice'` check is re-run as its own, separate check AFTER
-- the lock is acquired, against fresh, authoritative state. Every other
-- statement in the function -- position computation, the insert itself,
-- the exact "Choice field not found" exception text and its use as the
-- generic not-found message -- is unchanged.
--
-- update/archive/restore_field_choice_option_core were inspected as part
-- of diagnosing this and do not share the defect: none of them can change
-- whether any field_choice_options row exists for a field (archive/
-- restore only flip archived_at on an already-existing row; update only
-- rewrites label/color on one), so none of them can move a field from
-- "zero options" to "one or more" the way add can -- there is nothing to
-- re-check under lock for them, and their existing lock (added correctly,
-- before their own row lookups) is unaffected and left exactly as 0141
-- defined it.

create or replace function add_field_choice_option_core(
  p_workspace_id uuid,
  p_field_definition_id uuid,
  p_label text,
  p_color text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_option_id uuid := gen_random_uuid();
  v_next_position integer;
  v_entity_type_id uuid;
begin
  select entity_type_id
    into v_entity_type_id
  from field_definitions
  where workspace_id = p_workspace_id
    and id = p_field_definition_id;

  if not found then
    raise exception 'Choice field not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_entity_type_id::text, 0));

  -- Re-validated under lock: the field's type could have changed while
  -- this call waited for the lock (e.g. a concurrent safe field-type
  -- change away from Choice, migration 0141) -- the lookup above, taken
  -- before the lock, is not authoritative.
  if not exists (
    select 1 from field_definitions
    where workspace_id = p_workspace_id
      and id = p_field_definition_id
      and type = 'choice'
  ) then
    raise exception 'Choice field not found';
  end if;

  select coalesce(max(position), 0) + 1
    into v_next_position
  from field_choice_options
  where workspace_id = p_workspace_id
    and field_definition_id = p_field_definition_id;

  insert into field_choice_options (
    id, workspace_id, field_definition_id, label, color, position
  )
  values (
    v_option_id, p_workspace_id, p_field_definition_id, trim(p_label), p_color, v_next_position
  );

  return v_option_id;
end;
$$;
