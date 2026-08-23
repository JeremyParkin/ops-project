create table workspace_memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_memberships_user_workspace_idx
  on workspace_memberships (user_id, workspace_id);

create schema if not exists private;
revoke all on schema private from public;

-- This fixed-search-path helper is the only SECURITY DEFINER function in this
-- migration. It allows RLS policies to check membership without recursively
-- querying a table that is itself protected by RLS.
create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships membership
    where membership.workspace_id = p_workspace_id
      and membership.user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_workspace_member(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated;

alter table workspaces enable row level security;
alter table workspace_memberships enable row level security;
alter table entity_types enable row level security;
alter table field_definitions enable row level security;
alter table entity_records enable row level security;
alter table entity_record_relation_values enable row level security;
alter table entity_views enable row level security;
alter table workflows enable row level security;
alter table workflow_execution_logs enable row level security;

create policy workspaces_select_member on workspaces
  for select to authenticated
  using ((select private.is_workspace_member(id)));

create policy workspace_memberships_select_own on workspace_memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy entity_types_member_access on entity_types
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy field_definitions_member_access on field_definitions
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy entity_records_member_access on entity_records
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy entity_record_relation_values_member_access on entity_record_relation_values
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy entity_views_member_access on entity_views
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy workflows_member_access on workflows
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy workflow_execution_logs_member_access on workflow_execution_logs
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

revoke all on table workspaces, workspace_memberships, entity_types,
  field_definitions, entity_records, entity_record_relation_values, entity_views,
  workflows, workflow_execution_logs from anon, authenticated;

grant select on table workspaces, workspace_memberships to authenticated;
grant select, insert, update, delete on table entity_types, field_definitions,
  entity_records, entity_record_relation_values, entity_views, workflows,
  workflow_execution_logs to authenticated;

revoke all on function create_entity_type_with_fields(uuid, text, text, text, jsonb) from public;
revoke all on function add_field_definition(uuid, uuid, text, text, text, text, boolean, uuid) from public;
revoke all on function update_field_definition(uuid, uuid, uuid, text, text, boolean) from public;
revoke all on function create_entity_record_with_relations(uuid, uuid, jsonb, jsonb) from public;
revoke all on function update_entity_record_with_relations(uuid, uuid, uuid, jsonb, jsonb, jsonb) from public;
revoke all on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) from public;
revoke all on function delete_entity_type_if_safe(uuid, uuid) from public;
revoke all on function delete_field_definition_if_safe(uuid, uuid, uuid) from public;
revoke all on function set_entity_display_field(uuid, uuid, uuid) from public;
revoke all on function set_entity_default_view(uuid, uuid, uuid) from public;

grant execute on function create_entity_type_with_fields(uuid, text, text, text, jsonb) to authenticated, service_role;
grant execute on function add_field_definition(uuid, uuid, text, text, text, text, boolean, uuid) to authenticated, service_role;
grant execute on function update_field_definition(uuid, uuid, uuid, text, text, boolean) to authenticated, service_role;
grant execute on function create_entity_record_with_relations(uuid, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function update_entity_record_with_relations(uuid, uuid, uuid, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function delete_entity_record_if_unreferenced(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function delete_entity_type_if_safe(uuid, uuid) to authenticated, service_role;
grant execute on function delete_field_definition_if_safe(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function set_entity_display_field(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function set_entity_default_view(uuid, uuid, uuid) to authenticated, service_role;
