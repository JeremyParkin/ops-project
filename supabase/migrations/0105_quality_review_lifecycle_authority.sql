-- Phase 12.3.1: Quality Review Lifecycle & Authority.
--
-- Approved architecture (narrow, Quality-Review-specific -- not a generic
-- EntityType finality framework): entity_types gains four new columns
-- (quality_review, quality_review_status_field_id, quality_review_draft_
-- option_id, quality_review_finalized_option_id), structurally FK-scoped
-- and CHECK-constrained so a Quality Review EntityType always has a
-- complete, consistent configuration -- reusing 12.2's subject_person_
-- field_id/author_person_field_id metadata rather than duplicating it.
-- Storage remains ordinary EntityRecords/field_definitions/field_choice_
-- options throughout; no special table is introduced.
--
-- Enforcement is layered exactly like 12.2: RLS/read-time checks stay in
-- private.can_view_people_sensitive_record (narrowed only for the two
-- branches that must not see a Draft), while all write-authority (content
-- edit, archive, restore, Finalize, Reopen) is enforced by a new BEFORE
-- UPDATE trigger on entity_records, private.enforce_quality_review_
-- lifecycle_mutation -- a trigger, not RLS or an RPC-only check, because
-- create_entity_record_with_relations/update_entity_record_with_relations
-- are SECURITY INVOKER (RLS-reachable in principle) but are only ever
-- actually invoked through this schema's SECURITY DEFINER `_authorized`
-- wrappers (0068's update_entity_record_with_relations_authorized, etc.),
-- which run under an elevated role that does not necessarily observe
-- entity_records' own RLS policies. A table-level trigger fires for every
-- UPDATE regardless of role or RLS applicability, so it is the only
-- mechanism that cannot be bypassed by a bulk path, a security-definer
-- wrapper, or a direct table write alike. Hard delete is a separate SQL
-- command a BEFORE UPDATE trigger cannot reach at all, so delete
-- authority (Draft: Reviewer or governance; Finalized: blocked for
-- everyone) is enforced by its own sibling trigger, private.enforce_
-- quality_review_lifecycle_delete, on the same table.
--
-- Every function body below is reproduced in full from its exact latest
-- canonical definition (0101 for the three sensitive-record RPCs, 0100 for
-- can_view_people_sensitive_record/set_entity_type_people_sensitive_
-- access_authorized/reject_archiving_designated_sensitive_field, 0094 for
-- list_record_activity_authorized), with only the intended new checks
-- added -- no signature or return-shape change anywhere, so every function
-- uses `create or replace function`.

-- 1. Quality Review EntityType metadata. All FK/CHECK-enforced -- no
-- label/slug inference anywhere; every designation is an explicit id.
alter table entity_types
  add column if not exists quality_review boolean not null default false,
  add column if not exists quality_review_status_field_id uuid,
  add column if not exists quality_review_draft_option_id uuid,
  add column if not exists quality_review_finalized_option_id uuid;

-- Status field must belong to this exact entity type/workspace -- reuses
-- the (workspace_id, entity_type_id, id) unique key 0100 already added for
-- subject_person_field_id/author_person_field_id.
alter table entity_types
  drop constraint if exists entity_types_quality_review_status_field_fk;
alter table entity_types
  add constraint entity_types_quality_review_status_field_fk
  foreign key (workspace_id, id, quality_review_status_field_id)
  references field_definitions (workspace_id, entity_type_id, id)
  on delete restrict;

-- Draft/Finalized options must belong to the exact designated status
-- field -- a composite FK against field_choice_options' own
-- (workspace_id, field_definition_id, id) key, evaluated against this
-- row's own quality_review_status_field_id column, so it stays correct
-- even if the status field designation is later changed (re-validated by
-- the configuration RPC below, never silently left dangling).
alter table entity_types
  drop constraint if exists entity_types_quality_review_draft_option_fk;
alter table entity_types
  add constraint entity_types_quality_review_draft_option_fk
  foreign key (workspace_id, quality_review_status_field_id, quality_review_draft_option_id)
  references field_choice_options (workspace_id, field_definition_id, id)
  on delete restrict;

alter table entity_types
  drop constraint if exists entity_types_quality_review_finalized_option_fk;
alter table entity_types
  add constraint entity_types_quality_review_finalized_option_fk
  foreign key (workspace_id, quality_review_status_field_id, quality_review_finalized_option_id)
  references field_choice_options (workspace_id, field_definition_id, id)
  on delete restrict;

-- Structural invariant: quality_review may only be true when the complete
-- configuration exists together -- people_sensitive, both subject/author
-- fields, author_can_view (Reviewer visibility is intrinsic to Quality
-- Review, never a second toggle), and a fully-specified, internally
-- distinct status/draft/finalized triple. The configuration RPC below
-- validates every one of these with a clean message before ever reaching
-- this constraint; this is the structural backstop, not the primary UX.
alter table entity_types
  drop constraint if exists entity_types_quality_review_invariant_check;
alter table entity_types
  add constraint entity_types_quality_review_invariant_check
  check (
    not quality_review
    or (
      people_sensitive
      and subject_person_field_id is not null
      and author_person_field_id is not null
      and author_can_view
      and quality_review_status_field_id is not null
      and quality_review_draft_option_id is not null
      and quality_review_finalized_option_id is not null
      and quality_review_draft_option_id <> quality_review_finalized_option_id
    )
  );

-- 2. Governance authority -- ONE shared underlying predicate, so the
-- existing raising require_people_data_governance_authority (0100) and the
-- new boolean has_people_data_governance_authority (needed for trigger/
-- predicate contexts, where raising is not usable) cannot drift into two
-- subtly different definitions of "people-data governance authority."
-- private.is_impersonating_in_workspace is the single source of truth for
-- the impersonation check; the people_data.view_all capability check is
-- the identical literal expression in both functions below (evaluated
-- against auth.uid(), the real actor, never the effective/impersonated
-- identity -- there is no effective-user privilege leakage here, and a
-- service_role caller with no session, where auth.uid() is null, holds no
-- capability and so never qualifies as a governance actor either).
-- require_people_data_governance_authority itself IS redefined here (0105
-- is unapplied, so this is a normal create-or-replace, not an edit to
-- applied 0100 SQL) purely to delegate to this shared predicate --
-- its two distinct error messages ("not available while impersonating"
-- vs. "requires additional privileges") are preserved verbatim for its
-- existing subject/author-reassignment call sites; no caller-visible
-- behavior changes.
create or replace function private.is_impersonating_in_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  )
$$;

revoke all on function private.is_impersonating_in_workspace(uuid) from public, anon, authenticated;
grant execute on function private.is_impersonating_in_workspace(uuid) to authenticated, service_role;

create or replace function private.has_people_data_governance_authority(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    not private.is_impersonating_in_workspace(p_workspace_id)
    and private.has_workspace_capability_as(p_workspace_id, 'people_data.view_all', auth.uid())
$$;

revoke all on function private.has_people_data_governance_authority(uuid) from public, anon, authenticated;
grant execute on function private.has_people_data_governance_authority(uuid) to authenticated, service_role;

create or replace function private.require_people_data_governance_authority(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if private.is_impersonating_in_workspace(p_workspace_id) then
    raise exception 'Changing who can access this record is not available while impersonating';
  end if;

  if not private.has_workspace_capability_as(p_workspace_id, 'people_data.view_all', auth.uid()) then
    raise exception 'Changing who can access this record requires additional privileges';
  end if;
end;
$$;

-- 3. private.quality_review_status_option: resolves a record's current
-- stored status value to the option id it represents, or null for a
-- non-Quality-Review type or an unrecognized/unset value. plpgsql with an
-- explicit exception handler (not a plain SQL function) because this is
-- called from read/write paths where a malformed stored value must never
-- abort the whole calling query -- it is treated as "unrecognized," not a
-- hard error, at this layer; the entity_records write-authority trigger
-- below is what actually enforces that only recognized values can ever be
-- written in the first place.
create or replace function private.quality_review_status_option(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status_key text;
  v_raw text;
begin
  select fd.key into v_status_key
  from entity_types et
  join field_definitions fd on fd.id = et.quality_review_status_field_id
  where et.workspace_id = p_workspace_id
    and et.id = p_entity_type_id
    and et.quality_review = true;

  if not found then
    return null;
  end if;

  select values ->> v_status_key into v_raw
  from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  if v_raw is null then
    return null;
  end if;

  return v_raw::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;

revoke all on function private.quality_review_status_option(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function private.quality_review_status_option(uuid, uuid, uuid) to authenticated, service_role;

-- 4. private.can_view_people_sensitive_record (latest body: 0100). Only
-- the subject and manager branches gain one new conjunct each -- a Draft
-- Quality Review is not visible via subject_can_view/manager_can_view,
-- full stop, regardless of those toggles. The author (Reviewer) branch and
-- the privileged-override branch are completely untouched: Reviewer
-- visibility is intrinsic to Quality Review (author_can_view is
-- structurally required true by the invariant above), so it already
-- covers both Draft and Finalized with no special-casing, and the
-- privileged override was never state-dependent. For any non-Quality-
-- Review type, `not et.quality_review` makes the new conjunct
-- unconditionally true -- byte-for-byte identical behavior to 12.2.
create or replace function private.can_view_people_sensitive_record(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_effective_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      not et.people_sensitive
      or (
        private.has_workspace_capability_as(p_workspace_id, 'people_data.view_all', (select auth.uid()))
        and (select auth.uid()) = p_effective_user_id
      )
      or (
        subject.linked_user_id is not null
        and (
          (
            et.subject_can_view
            and subject.linked_user_id = p_effective_user_id
            and (
              not et.quality_review
              or private.quality_review_status_option(p_workspace_id, p_entity_type_id, p_record_id) = et.quality_review_finalized_option_id
            )
          )
          or (
            et.manager_can_view
            and exists (
              select 1
              from public.workspace_reporting_relationships wrr
              where wrr.workspace_id = p_workspace_id
                and wrr.report_user_id = subject.linked_user_id
                and wrr.relationship_kind = 'primary_manager'
                and wrr.manager_user_id = p_effective_user_id
            )
            and (
              not et.quality_review
              or private.quality_review_status_option(p_workspace_id, p_entity_type_id, p_record_id) = et.quality_review_finalized_option_id
            )
          )
          or (
            et.author_can_view
            and et.author_person_field_id is not null
            and exists (
              select 1
              from public.entity_record_relation_values arv
              join public.entity_record_person_links apl
                on apl.workspace_id = arv.workspace_id
                and apl.entity_record_id = arv.target_record_id
              where arv.workspace_id = p_workspace_id
                and arv.source_record_id = p_record_id
                and arv.field_definition_id = et.author_person_field_id
                and apl.user_id = p_effective_user_id
            )
          )
        )
      )
    from public.entity_types et
    left join lateral (
      select apl.user_id as linked_user_id
      from public.entity_record_relation_values srv
      join public.entity_record_person_links apl
        on apl.workspace_id = srv.workspace_id
        and apl.entity_record_id = srv.target_record_id
      where srv.workspace_id = p_workspace_id
        and srv.source_record_id = p_record_id
        and srv.field_definition_id = et.subject_person_field_id
      limit 1
    ) subject on true
    where et.workspace_id = p_workspace_id
      and et.id = p_entity_type_id
  ), false)
$$;

comment on function private.can_view_people_sensitive_record(uuid, uuid, uuid, uuid)
  is 'Phase 12.2 sensitive-record read authorization, extended in 12.3.1: for a Quality Review EntityType specifically, the subject and manager branches additionally require the record to be Finalized -- a Draft is visible only to its designated Reviewer or a privileged non-impersonating viewer. Non-sensitive and non-Quality-Review-sensitive types are unaffected.';

-- 5. create_entity_record_with_relations (latest body: 0101). Two Quality
-- Review additions, both scoped behind `if v_entity_type.quality_review`:
-- (a) Reviewer self-binding -- an ordinary caller may only create a
-- Quality Review naming their own linked Person record as Reviewer; a
-- caller with no linked Person is rejected truthfully; naming a different
-- Person as Reviewer requires the existing people-data governance
-- authority (real-actor-only, unavailable while impersonating, per
-- private.has_people_data_governance_authority above) -- this is the
-- approved narrow "create on behalf" path, not a second RPC. Self-review
-- (subject = reviewer) is deliberately NOT prohibited. (b) the record
-- always starts in the configured Draft status: an omitted status value is
-- populated as Draft, an explicitly-supplied Draft value is accepted, and
-- any other supplied value is rejected outright -- an ordinary caller can
-- never create directly into Finalized.
create or replace function create_entity_record_with_relations(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_record_id uuid;
  v_existing_id uuid;
  v_relation jsonb;
  v_field field_definitions%rowtype;
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_entity_type entity_types%rowtype;
  v_status_key text;
  v_linked_person_id uuid;
  v_supplied_reviewer_id uuid;
  v_supplied_status_id uuid;
begin
  if p_relations is null or jsonb_typeof(p_relations) <> 'array' then
    raise exception 'p_relations must be a JSON array';
  end if;

  if p_originating_process_step_run_id is not null then
    select id into v_existing_id from entity_records
    where workspace_id = p_workspace_id and originating_process_step_run_id = p_originating_process_step_run_id;
    if found then
      return v_existing_id;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  select * into v_entity_type
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id;

  -- Phase 12.3.1 addition: Quality Review reviewer self-binding and
  -- forced Draft status on creation.
  if v_entity_type.quality_review then
    select apl.entity_record_id into v_linked_person_id
    from entity_record_person_links apl
    where apl.workspace_id = p_workspace_id
      and apl.user_id = private.current_effective_user(p_workspace_id);

    select (relation ->> 'target_record_id')::uuid into v_supplied_reviewer_id
    from jsonb_array_elements(p_relations) relation
    where relation ->> 'field_definition_id' = v_entity_type.author_person_field_id::text;

    if v_linked_person_id is null or v_supplied_reviewer_id is distinct from v_linked_person_id then
      if not private.has_people_data_governance_authority(p_workspace_id) then
        if v_linked_person_id is null then
          raise exception 'You must be linked to a workspace Person record to create a Quality Review as its Reviewer';
        else
          raise exception 'You may only create a Quality Review naming yourself as the Reviewer, unless you hold additional privileges';
        end if;
      end if;
    end if;

    select fd.key into v_status_key
    from field_definitions fd
    where fd.id = v_entity_type.quality_review_status_field_id;

    if v_values ? v_status_key and (v_values -> v_status_key) <> 'null'::jsonb then
      begin
        v_supplied_status_id := (v_values ->> v_status_key)::uuid;
      exception
        when invalid_text_representation then
          raise exception 'New Quality Reviews must start in the configured Draft status';
      end;

      if v_supplied_status_id is distinct from v_entity_type.quality_review_draft_option_id then
        raise exception 'New Quality Reviews must start in the configured Draft status';
      end if;
    end if;

    v_values := jsonb_set(v_values, array[v_status_key], to_jsonb(v_entity_type.quality_review_draft_option_id::text), true);
  end if;

  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and required = true
      and archived_at is null
    order by position
  loop
    if v_field.type = 'relation' then
      if not exists (
        select 1
        from jsonb_array_elements(p_relations) relation
        where relation ->> 'field_definition_id' = v_field.id::text
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'text' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'string'
        and btrim(v_values ->> v_field.key) <> ''
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'number' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'number'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'date' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'string'
        and v_values ->> v_field.key ~ '^\d{4}-\d{2}-\d{2}$'
        and to_char(to_date(v_values ->> v_field.key, 'YYYY-MM-DD'), 'YYYY-MM-DD') =
          v_values ->> v_field.key
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'boolean' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'boolean'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'choice' then
      if not (
        v_values ? v_field.key
        and jsonb_typeof(v_values -> v_field.key) = 'string'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    end if;
  end loop;

  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and type = 'choice'
      and archived_at is null
  loop
    if v_values ? v_field.key and v_values -> v_field.key <> 'null'::jsonb then
      begin
        if jsonb_typeof(v_values -> v_field.key) <> 'string'
          or not exists (
            select 1 from field_choice_options
            where workspace_id = p_workspace_id
              and field_definition_id = v_field.id
              and id = (v_values ->> v_field.key)::uuid
              and archived_at is null
          )
        then
          raise exception '% must reference an active option.', v_field.name;
        end if;
      exception
        when invalid_text_representation then
          raise exception '% must reference an active option.', v_field.name;
      end;
    end if;
  end loop;

  for v_relation in select * from jsonb_array_elements(p_relations)
  loop
    begin
      select * into v_field
      from field_definitions
      where workspace_id = p_workspace_id
        and id = (v_relation ->> 'field_definition_id')::uuid
        and type = 'relation';

      if not found
        or v_field.related_entity_type_id is distinct from (v_relation ->> 'target_entity_type_id')::uuid
      then
        raise exception 'A relation must reference its own configured related object.';
      end if;

      if not exists (
        select 1 from entity_records
        where workspace_id = p_workspace_id
          and entity_type_id = v_field.related_entity_type_id
          and id = (v_relation ->> 'target_record_id')::uuid
          and archived_at is null
      ) then
        raise exception '% must reference an active record.', v_field.name;
      end if;

      if not private.can_view_people_sensitive_record(
        p_workspace_id, v_field.related_entity_type_id, (v_relation ->> 'target_record_id')::uuid,
        private.current_effective_user(p_workspace_id)
      ) then
        raise exception '% must reference an active record.', v_field.name;
      end if;
    exception
      when invalid_text_representation then
        raise exception 'A relation must reference a valid record.';
    end;
  end loop;

  v_record_id := gen_random_uuid();

  insert into entity_records (
    id,
    workspace_id,
    entity_type_id,
    values,
    originating_process_step_run_id
  )
  values (
    v_record_id,
    p_workspace_id,
    p_entity_type_id,
    v_values,
    p_originating_process_step_run_id
  )
  on conflict (workspace_id, originating_process_step_run_id) where originating_process_step_run_id is not null
  do nothing
  returning id into v_record_id;

  if v_record_id is null then
    select id into v_record_id from entity_records
    where workspace_id = p_workspace_id and originating_process_step_run_id = p_originating_process_step_run_id;
    return v_record_id;
  end if;

  for v_relation in select * from jsonb_array_elements(p_relations)
  loop
    insert into entity_record_relation_values (
      workspace_id,
      source_entity_type_id,
      source_record_id,
      field_definition_id,
      target_entity_type_id,
      target_record_id
    )
    values (
      p_workspace_id,
      p_entity_type_id,
      v_record_id,
      (v_relation->>'field_definition_id')::uuid,
      (v_relation->>'target_entity_type_id')::uuid,
      (v_relation->>'target_record_id')::uuid
    );
  end loop;

  return v_record_id;
end;
$$;

comment on function create_entity_record_with_relations(uuid, uuid, jsonb, jsonb, uuid)
  is 'Creates a record with covered relations, entity-scoped advisory locking, required-field/choice/relation-target validation, and Phase 12.2 target-side visibility. Phase 12.3.1: for a Quality Review EntityType, the Reviewer relation must resolve to the caller''s own linked Person record unless the caller holds people-data governance authority, and every new record is forced into the configured Draft status regardless of caller input.';

revoke all on function create_entity_record_with_relations(uuid, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function create_entity_record_with_relations(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

-- 6. update_entity_record_with_relations (latest body: 0101). Quality
-- Review additions, all scoped behind `if v_entity_type.quality_review`,
-- inserted immediately after the existing not-found/visibility checks and
-- before the archived-field-preservation loop: (a) a Finalized record
-- rejects this entire generic update outright, for everyone, before any
-- other field change can occur -- correction requires the dedicated Reopen
-- transition; (b) the designated status field uses the identical
-- preserve-vs-assign comparison already established for choice fields
-- elsewhere in this function -- an omitted or unchanged (still-Draft)
-- status value is accepted and force-preserved, while any attempted CHANGE
-- to the status value through this generic path is rejected, requiring the
-- dedicated Finalize/Reopen RPCs instead; (c) content-edit authority for a
-- Draft record is Reviewer-only, EXCEPT when the call is a pure governance
-- Reviewer reassignment (no primitive value change, no relation change
-- other than the author field itself) -- that specific case is left to the
-- existing, unmodified 12.2 subject/author governance-boundary check
-- further below, which already requires people-data governance authority
-- for exactly that relation change. This is the approved "reassign, then
-- edit as the new Reviewer" administrative-correction path -- no second
-- privileged generic-edit bypass is introduced.
create or replace function update_entity_record_with_relations(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_relation jsonb;
  v_field field_definitions%rowtype;
  v_existing_values jsonb;
  v_next_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_relation_count integer;
  v_entity_type entity_types%rowtype;
  v_subject_covered boolean;
  v_subject_desired_target uuid;
  v_subject_existing_target uuid;
  v_author_covered boolean;
  v_author_desired_target uuid;
  v_author_existing_target uuid;
  v_status_key text;
  v_current_status_id uuid;
  v_incoming_status_id uuid;
  v_is_reviewer boolean;
  v_other_relation_fields_touched boolean;
begin
  if p_relation_field_ids is null or jsonb_typeof(p_relation_field_ids) <> 'array' then
    raise exception 'p_relation_field_ids must be a JSON array';
  end if;

  if p_relations is null or jsonb_typeof(p_relations) <> 'array' then
    raise exception 'p_relations must be a JSON array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  select values
    into v_existing_values
  from entity_records
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id
  for update;

  if not found then
    raise exception 'Record not found';
  end if;

  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_record_id, private.current_effective_user(p_workspace_id)
  ) then
    raise exception 'Record not found';
  end if;

  select * into v_entity_type
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id;

  -- Phase 12.3.1 addition: Quality Review lifecycle write authority.
  if v_entity_type.quality_review then
    select fd.key into v_status_key
    from field_definitions fd
    where fd.id = v_entity_type.quality_review_status_field_id;

    begin
      v_current_status_id := (v_existing_values ->> v_status_key)::uuid;
    exception
      when invalid_text_representation then
        v_current_status_id := null;
    end;

    if v_current_status_id = v_entity_type.quality_review_finalized_option_id then
      raise exception 'This Quality Review has been finalized and can no longer be edited. Use Reopen to make corrections.';
    end if;

    if v_next_values ? v_status_key and (v_next_values -> v_status_key) <> 'null'::jsonb then
      begin
        v_incoming_status_id := (v_next_values ->> v_status_key)::uuid;
      exception
        when invalid_text_representation then
          raise exception 'Quality Review status cannot be changed through an ordinary update. Use Finalize or Reopen.';
      end;

      if v_incoming_status_id is distinct from v_current_status_id then
        raise exception 'Quality Review status cannot be changed through an ordinary update. Use Finalize or Reopen.';
      end if;
    end if;

    -- Force-preserve the exact current status value regardless of what was
    -- supplied (defense in depth, same style as the archived-field
    -- preservation loop below).
    v_next_values := jsonb_set(v_next_values, array[v_status_key], to_jsonb(v_current_status_id::text), true);

    v_is_reviewer := exists (
      select 1
      from entity_record_relation_values arv
      join entity_record_person_links apl
        on apl.workspace_id = arv.workspace_id
        and apl.entity_record_id = arv.target_record_id
      where arv.workspace_id = p_workspace_id
        and arv.source_record_id = p_record_id
        and arv.field_definition_id = v_entity_type.author_person_field_id
        and apl.user_id = private.current_effective_user(p_workspace_id)
    );

    if not v_is_reviewer then
      v_other_relation_fields_touched := exists (
        select 1
        from jsonb_array_elements_text(p_relation_field_ids) covered(field_definition_id)
        where covered.field_definition_id::uuid <> v_entity_type.author_person_field_id
      );

      -- Non-reviewers may make no primitive content change at all (the
      -- status key was already force-preserved above, so this comparison
      -- is exact), and may touch no relation field other than the author
      -- field itself -- reassigning the author field is independently
      -- governed by the existing 12.2 check further below.
      if (v_next_values - v_status_key) is distinct from (v_existing_values - v_status_key)
        or v_other_relation_fields_touched
      then
        raise exception 'Only the designated Reviewer may edit this Draft Quality Review.';
      end if;
    end if;
  end if;

  -- Preserve archived primitive field data by metadata, not by blindly merging
  -- arbitrary existing JSONB keys. Active primitive fields remain governed by
  -- the existing complete-replacement p_values contract.
  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and archived_at is not null
      and type <> 'relation'
      and v_existing_values ? key
  loop
    v_next_values := jsonb_set(
      v_next_values,
      array[v_field.key],
      v_existing_values -> v_field.key,
      true
    );
  end loop;

  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and required = true
      and archived_at is null
    order by position
  loop
    if v_field.type = 'relation' then
      select count(*)
        into v_relation_count
      from (
        select rv.field_definition_id
        from entity_record_relation_values rv
        where rv.workspace_id = p_workspace_id
          and rv.source_entity_type_id = p_entity_type_id
          and rv.source_record_id = p_record_id
          and rv.field_definition_id = v_field.id
          and not exists (
            select 1
            from jsonb_array_elements_text(p_relation_field_ids) covered(field_definition_id)
            where covered.field_definition_id::uuid = v_field.id
          )
        union all
        select (relation ->> 'field_definition_id')::uuid
        from jsonb_array_elements(p_relations) relation
        where relation ->> 'field_definition_id' = v_field.id::text
      ) final_relations;

      if v_relation_count <> 1 then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'text' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'string'
        and btrim(v_next_values ->> v_field.key) <> ''
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'number' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'number'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'date' then
      begin
        if not (
          v_next_values ? v_field.key
          and jsonb_typeof(v_next_values -> v_field.key) = 'string'
          and v_next_values ->> v_field.key ~ '^\d{4}-\d{2}-\d{2}$'
          and to_char(to_date(v_next_values ->> v_field.key, 'YYYY-MM-DD'), 'YYYY-MM-DD') =
            v_next_values ->> v_field.key
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      exception
        when others then
          raise exception '% is required.', v_field.name;
      end;
    elsif v_field.type = 'boolean' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'boolean'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    elsif v_field.type = 'choice' then
      if not (
        v_next_values ? v_field.key
        and jsonb_typeof(v_next_values -> v_field.key) = 'string'
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    end if;
  end loop;

  -- Choice referential integrity: preserve != assign. Only validate a
  -- choice field's value against "must be active" when it actually
  -- changed from what this record already had -- an untouched value
  -- (possibly an archived option, kept from before it was archived) is
  -- preserved verbatim.
  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and type = 'choice'
      and archived_at is null
  loop
    if v_next_values ? v_field.key and v_next_values -> v_field.key <> 'null'::jsonb
      and (v_existing_values -> v_field.key) is distinct from (v_next_values -> v_field.key)
    then
      begin
        if jsonb_typeof(v_next_values -> v_field.key) <> 'string'
          or not exists (
            select 1 from field_choice_options
            where workspace_id = p_workspace_id
              and field_definition_id = v_field.id
              and id = (v_next_values ->> v_field.key)::uuid
              and archived_at is null
          )
        then
          raise exception '% must reference an active option.', v_field.name;
        end if;
      exception
        when invalid_text_representation then
          raise exception '% must reference an active option.', v_field.name;
      end;
    end if;
  end loop;

  -- Phase 9.3 addition: relation referential integrity, preserve != assign.
  -- Checked here, before the delete below, so the "does an identical row
  -- already exist" comparison sees the pre-update state. An incoming
  -- (field, target) pair that already exists as a row for this exact
  -- record is untouched -- preserved as-is even if that target has since
  -- been archived. A pair that does not already exist is a genuinely new
  -- assignment (including a change to a different target) and requires
  -- the target to be active. Clearing a relation (present in
  -- p_relation_field_ids, absent from p_relations) is untouched by this
  -- loop -- governed purely by the required/optional check above.
  for v_relation in select * from jsonb_array_elements(p_relations)
  loop
    begin
      select * into v_field
      from field_definitions
      where workspace_id = p_workspace_id
        and id = (v_relation ->> 'field_definition_id')::uuid
        and type = 'relation';

      if not found
        or v_field.related_entity_type_id is distinct from (v_relation ->> 'target_entity_type_id')::uuid
      then
        raise exception 'A relation must reference its own configured related object.';
      end if;

      if not exists (
        select 1
        from entity_record_relation_values rv
        where rv.workspace_id = p_workspace_id
          and rv.source_entity_type_id = p_entity_type_id
          and rv.source_record_id = p_record_id
          and rv.field_definition_id = v_field.id
          and rv.target_record_id = (v_relation ->> 'target_record_id')::uuid
      ) then
        if not exists (
          select 1 from entity_records
          where workspace_id = p_workspace_id
            and entity_type_id = v_field.related_entity_type_id
            and id = (v_relation ->> 'target_record_id')::uuid
            and archived_at is null
        ) then
          raise exception '% must reference an active record.', v_field.name;
        end if;

        if not private.can_view_people_sensitive_record(
          p_workspace_id, v_field.related_entity_type_id, (v_relation ->> 'target_record_id')::uuid,
          private.current_effective_user(p_workspace_id)
        ) then
          raise exception '% must reference an active record.', v_field.name;
        end if;
      end if;
    exception
      when invalid_text_representation then
        raise exception 'A relation must reference a valid record.';
    end;
  end loop;

  -- Phase 12.2 addition: subject/author security-relation governance.
  -- Evaluated before any mutation below, using the same field/target
  -- comparison shape as the relation-integrity loop above, but against
  -- p_relation_field_ids/p_relations directly rather than pre-existing
  -- rows, since a CLEARED designated relation (covered, but absent from
  -- p_relations) must also be governed, not only a reassigned one.
  if v_entity_type.subject_person_field_id is not null then
    v_subject_covered := exists (
      select 1 from jsonb_array_elements_text(p_relation_field_ids) covered(field_definition_id)
      where covered.field_definition_id::uuid = v_entity_type.subject_person_field_id
    );

    select (relation ->> 'target_record_id')::uuid into v_subject_desired_target
    from jsonb_array_elements(p_relations) relation
    where relation ->> 'field_definition_id' = v_entity_type.subject_person_field_id::text;

    select target_record_id into v_subject_existing_target
    from entity_record_relation_values
    where workspace_id = p_workspace_id
      and source_entity_type_id = p_entity_type_id
      and source_record_id = p_record_id
      and field_definition_id = v_entity_type.subject_person_field_id;

    if v_subject_covered and v_subject_desired_target is distinct from v_subject_existing_target then
      perform private.require_people_data_governance_authority(p_workspace_id);
    end if;
  end if;

  if v_entity_type.author_person_field_id is not null then
    v_author_covered := exists (
      select 1 from jsonb_array_elements_text(p_relation_field_ids) covered(field_definition_id)
      where covered.field_definition_id::uuid = v_entity_type.author_person_field_id
    );

    select (relation ->> 'target_record_id')::uuid into v_author_desired_target
    from jsonb_array_elements(p_relations) relation
    where relation ->> 'field_definition_id' = v_entity_type.author_person_field_id::text;

    select target_record_id into v_author_existing_target
    from entity_record_relation_values
    where workspace_id = p_workspace_id
      and source_entity_type_id = p_entity_type_id
      and source_record_id = p_record_id
      and field_definition_id = v_entity_type.author_person_field_id;

    if v_author_covered and v_author_desired_target is distinct from v_author_existing_target then
      perform private.require_people_data_governance_authority(p_workspace_id);
    end if;
  end if;

  update entity_records
  set values = v_next_values,
      updated_at = now()
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and id = p_record_id;

  delete from entity_record_relation_values
  where workspace_id = p_workspace_id
    and source_entity_type_id = p_entity_type_id
    and source_record_id = p_record_id
    and field_definition_id in (
      select value::uuid
      from jsonb_array_elements_text(p_relation_field_ids)
    );

  for v_relation in select * from jsonb_array_elements(p_relations)
  loop
    insert into entity_record_relation_values (
      workspace_id,
      source_entity_type_id,
      source_record_id,
      field_definition_id,
      target_entity_type_id,
      target_record_id
    )
    values (
      p_workspace_id,
      p_entity_type_id,
      p_record_id,
      (v_relation->>'field_definition_id')::uuid,
      (v_relation->>'target_entity_type_id')::uuid,
      (v_relation->>'target_record_id')::uuid
    );
  end loop;

  return p_record_id;
end;
$$;

comment on function update_entity_record_with_relations(uuid, uuid, uuid, jsonb, jsonb, jsonb)
  is 'Updates primitive values and covered relation rows with entity-scoped advisory locking. Active required fields are validated against the final updated record state, while archived primitive field values are preserved by field-definition metadata. Choice fields and relation targets whose value actually changed must reference an active option/record and be visible to the effective user; an untouched value (including a previously-active target now archived) is preserved as-is. A changed or cleared designated subject/author relation requires people_data.view_all held by the real actor, unavailable while impersonating. Phase 12.3.1: a Finalized Quality Review rejects this update entirely; its status field cannot be changed through this path; and Draft content edits (beyond a pure Reviewer reassignment) require the effective user to be the designated Reviewer.';

-- 7. private.enforce_quality_review_lifecycle_mutation: the structural,
-- unbypassable write-authority backstop for entity_records. Fires for
-- EVERY UPDATE regardless of role or RLS applicability (a security-definer
-- `_authorized` wrapper's internal UPDATE, the direct-table single-record
-- archive/restore path, or any current/future bulk path alike), since a
-- table-level trigger -- unlike RLS -- cannot be routed around by an
-- elevated role. Short-circuits immediately for any row whose entity type
-- is not quality_review, so every non-Quality-Review write (sensitive or
-- not) is completely unaffected.
--
-- The four recognized transitions, derived purely from comparing OLD/NEW,
-- with no session flag or caller-identity hack needed:
--   1. Draft content edit: archived_at unchanged, status unchanged (still
--      Draft) -- Reviewer + records.operate only (records.operate is
--      already required by every calling RPC's own capability check).
--   2. Finalize: archived_at unchanged, status Draft -> Finalized, no other
--      value changed in the same statement -- Reviewer only.
--   3. Reopen: archived_at unchanged, status Finalized -> Draft, no other
--      value changed -- people-data governance authority only.
--   4. Archive/restore: archived_at changing, status/values otherwise
--      unchanged -- Reviewer or governance authority while Draft; governance
--      authority only while Finalized (matches "no Reviewer archive of a
--      Finalized review").
-- Any other shape (simultaneous content-and-status change, an
-- unrecognized status value, or any combination not listed above) is
-- rejected unconditionally.
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

  if v_old_status = v_et.quality_review_finalized_option_id then
    raise exception 'This Quality Review has been finalized and can no longer be edited. Use Reopen to make corrections.';
  end if;

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
    if not v_is_reviewer then
      raise exception 'Only the designated Reviewer may edit this Draft Quality Review.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists entity_records_enforce_quality_review_lifecycle on entity_records;
create trigger entity_records_enforce_quality_review_lifecycle
  before update on entity_records
  for each row execute function private.enforce_quality_review_lifecycle_mutation();

-- 7b. private.enforce_quality_review_lifecycle_delete: the DELETE
-- counterpart to the trigger above. A BEFORE UPDATE trigger cannot fire
-- for a DELETE statement -- delete_entity_record_if_unreferenced (0101)
-- performs a plain `delete from entity_records`, an entirely separate SQL
-- command the UPDATE trigger structurally cannot reach, so hard-delete
-- authority needs its own trigger, not a reuse of the one above. Applies
-- the approved Draft/Finalized delete matrix: Finalized is blocked for
-- everyone, no exception, mirroring the unconditional finalized-edit
-- block; Draft requires the designated Reviewer or governance authority,
-- exactly like Draft archive. records.operate itself is not re-checked
-- here -- delete_entity_record_if_unreferenced_authorized (0025/0046/etc.)
-- already requires it before ever reaching the inner function, for both
-- the Reviewer and the governance-cleanup caller, exactly as it always has
-- for every other entity type.
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
  select * into v_et
  from public.entity_types et
  where et.workspace_id = old.workspace_id
    and et.id = old.entity_type_id
    and et.quality_review = true;

  if not found then
    return old;
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

drop trigger if exists entity_records_enforce_quality_review_lifecycle_delete on entity_records;
create trigger entity_records_enforce_quality_review_lifecycle_delete
  before delete on entity_records
  for each row execute function private.enforce_quality_review_lifecycle_delete();

-- 8. finalize_quality_review_authorized: the only path from Draft to
-- Finalized. Effective-user-aware (resolves against the impersonated
-- identity, consistent with ordinary record work under impersonation --
-- no concrete reason was found to prohibit finalizing while impersonating
-- the Reviewer). Writes only the lifecycle status; the trigger above is
-- the structural backstop for authority, this RPC's own explicit check is
-- for a clean, specific error message. The workspace_event insert is a
-- plain statement in the same transaction as the state change (not a
-- separate exception-swallowed block, unlike this schema's usual
-- best-effort event convention) -- Finalize/Reopen are consequential
-- enough that "the transition succeeded" and "the event exists" should be
-- a true joint guarantee, without expanding workspace_events into a
-- broader audit substrate.
create or replace function finalize_quality_review_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_et entity_types%rowtype;
  v_status_key text;
  v_current_status_raw text;
  v_current_status uuid;
  v_effective_user_id uuid;
  v_real_actor_user_id uuid;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  select * into v_et
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id and quality_review = true;

  if not found then
    raise exception 'This object is not configured for Quality Review';
  end if;

  if not exists (
    select 1 from entity_records
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id
  ) then
    raise exception 'Record not found';
  end if;

  v_effective_user_id := private.current_effective_user(p_workspace_id);

  if not private.can_view_people_sensitive_record(p_workspace_id, p_entity_type_id, p_record_id, v_effective_user_id) then
    raise exception 'Record not found';
  end if;

  select fd.key into v_status_key from field_definitions fd where fd.id = v_et.quality_review_status_field_id;

  select values ->> v_status_key into v_current_status_raw
  from entity_records
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id
  for update;

  begin
    v_current_status := v_current_status_raw::uuid;
  exception
    when invalid_text_representation then
      v_current_status := null;
  end;

  if v_current_status is distinct from v_et.quality_review_draft_option_id then
    raise exception 'This review is not currently in Draft status';
  end if;

  if not exists (
    select 1
    from entity_record_relation_values arv
    join entity_record_person_links apl
      on apl.workspace_id = arv.workspace_id
      and apl.entity_record_id = arv.target_record_id
    where arv.workspace_id = p_workspace_id
      and arv.source_record_id = p_record_id
      and arv.field_definition_id = v_et.author_person_field_id
      and apl.user_id = v_effective_user_id
  ) then
    raise exception 'Only the designated Reviewer may finalize this Quality Review';
  end if;

  update entity_records
  set values = jsonb_set(values, array[v_status_key], to_jsonb(v_et.quality_review_finalized_option_id::text)),
      updated_at = now()
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id;

  v_real_actor_user_id := case when auth.uid() <> v_effective_user_id then auth.uid() else null end;

  insert into workspace_events (
    id, workspace_id, actor_user_id, real_actor_user_id, event_type, entity_type_id, entity_record_id, metadata
  ) values (
    gen_random_uuid(), p_workspace_id, v_effective_user_id, v_real_actor_user_id, 'quality_review_finalized',
    p_entity_type_id, p_record_id, '{}'::jsonb
  );
end;
$$;

revoke all on function finalize_quality_review_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function finalize_quality_review_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on function finalize_quality_review_authorized(uuid, uuid, uuid)
  is 'Transitions a Quality Review from Draft to the configured Finalized status. Only the designated Reviewer (effective-user-aware) may finalize; the record must currently be in Draft. Writes only the lifecycle status and a transactional quality_review_finalized workspace_event.';

-- 9. reopen_quality_review_authorized: the only path from Finalized back
-- to Draft. Real-actor-only and unavailable while impersonating, per
-- private.has_people_data_governance_authority -- deliberately not
-- effective-user-aware, since this is a governance intervention, not
-- ordinary reviewer work. Ordinary Reviewer cannot reopen; there is no
-- direct privileged edit of Finalized content anywhere in this schema --
-- correction is always Reopen, then an ordinary Draft edit, then
-- re-Finalize.
create or replace function reopen_quality_review_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_et entity_types%rowtype;
  v_status_key text;
  v_current_status_raw text;
  v_current_status uuid;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if not private.has_people_data_governance_authority(p_workspace_id) then
    if exists (
      select 1 from impersonation_sessions session
      where session.workspace_id = p_workspace_id
        and session.real_actor_user_id = auth.uid()
        and session.ended_at is null
    ) then
      raise exception 'Reopening a Quality Review is not available while impersonating';
    end if;
    raise exception 'Reopening a Quality Review requires additional privileges';
  end if;

  select * into v_et
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id and quality_review = true;

  if not found then
    raise exception 'This object is not configured for Quality Review';
  end if;

  if not exists (
    select 1 from entity_records
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id
  ) then
    raise exception 'Record not found';
  end if;

  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_record_id, private.current_effective_user(p_workspace_id)
  ) then
    raise exception 'Record not found';
  end if;

  select fd.key into v_status_key from field_definitions fd where fd.id = v_et.quality_review_status_field_id;

  select values ->> v_status_key into v_current_status_raw
  from entity_records
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id
  for update;

  begin
    v_current_status := v_current_status_raw::uuid;
  exception
    when invalid_text_representation then
      v_current_status := null;
  end;

  if v_current_status is distinct from v_et.quality_review_finalized_option_id then
    raise exception 'This review is not currently Finalized';
  end if;

  update entity_records
  set values = jsonb_set(values, array[v_status_key], to_jsonb(v_et.quality_review_draft_option_id::text)),
      updated_at = now()
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id;

  insert into workspace_events (
    id, workspace_id, actor_user_id, real_actor_user_id, event_type, entity_type_id, entity_record_id, metadata
  ) values (
    gen_random_uuid(), p_workspace_id, auth.uid(), null, 'quality_review_reopened',
    p_entity_type_id, p_record_id, '{}'::jsonb
  );
end;
$$;

revoke all on function reopen_quality_review_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function reopen_quality_review_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on function reopen_quality_review_authorized(uuid, uuid, uuid)
  is 'Transitions a Quality Review from the configured Finalized status back to Draft, so it can be corrected under ordinary Draft rules and re-Finalized. Requires people-data governance authority held by the real actor, unavailable while impersonating. The ordinary Reviewer cannot reopen. Writes only the lifecycle status and a transactional quality_review_reopened workspace_event.';

-- 10. set_entity_type_people_sensitive_access_authorized (latest body:
-- 0100). One new guard block, inserted immediately after the existing
-- required-fields null-check: while quality_review is active on this
-- EntityType, this RPC rejects disabling sensitive access, changing the
-- subject or reviewer field, or turning off reviewer visibility -- all
-- four are load-bearing prerequisites of the Quality Review invariant
-- (section 1 above), so any of them must go through disabling Quality
-- Review lifecycle first (the new RPC below), never silently invalidating
-- or reinterpreting existing Quality Reviews.
create or replace function set_entity_type_people_sensitive_access_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_people_sensitive boolean,
  p_subject_person_field_id uuid,
  p_author_person_field_id uuid,
  p_subject_can_view boolean,
  p_manager_can_view boolean,
  p_author_can_view boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_type entity_types%rowtype;
  v_person_entity_type_id uuid;
  v_invalid_subject_count integer := 0;
  v_conflicting_process_count integer := 0;
  v_conflicting_workflow_count integer := 0;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  select * into v_entity_type
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
  for update;

  if not found then
    raise exception 'Entity type not found';
  end if;
  if v_entity_type.archived_at is not null then
    raise exception 'Cannot configure an archived entity type';
  end if;

  if p_people_sensitive is null or p_subject_can_view is null or p_manager_can_view is null or p_author_can_view is null then
    raise exception 'Sensitive-access configuration fields are required';
  end if;

  -- Phase 12.3.1 addition: Quality Review prerequisite protection.
  if v_entity_type.quality_review then
    if not p_people_sensitive then
      raise exception 'Cannot disable sensitive access while Quality Review lifecycle is active. Disable Quality Review for this object first.';
    end if;
    if p_subject_person_field_id is distinct from v_entity_type.subject_person_field_id then
      raise exception 'Cannot change the subject field while Quality Review lifecycle is active. Disable Quality Review for this object first.';
    end if;
    if p_author_person_field_id is distinct from v_entity_type.author_person_field_id then
      raise exception 'Cannot change the reviewer field while Quality Review lifecycle is active. Disable Quality Review for this object first.';
    end if;
    if not p_author_can_view then
      raise exception 'Cannot disable reviewer visibility while Quality Review lifecycle is active. Disable Quality Review for this object first.';
    end if;
  end if;

  if p_author_can_view and p_author_person_field_id is null then
    raise exception 'Reviewer/author visibility requires a designated reviewer/author field';
  end if;

  select person_entity_type_id into v_person_entity_type_id
  from workspaces
  where id = p_workspace_id;

  -- Subject/author fields are validated whenever supplied, independent of
  -- p_people_sensitive -- never store a designation pointing at something
  -- that is not a live relation-to-Person field on this exact entity type.
  if p_subject_person_field_id is not null or p_author_person_field_id is not null then
    if v_person_entity_type_id is null then
      raise exception 'No Person type is designated for this workspace';
    end if;
  end if;

  if p_subject_person_field_id is not null and not exists (
    select 1 from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_subject_person_field_id
      and type = 'relation'
      and archived_at is null
      and related_entity_type_id = v_person_entity_type_id
  ) then
    raise exception 'Subject field must be an active relation field on this object targeting the designated Person type';
  end if;

  if p_author_person_field_id is not null and not exists (
    select 1 from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_author_person_field_id
      and type = 'relation'
      and archived_at is null
      and related_entity_type_id = v_person_entity_type_id
  ) then
    raise exception 'Reviewer/author field must be an active relation field on this object targeting the designated Person type';
  end if;

  if p_subject_person_field_id is not null and p_subject_person_field_id = p_author_person_field_id then
    raise exception 'Subject and reviewer/author must be different fields';
  end if;

  if p_people_sensitive then
    if p_subject_person_field_id is null then
      raise exception 'Sensitive people data requires a designated subject field';
    end if;

    select count(*) into v_conflicting_process_count
    from process_templates
    where workspace_id = p_workspace_id
      and applies_to_entity_type_id = p_entity_type_id;

    select count(*) into v_conflicting_workflow_count
    from workflows workflow
    where workflow.workspace_id = p_workspace_id
      and (
        workflow.trigger_entity_type_id = p_entity_type_id
        or exists (
          select 1 from jsonb_array_elements(workflow.actions) action
          where action ->> 'actionTargetEntityTypeId' = p_entity_type_id::text
        )
      );

    if v_conflicting_process_count > 0 or v_conflicting_workflow_count > 0 then
      raise exception 'Cannot mark this object as sensitive people data while % Process Template(s) and % Workflow(s) still target it. Detach them first.',
        v_conflicting_process_count, v_conflicting_workflow_count;
    end if;

    -- Re-validate existing records only when sensitivity is newly enabled,
    -- or the subject field is changing to a different field -- an
    -- unchanged, already-validated subject field never needs re-checking.
    --
    -- Deliberately does NOT require the target Person record to be
    -- unarchived. Person identity links survive Person-record archival by
    -- design (0097), archival is reversible, and historical business
    -- relationships are never rewritten when a Person profile is archived
    -- -- an already-archived Person is a structurally valid, legitimate
    -- historical subject anchor, not a broken one. Rejecting enablement
    -- here for that reason would penalize normal, expected Person lifecycle
    -- (e.g. a former employee's historical Quality Reviews) for a state
    -- that is not actually broken. Whether a NEW relation may be created
    -- against an archived target at all is a separate, already-existing,
    -- unrelated rule (create_entity_record_with_relations/update_entity_
    -- record_with_relations's "must reference an active record" check,
    -- 0082) -- unaffected by this validation either way.
    if v_entity_type.people_sensitive is not true
      or v_entity_type.subject_person_field_id is distinct from p_subject_person_field_id
    then
      select count(*) into v_invalid_subject_count
      from entity_records er
      where er.workspace_id = p_workspace_id
        and er.entity_type_id = p_entity_type_id
        and not exists (
          select 1
          from entity_record_relation_values rv
          join entity_records person_rec
            on person_rec.workspace_id = rv.workspace_id
            and person_rec.id = rv.target_record_id
          where rv.workspace_id = p_workspace_id
            and rv.source_record_id = er.id
            and rv.field_definition_id = p_subject_person_field_id
            and rv.target_entity_type_id = v_person_entity_type_id
            and person_rec.entity_type_id = v_person_entity_type_id
        );

      if v_invalid_subject_count > 0 then
        raise exception '% existing record(s) of this object do not have a valid subject relation set in the selected subject field. Set a subject for every existing record before enabling sensitive access.',
          v_invalid_subject_count;
      end if;
    end if;
  end if;

  update entity_types
  set people_sensitive = p_people_sensitive,
      subject_person_field_id = p_subject_person_field_id,
      author_person_field_id = p_author_person_field_id,
      subject_can_view = p_subject_can_view,
      manager_can_view = p_manager_can_view,
      author_can_view = p_author_can_view,
      updated_at = now()
  where workspace_id = p_workspace_id and id = p_entity_type_id;
end;
$$;

comment on function set_entity_type_people_sensitive_access_authorized(uuid, uuid, boolean, uuid, uuid, boolean, boolean, boolean)
  is 'Configures Phase 12.2 sensitive-access metadata for one EntityType: people_sensitive designation, subject/author relation fields (must target the workspace''s designated Person type), and the three fixed read-access toggles. schema.manage, real-actor-only, blocked while impersonating. Rejects enabling sensitivity while a Process Template or Workflow targets the type, and rejects it while any existing record lacks a valid subject relation, with a truthful count -- never auto-populates or rewrites records. Phase 12.3.1: while Quality Review lifecycle is active on this type, rejects disabling sensitivity, changing the subject/reviewer field, or turning off reviewer visibility.';

-- 11. private.reject_archiving_designated_sensitive_field (latest body:
-- 0100). Extended to also protect quality_review_status_field_id -- the
-- exact same class of guard as subject/author field protection, since
-- archiving the designated status field out from under an active Quality
-- Review configuration would be just as structurally damaging.
create or replace function private.reject_archiving_designated_sensitive_field()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    if exists (
      select 1 from public.entity_types et
      where et.workspace_id = new.workspace_id
        and (
          et.subject_person_field_id = new.id
          or et.author_person_field_id = new.id
          or et.quality_review_status_field_id = new.id
        )
    ) then
      raise exception 'This field is designated for sensitive-record access and cannot be archived. Change the designation first.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- 12. Choice-option protection: field_choice_options only supports
-- archive/restore, never physical deletion (0080) -- so the equivalent
-- guard for Draft/Finalized options is a BEFORE UPDATE trigger blocking
-- the archived_at transition, mirroring the field-level guard above
-- exactly. No broader Choice-option lifecycle mechanism is introduced.
create or replace function private.reject_archiving_designated_quality_review_option()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    if exists (
      select 1 from public.entity_types et
      where et.workspace_id = new.workspace_id
        and et.quality_review = true
        and (et.quality_review_draft_option_id = new.id or et.quality_review_finalized_option_id = new.id)
    ) then
      raise exception 'This option is designated as a Quality Review lifecycle status and cannot be archived while Quality Review is active. Disable Quality Review for this object first.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists field_choice_options_reject_qr_archive on field_choice_options;
create trigger field_choice_options_reject_qr_archive
  before update on field_choice_options
  for each row execute function private.reject_archiving_designated_quality_review_option();

-- 13. set_entity_type_quality_review_lifecycle_authorized: the Quality
-- Review configuration RPC, separate from 12.2's sensitive-access RPC
-- above -- Quality Review is a distinct, narrower concern layered on top
-- of an already-sensitive type, not a duplicate of it. schema.manage,
-- real-actor-only, unavailable while impersonating (0099's idiom,
-- verbatim). A single existing-records check ("every record's status must
-- resolve to exactly the target Draft or Finalized option") covers
-- initial enablement, a status-field change, AND a Draft/Finalized option
-- change all at once: repointing either option away from a value any
-- existing record currently holds makes that record fail the very same
-- check, so no separate option-change guard is needed. Disabling is
-- blocked while any record of this EntityType exists at all (not only
-- Finalized ones) -- disabling while Drafts exist would silently strip
-- both their visibility restriction and their write lock.
create or replace function set_entity_type_quality_review_lifecycle_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_quality_review boolean,
  p_status_field_id uuid,
  p_draft_option_id uuid,
  p_finalized_option_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_type entity_types%rowtype;
  v_status_field field_definitions%rowtype;
  v_record_count integer;
  v_invalid_status_count integer;
begin
  if exists (
    select 1 from impersonation_sessions session
    where session.workspace_id = p_workspace_id
      and session.real_actor_user_id = auth.uid()
      and session.ended_at is null
  ) then
    raise exception 'Not available while impersonating';
  end if;

  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  select * into v_entity_type
  from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
  for update;

  if not found then
    raise exception 'Entity type not found';
  end if;
  if v_entity_type.archived_at is not null then
    raise exception 'Cannot configure an archived entity type';
  end if;

  if p_quality_review is null then
    raise exception 'Quality Review configuration fields are required';
  end if;

  if p_quality_review then
    if not (
      v_entity_type.people_sensitive
      and v_entity_type.subject_person_field_id is not null
      and v_entity_type.author_person_field_id is not null
      and v_entity_type.author_can_view
    ) then
      raise exception 'Configure sensitive access with a subject field, a reviewer field, and reviewer visibility enabled before enabling Quality Review lifecycle';
    end if;

    select * into v_status_field
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_status_field_id
      and type = 'choice'
      and archived_at is null;

    if not found then
      raise exception 'Status field must be an active Choice field on this object';
    end if;

    if p_draft_option_id is null or p_finalized_option_id is null then
      raise exception 'Draft and Finalized status options are required';
    end if;

    if p_draft_option_id = p_finalized_option_id then
      raise exception 'Draft and Finalized must be different options';
    end if;

    if not exists (
      select 1 from field_choice_options
      where workspace_id = p_workspace_id
        and field_definition_id = p_status_field_id
        and id = p_draft_option_id
        and archived_at is null
    ) then
      raise exception 'Draft option must be an active option on the selected status field';
    end if;

    if not exists (
      select 1 from field_choice_options
      where workspace_id = p_workspace_id
        and field_definition_id = p_status_field_id
        and id = p_finalized_option_id
        and archived_at is null
    ) then
      raise exception 'Finalized option must be an active option on the selected status field';
    end if;

    -- Every existing record must resolve to exactly one of the two target
    -- options -- covers initial enablement, a status-field change, and a
    -- Draft/Finalized option change uniformly, never rewriting a record.
    select count(*) into v_invalid_status_count
    from entity_records er
    where er.workspace_id = p_workspace_id
      and er.entity_type_id = p_entity_type_id
      and (er.values ->> v_status_field.key) is distinct from p_draft_option_id::text
      and (er.values ->> v_status_field.key) is distinct from p_finalized_option_id::text;

    if v_invalid_status_count > 0 then
      raise exception '% existing record(s) of this object do not have a recognized Draft or Finalized status in the selected status field. Set a valid status for every existing record before enabling Quality Review lifecycle.',
        v_invalid_status_count;
    end if;

    update entity_types
    set quality_review = true,
        quality_review_status_field_id = p_status_field_id,
        quality_review_draft_option_id = p_draft_option_id,
        quality_review_finalized_option_id = p_finalized_option_id,
        updated_at = now()
    where workspace_id = p_workspace_id and id = p_entity_type_id;
  else
    select count(*) into v_record_count
    from entity_records
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id;

    if v_record_count > 0 then
      raise exception 'Cannot disable Quality Review lifecycle while % record(s) of this object exist.', v_record_count;
    end if;

    update entity_types
    set quality_review = false,
        quality_review_status_field_id = null,
        quality_review_draft_option_id = null,
        quality_review_finalized_option_id = null,
        updated_at = now()
    where workspace_id = p_workspace_id and id = p_entity_type_id;
  end if;
end;
$$;

revoke all on function set_entity_type_quality_review_lifecycle_authorized(uuid, uuid, boolean, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function set_entity_type_quality_review_lifecycle_authorized(uuid, uuid, boolean, uuid, uuid, uuid) to authenticated, service_role;

comment on function set_entity_type_quality_review_lifecycle_authorized(uuid, uuid, boolean, uuid, uuid, uuid)
  is 'Configures Phase 12.3.1 Quality Review lifecycle metadata for an already people-sensitive EntityType: an active Choice status field plus its Draft/Finalized options. schema.manage, real-actor-only, blocked while impersonating. Requires sensitive access, a subject field, a reviewer field, and reviewer visibility to already be configured. Rejects enabling (or reconfiguring) while any existing record does not resolve to exactly the target Draft or Finalized option, with a truthful count. Rejects disabling while any record of this object exists.';

-- 14. list_record_activity_authorized (latest body: 0094). Two additions:
-- the two new Quality Review event types are added to the visible
-- event_type list, and -- since these are the first event types this
-- function can ever surface for a people-sensitive record (every
-- pre-existing event type here is Process-machinery, which people-
-- sensitive types have always been structurally prohibited from
-- attaching, per 0100) -- a visibility check is added so a hidden
-- sensitive record's Activity is never reachable by calling this RPC
-- directly with its id. A hidden/nonexistent record now returns no rows,
-- matching this function's own existing behavior for a genuinely
-- nonexistent record (no exception; both already look identical).
create or replace function list_record_activity_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_record_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  event_type text,
  created_at timestamptz,
  actor_user_id uuid,
  actor_label text,
  process_run_id uuid,
  process_run_name text,
  process_step_run_id uuid,
  step_name text,
  assignee_label text,
  approval_outcome_label text,
  is_recurrence_started boolean,
  cancellation_reason text,
  from_assignee_label text,
  to_assignee_label text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Activity limit must be between 1 and 100';
  end if;

  if not private.can_view_people_sensitive_record(
    p_workspace_id, p_entity_type_id, p_entity_record_id, private.current_effective_user(p_workspace_id)
  ) then
    return;
  end if;

  return query
  select
    e.id, e.event_type, e.created_at, e.actor_user_id,
    coalesce(step.decided_by_label, actor_user.email) as actor_label,
    e.process_run_id, run.process_template_name as process_run_name,
    e.process_step_run_id, step.name as step_name, step.assignee_label,
    step.approval_outcome_label,
    (run.originating_recurrence_occurrence_id is not null) as is_recurrence_started,
    run.cancellation_reason,
    e.metadata->>'from_assignee_label' as from_assignee_label,
    e.metadata->>'to_assignee_label' as to_assignee_label
  from workspace_events e
  left join process_runs run on run.workspace_id = e.workspace_id and run.id = e.process_run_id
  left join process_step_runs step on step.workspace_id = e.workspace_id and step.id = e.process_step_run_id
  left join auth.users actor_user on actor_user.id = e.actor_user_id
  where e.workspace_id = p_workspace_id
    and e.entity_type_id = p_entity_type_id
    and e.entity_record_id = p_entity_record_id
    and e.event_type in (
      'process_started', 'process_completed', 'step_assigned', 'approval_decided',
      'process_cancelled', 'step_reassigned', 'quality_review_finalized', 'quality_review_reopened'
    )
  order by e.created_at desc
  limit p_limit;
end;
$$;

revoke all on function list_record_activity_authorized(uuid, uuid, uuid, integer) from public, anon;
grant execute on function list_record_activity_authorized(uuid, uuid, uuid, integer) to authenticated, service_role;

-- 15. Widen workspace_events.event_type for the two new Quality Review
-- lifecycle events, full latest list (0097) reproduced faithfully.
alter table workspace_events
  drop constraint if exists workspace_events_event_type_check;
alter table workspace_events
  add constraint workspace_events_event_type_check
  check (event_type in (
    'step_assigned', 'step_due_soon', 'step_overdue', 'recurrence_started_process',
    'process_started', 'process_completed', 'approval_decided',
    'impersonation_started', 'impersonation_ended',
    'process_cancelled', 'step_reassigned',
    'person_linked', 'person_unlinked',
    'quality_review_finalized', 'quality_review_reopened'
  ));
