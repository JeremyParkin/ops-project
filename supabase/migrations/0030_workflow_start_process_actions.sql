-- Workflow action references are stored in workflows.actions JSONB rather than
-- a foreign-key column. Preserve the safe-delete contract by explicitly
-- blocking deletion of a process template still referenced by any action.
drop function if exists delete_process_template_if_safe_authorized(uuid, uuid);

create function delete_process_template_if_safe_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns table (
  deleted boolean,
  run_count integer,
  workflow_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_count integer := 0;
  v_workflow_count integer := 0;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  if not exists (
    select 1 from process_templates
    where workspace_id = p_workspace_id and id = p_process_template_id
  ) then
    raise exception 'Process template not found';
  end if;

  select count(*) into v_run_count
  from process_runs
  where workspace_id = p_workspace_id
    and process_template_id = p_process_template_id;

  select count(*) into v_workflow_count
  from workflows w
  where w.workspace_id = p_workspace_id
    and exists (
      select 1
      from jsonb_array_elements(w.actions) as action
      where action ->> 'actionType' = 'start_process'
        and action ->> 'processTemplateId' = p_process_template_id::text
    );

  if v_run_count > 0 or v_workflow_count > 0 then
    return query select false, v_run_count, v_workflow_count;
    return;
  end if;

  delete from process_templates
  where workspace_id = p_workspace_id and id = p_process_template_id;

  return query select true, 0, 0;
end;
$$;

revoke all on function delete_process_template_if_safe_authorized(uuid, uuid) from public;
grant execute on function delete_process_template_if_safe_authorized(uuid, uuid) to authenticated, service_role;

comment on function delete_process_template_if_safe_authorized(uuid, uuid)
  is 'Membership-checked safe deletion for process templates. Blocks deletion when process runs or workflow start_process actions reference the template.';
