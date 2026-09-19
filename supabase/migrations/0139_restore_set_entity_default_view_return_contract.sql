-- Corrective migration for a contract regression in
-- 0137_choice_option_safe_delete.sql (applied to both development/E2E and
-- kinema-dogfood; 0137 and 0138 are not edited here, per this project's
-- immutable-migration convention).
--
-- 0137 redefined set_entity_default_view as SECURITY DEFINER (to keep it
-- working once direct authenticated UPDATE on entity_views was revoked),
-- with its own comment claiming the body was otherwise "byte-for-byte
-- identical" to the original (migration 0017). That claim was false in one
-- respect: 0017's function ended `return p_entity_type_id;` (always a
-- non-null uuid, since it's an already-validated required parameter);
-- 0137's redefinition silently changed this to `return p_view_id;`, which
-- is legitimately null whenever the call clears the default back to none.
--
-- Impact: lib/domain/view-repository.ts's setEntityDefaultView has always
-- treated any non-string RPC response as a malformed one ("unexpected RPC
-- response") -- correct against the original p_entity_type_id contract
-- (never null), but wrong against 0137's accidental p_view_id contract.
-- This was dormant until 0137 applied (the check never used to see a
-- null), then broke "clear the default view" through the UI on both
-- environments. Worked around temporarily at the JS layer (commit
-- 00a1973, accepting null alongside string); this migration restores the
-- original, intended contract instead, so that workaround is reverted in
-- the same commit as this file.
--
-- Fix: restore only the return statement to 0017's original contract.
-- Everything else -- the SECURITY DEFINER posture, the
-- require_effective_interactive_workspace_capability check, both
-- existence validations, both UPDATE statements -- is preserved exactly
-- as 0137 defined it; only the last line changes.

create or replace function set_entity_default_view(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_view_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if not exists (
    select 1
    from entity_types
    where workspace_id = p_workspace_id
      and id = p_entity_type_id
  ) then
    raise exception 'Entity type not found.';
  end if;

  if p_view_id is not null and not exists (
    select 1
    from entity_views
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_view_id
  ) then
    raise exception 'Default view must belong to this entity.';
  end if;

  update entity_views
  set is_default = false,
      updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and is_default;

  if p_view_id is not null then
    update entity_views
    set is_default = true,
        updated_at = now()
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_view_id;
  end if;

  return p_entity_type_id;
end;
$$;
