-- Phase 12.3.2: Person Review History Experience -- backend half. Adds
-- QR-specific presentation metadata (which Date/Choice field a Quality
-- Review type uses for its Review Date / Overall Result columns) and the
-- narrow read RPC a Person's record-detail page uses to render a complete,
-- Finalized-only history. 0100-0107 remain untouched and immutable; every
-- redefined function here is `create or replace`, full latest body
-- reproduced faithfully with only the intended new behavior added.
--
-- 1. Presentation metadata: two new nullable entity_types columns,
-- structurally FK-scoped exactly like quality_review_status_field_id
-- (0105) -- a composite FK against field_definitions' own
-- (workspace_id, entity_type_id, id) key, so each can only ever reference
-- a field that actually belongs to this exact object. Deliberately NOT
-- part of the quality_review_invariant_check: presentation is optional
-- (Overall Result may never be configured at all) and independently
-- governed by its own configuration RPC below, not a precondition of
-- quality_review itself.
alter table entity_types
  add column if not exists quality_review_date_field_id uuid,
  add column if not exists quality_review_result_field_id uuid;

alter table entity_types
  drop constraint if exists entity_types_quality_review_date_field_fk;
alter table entity_types
  add constraint entity_types_quality_review_date_field_fk
  foreign key (workspace_id, id, quality_review_date_field_id)
  references field_definitions (workspace_id, entity_type_id, id)
  on delete restrict;

alter table entity_types
  drop constraint if exists entity_types_quality_review_result_field_fk;
alter table entity_types
  add constraint entity_types_quality_review_result_field_fk
  foreign key (workspace_id, id, quality_review_result_field_id)
  references field_definitions (workspace_id, entity_type_id, id)
  on delete restrict;

-- 2. Canonical Review Date validity predicate -- the exact regex + to_date/
-- to_char round-trip idiom this repo already uses for every other "real
-- YYYY-MM-DD business date, no automatic repair" check (0005, 0013-0015,
-- 0031, 0037, 0041, 0061-0062, 0070, 0080-0082, 0101, 0105), reproduced
-- faithfully rather than reinvented. The round-trip catches every
-- impossible/rolled-over date (e.g. "2026-02-30") the same way those call
-- sites already rely on, since to_date does not raise for an out-of-range
-- day-of-month, it normalizes -- so equality against the original string is
-- what actually rejects it. Exactly ONE definition of "valid Review Date"
-- drives configuration validation, Finalize-time validation, and the
-- history RPC's own row filtering below -- never three independent
-- validators.
create or replace function private.is_valid_review_date(p_value text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_value is not null
    and p_value ~ '^\d{4}-\d{2}-\d{2}$'
    and to_char(to_date(p_value, 'YYYY-MM-DD'), 'YYYY-MM-DD') = p_value
$$;

revoke all on function private.is_valid_review_date(text) from public, anon, authenticated;

-- 3. Field lifecycle protection (latest body: 0105/0100). Two more
-- designations added to the existing OR list -- an active
-- quality_review_date_field_id/quality_review_result_field_id cannot be
-- archived while designated, exactly like the subject/author/status
-- fields already protected here. No new trigger needed -- the existing
-- `before update on field_definitions` trigger already calls this
-- function by name, so replacing its body is sufficient.
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
          or et.quality_review_date_field_id = new.id
          or et.quality_review_result_field_id = new.id
        )
    ) then
      raise exception 'This field is designated for sensitive-record access and cannot be archived. Change the designation first.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- 4. set_entity_type_quality_review_presentation_authorized: a narrow,
-- separate configuration RPC -- does NOT widen the already-shipped 12.3.1
-- lifecycle RPC's signature. schema.manage, real-actor-only, unavailable
-- while impersonating (0105/0099's idiom, verbatim). Requires Quality
-- Review already enabled on this object.
--
-- Review Date: first designation (current value null, new value non-null)
-- validates every currently Finalized record's value in the proposed
-- field using the shared predicate above, rejecting with a truthful
-- invalid-record count and never rewriting a record. Changing OR clearing
-- an existing designation is rejected outright once any Finalized record
-- exists (regardless of that record's own date validity) -- the
-- finalized-history completeness guarantee, once established, is never
-- silently reinterpreted or removed. Both are allowed freely while zero
-- Finalized records exist.
--
-- Overall Result: no completeness requirement on first designation --
-- historical records may legitimately carry no Result. Changing or
-- clearing an existing designation follows the identical "blocked once
-- Finalized records exist" rule, for the same no-silent-reinterpretation
-- reason.
--
-- A field naming a different object, the wrong type, or an archived field
-- is rejected by the same active-field lookup pattern
-- set_entity_type_quality_review_lifecycle_authorized already uses for the
-- status field; the composite FK above is the structural backstop.
create or replace function set_entity_type_quality_review_presentation_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_date_field_id uuid,
  p_result_field_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_type entity_types%rowtype;
  v_date_field field_definitions%rowtype;
  v_result_field field_definitions%rowtype;
  v_status_key text;
  v_invalid_date_count integer;
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
  if not v_entity_type.quality_review then
    raise exception 'Enable Quality Review lifecycle before configuring review presentation';
  end if;

  select fd.key into v_status_key
  from field_definitions fd
  where fd.id = v_entity_type.quality_review_status_field_id;

  -- REVIEW DATE
  if p_date_field_id is not null then
    select * into v_date_field
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_date_field_id
      and type = 'date'
      and archived_at is null;

    if not found then
      raise exception 'Review date field must be an active Date field on this object';
    end if;
  end if;

  if v_entity_type.quality_review_date_field_id is distinct from p_date_field_id then
    if v_entity_type.quality_review_date_field_id is not null then
      if exists (
        select 1 from entity_records er
        where er.workspace_id = p_workspace_id
          and er.entity_type_id = p_entity_type_id
          and (er.values ->> v_status_key) = v_entity_type.quality_review_finalized_option_id::text
      ) then
        raise exception 'The Review Date field cannot be changed or cleared while Finalized reviews exist';
      end if;
    elsif p_date_field_id is not null then
      select count(*) into v_invalid_date_count
      from entity_records er
      where er.workspace_id = p_workspace_id
        and er.entity_type_id = p_entity_type_id
        and (er.values ->> v_status_key) = v_entity_type.quality_review_finalized_option_id::text
        and not private.is_valid_review_date(er.values ->> v_date_field.key);

      if v_invalid_date_count > 0 then
        raise exception '% existing Finalized review(s) do not have a valid Review Date in the selected field. Correct them before designating this field.',
          v_invalid_date_count;
      end if;
    end if;
  end if;

  -- OVERALL RESULT
  if p_result_field_id is not null then
    select * into v_result_field
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and id = p_result_field_id
      and type = 'choice'
      and archived_at is null;

    if not found then
      raise exception 'Overall result field must be an active Choice field on this object';
    end if;
  end if;

  if v_entity_type.quality_review_result_field_id is distinct from p_result_field_id then
    if v_entity_type.quality_review_result_field_id is not null and exists (
      select 1 from entity_records er
      where er.workspace_id = p_workspace_id
        and er.entity_type_id = p_entity_type_id
        and (er.values ->> v_status_key) = v_entity_type.quality_review_finalized_option_id::text
    ) then
      raise exception 'The Overall Result field cannot be changed or cleared while Finalized reviews exist';
    end if;
  end if;

  update entity_types
  set quality_review_date_field_id = p_date_field_id,
      quality_review_result_field_id = p_result_field_id,
      updated_at = now()
  where workspace_id = p_workspace_id and id = p_entity_type_id;
end;
$$;

revoke all on function set_entity_type_quality_review_presentation_authorized(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function set_entity_type_quality_review_presentation_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;

comment on function set_entity_type_quality_review_presentation_authorized(uuid, uuid, uuid, uuid)
  is 'Configures Phase 12.3.2 Quality Review presentation metadata (Review Date / Overall Result fields) for an already quality_review-enabled EntityType. schema.manage, real-actor-only, blocked while impersonating. First designation of Review Date validates every existing Finalized record has a valid date, rejecting with a truthful count; changing or clearing either designation is rejected once any Finalized record exists.';

-- 5. finalize_quality_review_authorized (latest body: 0105, untouched by
-- 0106/0107). One new guard, inserted immediately before the status
-- update: if this EntityType has a Review Date field configured, the
-- Draft being finalized must already hold a valid value there (the same
-- shared predicate as above) -- Finalize is rejected with a truthful
-- message otherwise, and nothing is filled in or altered automatically.
-- Draft creation/editing remains completely unconstrained by this rule;
-- an EntityType with no Review Date field configured finalizes exactly as
-- 12.3.1, byte-for-byte.
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
  v_date_key text;
  v_date_value text;
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

  if v_et.quality_review_date_field_id is not null then
    select fd.key into v_date_key from field_definitions fd where fd.id = v_et.quality_review_date_field_id;

    select values ->> v_date_key into v_date_value
    from entity_records
    where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_record_id;

    if not private.is_valid_review_date(v_date_value) then
      raise exception 'This review cannot be finalized without a valid Review Date';
    end if;
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
  is 'Transitions a Quality Review from Draft to the configured Finalized status. Only the designated Reviewer (effective-user-aware) may finalize; the record must currently be in Draft. Phase 12.3.2: if a Review Date field is configured, finalize is rejected unless the Draft already holds a valid date there -- never filled in automatically. Writes only the lifecycle status and a transactional quality_review_finalized workspace_event.';

-- 6. list_person_quality_reviews_authorized: the new Phase 12.3.2 read
-- surface. Input preconditions run in order and fail identically (empty
-- result, never a distinguishable error) for a wrong-workspace, wrong-
-- type, hidden, or nonexistent Person id -- only genuine non-membership
-- raises. Row visibility is delegated entirely to the existing
-- can_view_people_sensitive_record predicate (both for the Person gate
-- and for each candidate review row), never reimplemented. Reviewer
-- identity is resolved from the relation's own recorded
-- target_entity_type_id (not assumed to equal the workspace's CURRENT
-- Person designation, which could in principle have since changed) and is
-- independently visibility-checked before its id/label are returned --
-- api_record_label is never called on an unchecked target. Complete,
-- uncapped, Finalized-only history: no p_limit, no pagination, ordered
-- newest Review Date first with a record-id tie break.
create or replace function list_person_quality_reviews_authorized(
  p_workspace_id uuid,
  p_person_record_id uuid
)
returns table (
  review_entity_type_id uuid,
  review_entity_type_name text,
  review_record_id uuid,
  review_date date,
  result_option_id uuid,
  result_label text,
  result_color text,
  reviewer_person_record_id uuid,
  reviewer_label text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_person_entity_type_id uuid;
  v_effective_user_id uuid;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  select w.person_entity_type_id into v_person_entity_type_id
  from workspaces w
  where w.id = p_workspace_id;

  if v_person_entity_type_id is null then
    return;
  end if;

  if not exists (
    select 1 from entity_records er
    where er.workspace_id = p_workspace_id
      and er.entity_type_id = v_person_entity_type_id
      and er.id = p_person_record_id
  ) then
    return;
  end if;

  v_effective_user_id := private.current_effective_user(p_workspace_id);

  if not private.can_view_people_sensitive_record(
    p_workspace_id, v_person_entity_type_id, p_person_record_id, v_effective_user_id
  ) then
    return;
  end if;

  return query
  select
    et.id as review_entity_type_id,
    et.name as review_entity_type_name,
    er.id as review_record_id,
    to_date(er.values ->> date_fd.key, 'YYYY-MM-DD') as review_date,
    result_option.id as result_option_id,
    result_option.label as result_label,
    result_option.color as result_color,
    case
      when reviewer_rel.target_record_id is not null
        and private.can_view_people_sensitive_record(
          p_workspace_id, reviewer_rel.target_entity_type_id, reviewer_rel.target_record_id, v_effective_user_id
        )
      then reviewer_rel.target_record_id
    end as reviewer_person_record_id,
    case
      when reviewer_rel.target_record_id is not null
        and private.can_view_people_sensitive_record(
          p_workspace_id, reviewer_rel.target_entity_type_id, reviewer_rel.target_record_id, v_effective_user_id
        )
      then private.api_record_label(p_workspace_id, reviewer_rel.target_entity_type_id, reviewer_rel.target_record_id)
    end as reviewer_label
  from entity_types et
  join field_definitions status_fd on status_fd.id = et.quality_review_status_field_id
  join field_definitions date_fd on date_fd.id = et.quality_review_date_field_id
  join entity_record_relation_values subject_rel
    on subject_rel.workspace_id = et.workspace_id
    and subject_rel.field_definition_id = et.subject_person_field_id
    and subject_rel.target_record_id = p_person_record_id
  join entity_records er
    on er.workspace_id = et.workspace_id
    and er.entity_type_id = et.id
    and er.id = subject_rel.source_record_id
  left join entity_record_relation_values reviewer_rel
    on reviewer_rel.workspace_id = et.workspace_id
    and reviewer_rel.field_definition_id = et.author_person_field_id
    and reviewer_rel.source_record_id = er.id
  left join field_definitions result_fd on result_fd.id = et.quality_review_result_field_id
  left join lateral (
    select fco.id, fco.label, fco.color
    from field_choice_options fco
    where fco.workspace_id = et.workspace_id
      and fco.field_definition_id = result_fd.id
      and fco.id::text = (er.values ->> result_fd.key)
    limit 1
  ) result_option on true
  where et.workspace_id = p_workspace_id
    and et.quality_review = true
    and et.quality_review_date_field_id is not null
    and (er.values ->> status_fd.key) = et.quality_review_finalized_option_id::text
    and private.is_valid_review_date(er.values ->> date_fd.key)
    and private.can_view_people_sensitive_record(p_workspace_id, et.id, er.id, v_effective_user_id)
  order by review_date desc, review_record_id desc;
end;
$$;

revoke all on function list_person_quality_reviews_authorized(uuid, uuid) from public, anon;
grant execute on function list_person_quality_reviews_authorized(uuid, uuid) to authenticated, service_role;

comment on function list_person_quality_reviews_authorized(uuid, uuid)
  is 'Phase 12.3.2: returns the complete, uncapped, Finalized-only Quality Review history for a Person record across every quality_review-enabled EntityType with a Review Date field configured, newest Review Date first. Wrong-workspace, wrong-type, hidden, or nonexistent Person input all yield an empty result rather than a distinguishable error. Each row''s own visibility and its Reviewer identity''s visibility are independently checked via can_view_people_sensitive_record; a review with a hidden Reviewer still returns with reviewer_person_record_id/reviewer_label null.';
