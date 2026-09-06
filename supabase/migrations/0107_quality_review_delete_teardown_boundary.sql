-- Phase 12.3.1 corrective migration: makes the existing workspace/type
-- teardown behavior of the Finalized-delete protection explicit rather
-- than an accident of Postgres's internal cascade-processing order.
-- 0105/0106 remain untouched and immutable; delete_entity_type_if_safe
-- (0098) is untouched too -- it still unconditionally refuses to delete
-- an EntityType while any record of it exists, on the sanctioned,
-- product-facing route. This migration only concerns what happens once a
-- parent has *already* been deleted and is cascading its children.
--
-- Investigation: entity_records has TWO real parent-cascade paths that
-- can physically remove a row -- workspace -> entity_records (workspace_
-- id references workspaces(id) on delete cascade, 0001) and entity_type
-- -> entity_records ((workspace_id, entity_type_id) references entity_
-- types(workspace_id, id) on delete cascade, also 0001). private.
-- enforce_quality_review_lifecycle_delete determines whether a row is
-- even a Quality Review at all by looking up its entity_types row for
-- `quality_review = true`. Empirically reproduced with disposable
-- fixtures: both a raw workspace delete AND a raw entity-type delete
-- (bypassing delete_entity_type_if_safe entirely, to isolate the cascade
-- itself) cascade straight through a Finalized Quality Review record
-- with NO error -- because by the time entity_records' own trigger fires
-- as part of either cascade, the entity_types row it needs to query is
-- already gone, so the lookup finds nothing and the trigger (correctly,
-- but only by construction, not by design) treats the row as "not a
-- recognized Quality Review" and lets it through.
--
-- This currently produces the desired outcome for both cascades (a real
-- parent teardown is not blocked by historical Quality Review data), but
-- it depends on Postgres happening to process each parent's cascade
-- before entity_records' own direct workspace_id cascade fires for the
-- same row -- not a documented, guaranteed ordering across multiple FK
-- paths to the same table. Making both cases explicit removes that
-- fragility without changing today's actual, verified behavior for
-- either cascade.
--
-- The correction checks the WORKSPACE's and the ENTITY TYPE's own
-- existence, not the caller's role or capability -- a service_role (or
-- any other) caller attempting to delete one specific Finalized review
-- while its workspace and EntityType both still exist is still rejected
-- exactly as before; only genuine teardown (the record's own parent
-- workspace or EntityType is already gone) skips the check. Trusted
-- system/cascade authority is never conflated with interactive-user or
-- governance authority here -- this is a fact about the row's own parent
-- rows, not a grant to any actor.

create or replace function private.enforce_quality_review_lifecycle_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_et public.entity_types%rowtype;
  v_status_key text;
  v_status uuid;
  v_is_reviewer boolean;
  v_has_governance boolean;
begin
  if not exists (select 1 from public.workspaces where id = old.workspace_id) then
    return old; -- workspace/system teardown
  end if;

  if not exists (
    select 1 from public.entity_types
    where workspace_id = old.workspace_id and id = old.entity_type_id
  ) then
    return old; -- entity-type/system teardown
  end if;

  select * into v_et
  from public.entity_types et
  where et.workspace_id = old.workspace_id
    and et.id = old.entity_type_id
    and et.quality_review = true;

  if not found then
    return old; -- not a Quality Review type at all
  end if;

  select fd.key into v_status_key
  from public.field_definitions fd
  where fd.id = v_et.quality_review_status_field_id;

  begin
    v_status := (old.values ->> v_status_key)::uuid;
  exception
    when invalid_text_representation then
      v_status := null;
  end;

  if v_status = v_et.quality_review_finalized_option_id then
    raise exception 'A finalized Quality Review cannot be deleted.';
  end if;

  v_has_governance := private.has_people_data_governance_authority(old.workspace_id);
  v_is_reviewer := exists (
    select 1
    from public.entity_record_relation_values arv
    join public.entity_record_person_links apl
      on apl.workspace_id = arv.workspace_id
      and apl.entity_record_id = arv.target_record_id
    where arv.workspace_id = old.workspace_id
      and arv.source_record_id = old.id
      and arv.field_definition_id = v_et.author_person_field_id
      and apl.user_id = private.current_effective_user(old.workspace_id)
  );

  if not (v_is_reviewer or v_has_governance) then
    raise exception 'Only the designated Reviewer, or a privileged administrator, may delete a Draft Quality Review.';
  end if;

  return old;
end;
$$;
