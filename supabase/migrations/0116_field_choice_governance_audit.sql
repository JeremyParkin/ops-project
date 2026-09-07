-- Phase 13.2B1: semantic audit history for Field and Choice configuration.
-- This store is deliberately separate from record_change_events and
-- workspace_events. Subject references are soft IDs so hard deletion of a
-- Field never blocks or removes its history.

create table governance_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  event_type text not null check (event_type in (
    'field_created', 'field_updated', 'field_archived', 'field_restored', 'field_deleted',
    'choice_option_created', 'choice_option_updated', 'choice_option_archived', 'choice_option_restored'
  )),
  subject_kind text not null check (subject_kind in ('field', 'choice_option')),
  subject_id uuid not null,
  subject_name_snapshot text not null,
  parent_field_id uuid,
  parent_field_name_snapshot text,
  parent_entity_type_id uuid not null,
  parent_entity_type_name_snapshot text not null,
  effective_actor_user_id uuid,
  real_actor_user_id uuid,
  authority_kind text not null check (authority_kind in ('human', 'impersonated', 'system')),
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((authority_kind = 'human' and effective_actor_user_id is not null and real_actor_user_id is null)
    or (authority_kind = 'impersonated' and effective_actor_user_id is not null and real_actor_user_id is not null and effective_actor_user_id <> real_actor_user_id)
    or (authority_kind = 'system' and effective_actor_user_id is null and real_actor_user_id is null))
);

create index governance_audit_events_workspace_idx
  on governance_audit_events (workspace_id, created_at desc, id desc);
create index governance_audit_events_subject_idx
  on governance_audit_events (workspace_id, subject_kind, subject_id, created_at desc, id desc);

alter table governance_audit_events enable row level security;
revoke all on table governance_audit_events from public, anon, authenticated;
grant select on table governance_audit_events to service_role;

create or replace function private.reject_governance_audit_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Governance audit history is append-only';
  end if;
  if exists (select 1 from public.workspaces where id = old.workspace_id) then
    raise exception 'Governance audit history is append-only';
  end if;
  return old;
end;
$$;

create trigger governance_audit_events_append_only
  before update or delete on governance_audit_events
  for each row execute function private.reject_governance_audit_mutation();

create or replace function private.governance_audit_actor()
returns table (effective_actor_user_id uuid, real_actor_user_id uuid, authority_kind text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() = 'service_role' then
    return query select null::uuid, null::uuid, 'system'::text;
  end if;
  return query select auth.uid(), null::uuid, 'human'::text;
end;
$$;

create or replace function private.governance_audit_insert(
  p_workspace_id uuid, p_event_type text, p_subject_kind text, p_subject_id uuid,
  p_subject_name text, p_parent_field_id uuid, p_parent_field_name text,
  p_parent_entity_type_id uuid, p_parent_entity_type_name text, p_changes jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a record;
  v_id uuid := gen_random_uuid();
begin
  -- Service-role calls in this codebase are fixture/bootstrap administration,
  -- not user-visible governance actions. Do not fabricate operational history
  -- for them.
  if auth.role() = 'service_role' then
    return null;
  end if;
  select * into a from private.governance_audit_actor();
  insert into governance_audit_events (
    id, workspace_id, event_type, subject_kind, subject_id, subject_name_snapshot,
    parent_field_id, parent_field_name_snapshot, parent_entity_type_id,
    parent_entity_type_name_snapshot, effective_actor_user_id, real_actor_user_id,
    authority_kind, changes
  ) values (
    v_id, p_workspace_id, p_event_type, p_subject_kind, p_subject_id,
    coalesce(p_subject_name, 'Deleted field'), p_parent_field_id,
    p_parent_field_name, p_parent_entity_type_id,
    coalesce(p_parent_entity_type_name, 'Deleted object'), a.effective_actor_user_id,
    a.real_actor_user_id, a.authority_kind, coalesce(p_changes, '{}'::jsonb)
  );
  return v_id;
end;
$$;

-- Preserve the complete existing validation implementations as private-in-
-- practice cores. The public wrappers below retain their exact signatures.
alter function public.add_field_definition(uuid, uuid, text, text, text, text, boolean, uuid)
  rename to add_field_definition_core;
alter function public.update_field_definition(uuid, uuid, uuid, text, text, boolean)
  rename to update_field_definition_core;
alter function public.add_field_choice_option(uuid, uuid, text, text)
  rename to add_field_choice_option_core;
alter function public.update_field_choice_option(uuid, uuid, uuid, text, text)
  rename to update_field_choice_option_core;
alter function public.archive_field_choice_option(uuid, uuid, uuid)
  rename to archive_field_choice_option_core;
alter function public.restore_field_choice_option(uuid, uuid, uuid)
  rename to restore_field_choice_option_core;

revoke all on function public.add_field_definition_core(uuid, uuid, text, text, text, text, boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.update_field_definition_core(uuid, uuid, uuid, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.add_field_choice_option_core(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.update_field_choice_option_core(uuid, uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.archive_field_choice_option_core(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.restore_field_choice_option_core(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create function add_field_definition(
  p_workspace_id uuid, p_entity_type_id uuid, p_name text, p_slug text,
  p_key text, p_type text, p_required boolean, p_related_entity_type_id uuid
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_entity entity_types%rowtype; v_field field_definitions%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into v_entity from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  if not found then raise exception 'Entity type not found'; end if;
  v_id := public.add_field_definition_core(p_workspace_id, p_entity_type_id, p_name, p_slug, p_key, p_type, p_required, p_related_entity_type_id);
  select * into v_field from field_definitions where workspace_id = p_workspace_id and id = v_id;
  perform private.governance_audit_insert(p_workspace_id, 'field_created', 'field', v_id, v_field.name, null, null, v_entity.id, v_entity.name,
    jsonb_build_object('new', jsonb_build_object('name', v_field.name, 'required', v_field.required, 'type', v_field.type)));
  return v_id;
end;
$$;

create function update_field_definition(
  p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid,
  p_name text, p_slug text, p_required boolean
)
returns table (field_definition_id uuid, violation_count integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare old_field field_definitions%rowtype; new_field field_definitions%rowtype; v_entity entity_types%rowtype; result record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into old_field from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found'; end if;
  select * into v_entity from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  select * into result from public.update_field_definition_core(p_workspace_id, p_entity_type_id, p_field_definition_id, p_name, p_slug, p_required);
  select * into new_field from field_definitions where workspace_id = p_workspace_id and id = p_field_definition_id;
  if old_field.name is distinct from new_field.name or old_field.required is distinct from new_field.required then
    perform private.governance_audit_insert(p_workspace_id, 'field_updated', 'field', new_field.id, new_field.name, null, null, v_entity.id, v_entity.name,
      jsonb_build_object('old', jsonb_build_object('name', old_field.name, 'required', old_field.required), 'new', jsonb_build_object('name', new_field.name, 'required', new_field.required)));
  end if;
  return query select result.field_definition_id, result.violation_count;
end;
$$;

create function archive_field_definition_authorized(p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f field_definitions%rowtype; e entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into f from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found.'; end if;
  select * into e from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  if f.archived_at is null then
    update field_definitions set archived_at = now(), updated_at = now() where workspace_id = p_workspace_id and id = p_field_definition_id;
    perform private.governance_audit_insert(p_workspace_id, 'field_archived', 'field', f.id, f.name, null, null, e.id, e.name,
      jsonb_build_object('old', jsonb_build_object('archived_at', null), 'new', jsonb_build_object('archived_at', now())));
  end if;
end;
$$;

create function restore_field_definition_authorized(p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare f field_definitions%rowtype; e entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into f from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found.'; end if;
  select * into e from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  if f.archived_at is not null then
    update field_definitions set archived_at = null, updated_at = now() where workspace_id = p_workspace_id and id = p_field_definition_id;
    perform private.governance_audit_insert(p_workspace_id, 'field_restored', 'field', f.id, f.name, null, null, e.id, e.name,
      jsonb_build_object('old', jsonb_build_object('archived_at', f.archived_at), 'new', jsonb_build_object('archived_at', null)));
  end if;
end;
$$;

create function add_field_choice_option(p_workspace_id uuid, p_field_definition_id uuid, p_label text, p_color text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; f field_definitions%rowtype; e entity_types%rowtype; o field_choice_options%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into f from field_definitions where workspace_id = p_workspace_id and id = p_field_definition_id;
  if not found or f.type <> 'choice' then raise exception 'Choice field not found'; end if;
  select * into e from entity_types where workspace_id = p_workspace_id and id = f.entity_type_id;
  v_id := public.add_field_choice_option_core(p_workspace_id, p_field_definition_id, p_label, p_color);
  select * into o from field_choice_options where workspace_id = p_workspace_id and id = v_id;
  perform private.governance_audit_insert(p_workspace_id, 'choice_option_created', 'choice_option', o.id, o.label, f.id, f.name, e.id, e.name,
    jsonb_build_object('new', jsonb_build_object('label', o.label)));
  return v_id;
end;
$$;

create function update_field_choice_option(p_workspace_id uuid, p_field_definition_id uuid, p_option_id uuid, p_label text, p_color text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare old_o field_choice_options%rowtype; new_o field_choice_options%rowtype; f field_definitions%rowtype; e entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into old_o from field_choice_options where workspace_id = p_workspace_id and field_definition_id = p_field_definition_id and id = p_option_id for update;
  if not found then raise exception 'Choice option not found'; end if;
  select * into f from field_definitions where workspace_id = p_workspace_id and id = p_field_definition_id;
  select * into e from entity_types where workspace_id = p_workspace_id and id = f.entity_type_id;
  perform public.update_field_choice_option_core(p_workspace_id, p_field_definition_id, p_option_id, p_label, p_color);
  select * into new_o from field_choice_options where workspace_id = p_workspace_id and id = p_option_id;
  if old_o.label is distinct from new_o.label then
    perform private.governance_audit_insert(p_workspace_id, 'choice_option_updated', 'choice_option', new_o.id, new_o.label, f.id, f.name, e.id, e.name,
      jsonb_build_object('old', jsonb_build_object('label', old_o.label), 'new', jsonb_build_object('label', new_o.label)));
  end if;
end;
$$;

create function archive_field_choice_option(p_workspace_id uuid, p_field_definition_id uuid, p_option_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o field_choice_options%rowtype; f field_definitions%rowtype; e entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into o from field_choice_options where workspace_id = p_workspace_id and field_definition_id = p_field_definition_id and id = p_option_id for update;
  if not found then raise exception 'Choice option not found'; end if;
  select * into f from field_definitions where workspace_id = p_workspace_id and id = p_field_definition_id;
  select * into e from entity_types where workspace_id = p_workspace_id and id = f.entity_type_id;
  if o.archived_at is null then
    perform public.archive_field_choice_option_core(p_workspace_id, p_field_definition_id, p_option_id);
    perform private.governance_audit_insert(p_workspace_id, 'choice_option_archived', 'choice_option', o.id, o.label, f.id, f.name, e.id, e.name,
      jsonb_build_object('old', jsonb_build_object('archived_at', null), 'new', jsonb_build_object('archived_at', now())));
  end if;
end;
$$;

create function restore_field_choice_option(p_workspace_id uuid, p_field_definition_id uuid, p_option_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o field_choice_options%rowtype; f field_definitions%rowtype; e entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into o from field_choice_options where workspace_id = p_workspace_id and field_definition_id = p_field_definition_id and id = p_option_id for update;
  if not found then raise exception 'Choice option not found'; end if;
  select * into f from field_definitions where workspace_id = p_workspace_id and id = p_field_definition_id;
  select * into e from entity_types where workspace_id = p_workspace_id and id = f.entity_type_id;
  if o.archived_at is not null then
    perform public.restore_field_choice_option_core(p_workspace_id, p_field_definition_id, p_option_id);
    perform private.governance_audit_insert(p_workspace_id, 'choice_option_restored', 'choice_option', o.id, o.label, f.id, f.name, e.id, e.name,
      jsonb_build_object('old', jsonb_build_object('archived_at', o.archived_at), 'new', jsonb_build_object('archived_at', null)));
  end if;
end;
$$;

-- Replace the existing authorized safe-delete wrapper only; the complete
-- dependency-checking core remains untouched and its return shape is stable.
create or replace function delete_field_definition_if_safe_authorized(p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid)
returns table (deleted boolean, record_value_count bigint, relation_value_count bigint, workflow_reference_count bigint, display_field_reference_count bigint, view_reference_count bigint, process_branch_reference_count bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare f field_definitions%rowtype; e entity_types%rowtype; result record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into f from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found.'; end if;
  select * into e from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id;
  select * into result from public.delete_field_definition_if_safe(p_workspace_id, p_entity_type_id, p_field_definition_id);
  if result.deleted then
    perform private.governance_audit_insert(p_workspace_id, 'field_deleted', 'field', f.id, f.name, null, null, e.id, e.name,
      jsonb_build_object('old', jsonb_build_object('name', f.name, 'required', f.required, 'type', f.type), 'new', null));
  end if;
  return query select result.deleted, result.record_value_count, result.relation_value_count, result.workflow_reference_count, result.display_field_reference_count, result.view_reference_count, result.process_branch_reference_count;
end;
$$;

revoke all on function add_field_definition(uuid, uuid, text, text, text, text, boolean, uuid), update_field_definition(uuid, uuid, uuid, text, text, boolean), add_field_choice_option(uuid, uuid, text, text), update_field_choice_option(uuid, uuid, uuid, text, text), archive_field_choice_option(uuid, uuid, uuid), restore_field_choice_option(uuid, uuid, uuid), archive_field_definition_authorized(uuid, uuid, uuid), restore_field_definition_authorized(uuid, uuid, uuid), delete_field_definition_if_safe_authorized(uuid, uuid, uuid) from public, anon;
grant execute on function add_field_definition(uuid, uuid, text, text, text, text, boolean, uuid), update_field_definition(uuid, uuid, uuid, text, text, boolean), add_field_choice_option(uuid, uuid, text, text), update_field_choice_option(uuid, uuid, uuid, text, text), archive_field_choice_option(uuid, uuid, uuid), restore_field_choice_option(uuid, uuid, uuid), archive_field_definition_authorized(uuid, uuid, uuid), restore_field_definition_authorized(uuid, uuid, uuid), delete_field_definition_if_safe_authorized(uuid, uuid, uuid) to authenticated, service_role;

-- The product now uses the authorized archive/restore RPCs above. Close the
-- former narrow direct lifecycle grant so an authenticated caller cannot
-- bypass semantic capture while retaining schema.manage authority.
revoke update (archived_at, updated_at) on table field_definitions from authenticated;
