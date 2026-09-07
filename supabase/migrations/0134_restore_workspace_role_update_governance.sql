-- Restore the audited role-update boundary accidentally replaced by 0132.
-- Keep the workspace.audit.read capability added by 0132 in the inline
-- capability vocabulary.

create or replace function public.update_workspace_role_authorized(
  p_workspace_id uuid,
  p_role_id uuid,
  p_name text,
  p_description text,
  p_capabilities jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before workspace_roles%rowtype;
  v_after workspace_roles%rowtype;
  v_before_caps jsonb;
  v_after_caps jsonb;
  v_capability text;
  v_caller_role uuid;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_roles');
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  select role_id into v_caller_role
  from workspace_memberships
  where workspace_id = p_workspace_id
    and user_id = auth.uid()
  for update;

  if v_caller_role = p_role_id then
    raise exception 'You cannot edit the capabilities of your own role';
  end if;
  if not exists (
    select 1
    from workspace_roles
    where workspace_id = p_workspace_id
      and id = p_role_id
  ) then
    raise exception 'Role not found';
  end if;
  if nullif(trim(p_name), '') is null or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'Role name and capabilities are required';
  end if;

  for v_capability in select jsonb_array_elements_text(p_capabilities) loop
    if v_capability not in (
      'workspace.manage_members',
      'workspace.manage_roles',
      'workspace.manage_organization',
      'workspace.manage_settings',
      'schema.manage',
      'automation.manage',
      'records.operate',
      'processes.operate',
      'operations.view',
      'workspace.impersonate_users',
      'workspace.manage_integrations',
      'people_data.view_all',
      'workspace.audit.read'
    ) then
      raise exception 'Invalid capability';
    end if;
  end loop;

  select * into v_before
  from workspace_roles
  where workspace_id = p_workspace_id
    and id = p_role_id;
  select coalesce(jsonb_agg(capability order by capability), '[]'::jsonb) into v_before_caps
  from workspace_role_capabilities
  where workspace_id = p_workspace_id
    and role_id = p_role_id;

  update workspace_roles
  set name = trim(p_name),
      description = nullif(trim(p_description), ''),
      updated_at = now()
  where workspace_id = p_workspace_id
    and id = p_role_id;

  delete from workspace_role_capabilities
  where workspace_id = p_workspace_id
    and role_id = p_role_id;

  insert into workspace_role_capabilities (workspace_id, role_id, capability)
  select p_workspace_id, p_role_id, value
  from jsonb_array_elements_text(p_capabilities) value;

  perform private.assert_workspace_administrator(p_workspace_id);

  select * into v_after
  from workspace_roles
  where workspace_id = p_workspace_id
    and id = p_role_id;
  select coalesce(jsonb_agg(capability order by capability), '[]'::jsonb) into v_after_caps
  from workspace_role_capabilities
  where workspace_id = p_workspace_id
    and role_id = p_role_id;

  if v_before.name is distinct from v_after.name
     or v_before.description is distinct from v_after.description
     or v_before_caps is distinct from v_after_caps then
    perform private.governance_audit_insert(
      p_workspace_id,
      'workspace_role_updated',
      'workspace_role',
      p_role_id,
      v_after.name,
      null,
      null,
      null,
      null,
      jsonb_build_object(
        'old_name', v_before.name,
        'new_name', v_after.name,
        'old_description', v_before.description,
        'new_description', v_after.description,
        'old_capabilities', v_before_caps,
        'new_capabilities', v_after_caps
      )
    );
  end if;
end;
$$;

revoke all on function public.update_workspace_role_authorized(uuid, uuid, text, text, jsonb)
  from public, anon;
grant execute on function public.update_workspace_role_authorized(uuid, uuid, text, text, jsonb)
  to authenticated, service_role;
