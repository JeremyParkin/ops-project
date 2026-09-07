-- Corrective migration for the audit gap exposed after 0118.
-- The established schema.manage/RLS contract retains authenticated metadata
-- UPDATE access. Capture all successful metadata writes at one table boundary;
-- the supported RPCs therefore do not contain a competing audit insert path.

create or replace function private.capture_entity_type_metadata_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_old_display_name text;
  v_new_display_name text;
begin
  if old.name is distinct from new.name then
    v_changes := v_changes || jsonb_build_object('name', jsonb_build_object('old', old.name, 'new', new.name));
  end if;
  if old.description is distinct from new.description then
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_object('old', old.description, 'new', new.description));
  end if;
  if old.display_field_definition_id is distinct from new.display_field_definition_id then
    if old.display_field_definition_id is not null then
      select name into v_old_display_name from field_definitions where id = old.display_field_definition_id;
    end if;
    if new.display_field_definition_id is not null then
      select name into v_new_display_name from field_definitions where id = new.display_field_definition_id;
    end if;
    v_changes := v_changes || jsonb_build_object('display_field', jsonb_build_object(
      'old', jsonb_build_object('id', old.display_field_definition_id, 'name', v_old_display_name),
      'new', jsonb_build_object('id', new.display_field_definition_id, 'name', v_new_display_name)
    ));
  end if;

  if v_changes <> '{}'::jsonb then
    perform private.governance_audit_insert(
      new.workspace_id, 'entity_type_updated', 'entity_type', new.id, new.name,
      null, null, null, null, v_changes
    );
  end if;
  return new;
end;
$$;

create or replace function public.set_entity_display_field(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_entity entity_types%rowtype;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into old_entity from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id for update;
  if not found then raise exception 'Entity type not found'; end if;
  perform public.set_entity_display_field_core(p_workspace_id, p_entity_type_id, p_field_definition_id);
  return p_entity_type_id;
end;
$$;

drop trigger if exists entity_types_metadata_governance_audit on entity_types;
create trigger entity_types_metadata_governance_audit
  after update of name, description, display_field_definition_id on entity_types
  for each row execute function private.capture_entity_type_metadata_update();

-- Slug follows the canonical metadata save and is not independently edited by
-- the product. Keep it out of the retained direct UPDATE contract.
revoke update (slug) on table entity_types from authenticated;

-- The grouped RPC remains the authoritative validation boundary. The trigger
-- below is the sole semantic capture mechanism for its final UPDATE as well
-- as for the retained direct RLS-protected metadata UPDATE contract.
create or replace function public.update_entity_type_metadata_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_entity_name text,
  p_entity_slug text,
  p_entity_description text,
  p_display_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_entity entity_types%rowtype;
  new_display_name text;
  v_new_description text := nullif(trim(coalesce(p_entity_description, '')), '');
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');
  select * into old_entity from entity_types where workspace_id = p_workspace_id and id = p_entity_type_id for update;
  if not found then raise exception 'Entity type not found'; end if;
  if old_entity.archived_at is not null then raise exception 'Cannot update an archived entity type'; end if;
  if p_display_field_definition_id is not null then
    select name into new_display_name from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_display_field_definition_id and archived_at is null and type = 'text';
    if not found then raise exception 'Display field must be an active text field owned by this entity.'; end if;
  end if;
  update entity_types set name = trim(p_entity_name), slug = trim(p_entity_slug), description = v_new_description,
    display_field_definition_id = p_display_field_definition_id, updated_at = now()
    where workspace_id = p_workspace_id and id = p_entity_type_id;
  return p_entity_type_id;
end;
$$;
