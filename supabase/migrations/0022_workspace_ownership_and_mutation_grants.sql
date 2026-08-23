-- A user can belong to more than one workspace, but a persisted domain row
-- belongs to exactly one workspace for its lifetime. RLS alone permits a
-- cross-workspace UPDATE when both the old and new workspace are memberships.
create or replace function private.reject_workspace_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id is immutable after creation'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger entity_types_workspace_id_immutable
  before update on entity_types
  for each row execute function private.reject_workspace_id_change();

create trigger field_definitions_workspace_id_immutable
  before update on field_definitions
  for each row execute function private.reject_workspace_id_change();

create trigger entity_records_workspace_id_immutable
  before update on entity_records
  for each row execute function private.reject_workspace_id_change();

create trigger entity_record_relation_values_workspace_id_immutable
  before update on entity_record_relation_values
  for each row execute function private.reject_workspace_id_change();

create trigger entity_views_workspace_id_immutable
  before update on entity_views
  for each row execute function private.reject_workspace_id_change();

create trigger workflows_workspace_id_immutable
  before update on workflows
  for each row execute function private.reject_workspace_id_change();

create trigger workflow_execution_logs_workspace_id_immutable
  before update on workflow_execution_logs
  for each row execute function private.reject_workspace_id_change();

-- Normal runtime writes use RPCs for structural entity, field, record, and
-- relation mutation. Keep only direct lifecycle/metadata columns where the
-- repositories currently require them. Views, workflows, and execution logs
-- still use direct repository writes pending dedicated mutation RPCs.
revoke insert, update, delete on table entity_types from authenticated;
revoke insert, update, delete on table field_definitions from authenticated;
revoke insert, update, delete on table entity_records from authenticated;
revoke insert, update, delete on table entity_record_relation_values from authenticated;
revoke insert, update, delete on table entity_views from authenticated;
revoke insert, update, delete on table workflows from authenticated;
revoke insert, update, delete on table workflow_execution_logs from authenticated;

grant update (name, slug, description, archived_at, updated_at)
  on table entity_types to authenticated;
grant update (archived_at, updated_at)
  on table field_definitions to authenticated;
grant update (archived_at, updated_at)
  on table entity_records to authenticated;

grant insert, update, delete on table entity_views to authenticated;
grant insert, update, delete on table workflows to authenticated;
grant insert on table workflow_execution_logs to authenticated;

comment on function private.reject_workspace_id_change()
  is 'Prevents multi-membership users from reassigning persisted domain rows to another workspace.';
