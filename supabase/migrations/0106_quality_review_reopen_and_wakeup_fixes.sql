-- Phase 12.3.1 corrective migration: two defects found running the live
-- focused DB/RPC suite against applied 0105. 0100-0105 remain untouched
-- and immutable; both fixes are `create or replace function` here.
--
-- Defect 1 (introduced by 0105): private.enforce_quality_review_lifecycle_
-- mutation checked "is the record currently Finalized" and raised its
-- unconditional edit-blocked exception BEFORE checking whether this
-- specific UPDATE was a legitimate Finalized -> Draft transition. Since
-- Reopen's own UPDATE necessarily starts from a Finalized record, this
-- unconditionally rejected every Reopen attempt with "...can no longer be
-- edited. Use Reopen to make corrections." -- Reopen was completely
-- broken, confirmed empirically (reopen_quality_review_authorized failed
-- 100% of the time). Fix: check whether the status is actually changing
-- FIRST; the finalized blanket-block now applies only to the "status
-- unchanged" (ordinary content edit) branch, exactly as originally
-- intended. The two other guards in that branch -- rejecting any other
-- content change bundled into the same statement as a status transition,
-- and validating the transition is exactly Draft->Finalized (Reviewer) or
-- Finalized->Draft (governance) -- are unchanged, just correctly reached
-- for a genuine transition attempt now.
--
-- Defect 2 (pre-existing, in applied 0038, exposed for the first time by
-- this phase): private.enqueue_process_condition_wait_relation_change is
-- an AFTER INSERT OR UPDATE OR DELETE trigger on entity_record_relation_
-- values. Deleting an entity_records row that itself holds outgoing
-- relations (as every Quality Review necessarily does -- its own subject/
-- reviewer relations) cascade-deletes those relation rows, firing this
-- trigger per row; it then unconditionally inserts a
-- process_condition_wait_wakeups row referencing the just-deleted parent
-- record, which violates that table's own FK to entity_records (confirmed:
-- "insert or update on table process_condition_wait_wakeups violates
-- foreign key constraint ...", reproduced by delete_entity_record_if_
-- unreferenced_authorized on any record holding outgoing relations).
-- delete_entity_record_if_unreferenced only ever blocked on INCOMING
-- references, never checked or needed to care about a record's own
-- OUTGOING relations, so this was always a latent gap -- simply never
-- exercised, since no prior test hard-deleted a record that still held
-- relations of its own. The function already has an identical defensive
-- pattern for the "workspace itself is gone" cascade case; this adds the
-- same defensive check for "the source record itself is gone" (a strict
-- superset in practice, since a workspace/entity-type cascade also leaves
-- the record gone -- kept as a second, additional check rather than
-- replacing the existing one, so no already-tested behavior changes).
-- Full latest body (0038, its only prior definition) reproduced faithfully.

create or replace function private.enforce_quality_review_lifecycle_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_et public.entity_types%rowtype;
  v_status_key text;
  v_old_status uuid;
  v_new_status uuid;
  v_archived_changed boolean;
  v_content_changed boolean;
  v_is_reviewer boolean;
  v_has_governance boolean;
begin
  select * into v_et
  from public.entity_types et
  where et.workspace_id = new.workspace_id
    and et.id = new.entity_type_id
    and et.quality_review = true;

  if not found then
    return new;
  end if;

  select fd.key into v_status_key
  from public.field_definitions fd
  where fd.id = v_et.quality_review_status_field_id;

  begin
    v_old_status := (old.values ->> v_status_key)::uuid;
  exception
    when invalid_text_representation then
      v_old_status := null;
  end;
  begin
    v_new_status := (new.values ->> v_status_key)::uuid;
  exception
    when invalid_text_representation then
      v_new_status := null;
  end;

  v_archived_changed := (old.archived_at is distinct from new.archived_at);
  v_content_changed := (old.values is distinct from new.values);

  v_is_reviewer := exists (
    select 1
    from public.entity_record_relation_values arv
    join public.entity_record_person_links apl
      on apl.workspace_id = arv.workspace_id
      and apl.entity_record_id = arv.target_record_id
    where arv.workspace_id = new.workspace_id
      and arv.source_record_id = new.id
      and arv.field_definition_id = v_et.author_person_field_id
      and apl.user_id = private.current_effective_user(new.workspace_id)
  );
  v_has_governance := private.has_people_data_governance_authority(new.workspace_id);

  if v_archived_changed then
    if v_old_status is distinct from v_new_status then
      raise exception 'A Quality Review''s lifecycle status cannot change in the same operation as archiving or restoring it.';
    end if;

    if v_old_status = v_et.quality_review_finalized_option_id then
      if not v_has_governance then
        if new.archived_at is not null then
          raise exception 'Only a privileged administrator may archive a Finalized Quality Review.';
        else
          raise exception 'Only a privileged administrator may restore a Finalized Quality Review.';
        end if;
      end if;
    else
      if not (v_is_reviewer or v_has_governance) then
        if new.archived_at is not null then
          raise exception 'Only the designated Reviewer, or a privileged administrator, may archive a Draft Quality Review.';
        else
          raise exception 'Only the designated Reviewer, or a privileged administrator, may restore a Draft Quality Review.';
        end if;
      end if;
    end if;

    return new;
  end if;

  if not v_content_changed then
    return new;
  end if;

  -- Phase 12.3.1 corrective fix (0106): check whether a status transition
  -- is actually being attempted BEFORE applying the unconditional
  -- Finalized edit-block -- Reopen's own UPDATE always starts from
  -- Finalized, and must reach its own dedicated validation below rather
  -- than being rejected outright by the blanket block meant for ordinary
  -- content edits only.
  if v_old_status is distinct from v_new_status then
    if (new.values - v_status_key) is distinct from (old.values - v_status_key) then
      raise exception 'A Quality Review''s lifecycle status cannot change in the same operation as other content.';
    end if;

    if v_old_status = v_et.quality_review_draft_option_id and v_new_status = v_et.quality_review_finalized_option_id then
      if not v_is_reviewer then
        raise exception 'Only the designated Reviewer may finalize this Quality Review.';
      end if;
    elsif v_old_status = v_et.quality_review_finalized_option_id and v_new_status = v_et.quality_review_draft_option_id then
      if not v_has_governance then
        raise exception 'Reopening a finalized Quality Review requires additional privileges.';
      end if;
    else
      raise exception 'This Quality Review status transition is not permitted.';
    end if;
  else
    if v_old_status = v_et.quality_review_finalized_option_id then
      raise exception 'This Quality Review has been finalized and can no longer be edited. Use Reopen to make corrections.';
    end if;

    if not v_is_reviewer then
      raise exception 'Only the designated Reviewer may edit this Draft Quality Review.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.enqueue_process_condition_wait_relation_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row entity_record_relation_values%rowtype;
begin
  v_row := case when TG_OP = 'DELETE' then OLD else NEW end;
  -- Workspace cascades can delete relation rows after the parent workspace
  -- is gone. Normal relation replacement/clearing still needs a wakeup.
  if not exists (select 1 from workspaces where id = v_row.workspace_id) then
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
  end if;
  -- Phase 12.3.1 corrective fix (0106): the source record itself can also
  -- already be gone -- a hard-deleted record's own outgoing relations are
  -- cascade-deleted by this same statement, and by the time this AFTER
  -- DELETE trigger fires for that cascaded row, the parent entity_records
  -- row it would reference no longer exists, which previously violated
  -- process_condition_wait_wakeups' own FK to entity_records outright.
  -- There is nothing meaningful to wake up for a record that no longer
  -- exists, so this is skipped exactly like the workspace-gone case above.
  if not exists (
    select 1 from entity_records
    where workspace_id = v_row.workspace_id
      and entity_type_id = v_row.source_entity_type_id
      and id = v_row.source_record_id
  ) then
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
  end if;
  perform private.enqueue_process_condition_wait_wakeup(v_row.workspace_id, v_row.source_entity_type_id, v_row.source_record_id, v_row.field_definition_id, 'relation_changed');
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;
