-- Record Work / Work Settings v1a -- corrective fix for
-- list_assigned_record_work_authorized (0150).
--
-- 0150 filtered archived records (er.archived_at is null) but not archived
-- EntityTypes, so a record belonging to an archived business object could
-- still surface in My Work -> Assigned records. Archived EntityTypes are
-- not active operational surfaces (see 0117's archive lifecycle -- process
-- templates, approval nodes, and condition/event waits all already refuse
-- to reference an archived entity_type), so this projection should not
-- contribute current assigned work for one either.
--
-- Faithful copy of 0150's function body with exactly one added condition:
-- and et.archived_at is null.
create or replace function list_assigned_record_work_authorized(
  p_workspace_id uuid
)
returns table (
  entity_type_id uuid,
  entity_type_name text,
  record_id uuid,
  due_date date,
  is_overdue boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  v_user_id := private.current_effective_user(p_workspace_id);
  if v_user_id is null then
    return;
  end if;

  return query
  select
    et.id,
    et.name,
    er.id,
    case when due_field.id is not null then
      nullif(er.values ->> due_field.key, '')::date
    end,
    case when due_field.id is not null and nullif(er.values ->> due_field.key, '') is not null then
      nullif(er.values ->> due_field.key, '')::date < (now() at time zone w.timezone)::date
    else false end
  from entity_record_workspace_member_values v
  join entity_types et
    on et.workspace_id = v.workspace_id
   and et.id = v.source_entity_type_id
   and et.work_assignment_field_id = v.field_definition_id
  join workspaces w on w.id = et.workspace_id
  join entity_records er
    on er.workspace_id = v.workspace_id
   and er.entity_type_id = v.source_entity_type_id
   and er.id = v.source_record_id
  left join field_definitions due_field on due_field.id = et.work_due_field_id
  left join field_definitions status_field on status_field.id = et.work_status_field_id
  where v.workspace_id = p_workspace_id
    and v.member_user_id = v_user_id
    and et.work_enabled
    and et.archived_at is null
    and er.archived_at is null
    and (
      status_field.id is null
      or not exists (
        select 1 from entity_type_work_completion_options completion
        where completion.workspace_id = et.workspace_id
          and completion.entity_type_id = et.id
          and completion.option_id::text = (er.values ->> status_field.key)
      )
    )
    and private.can_view_people_sensitive_record(p_workspace_id, et.id, er.id, v_user_id);
end;
$$;

revoke all on function list_assigned_record_work_authorized(uuid) from public, anon;
grant execute on function list_assigned_record_work_authorized(uuid) to authenticated, service_role;
