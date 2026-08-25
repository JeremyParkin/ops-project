-- Corrective migration for environments where 0038 was already applied.
-- Keep regular relation clears/replacements observable while avoiding an
-- outbox insert after a workspace cascade has already removed its parent row.

create or replace function private.enqueue_process_condition_wait_relation_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row entity_record_relation_values%rowtype;
begin
  v_row := case when TG_OP = 'DELETE' then OLD else NEW end;
  if not exists (select 1 from workspaces where id = v_row.workspace_id) then
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
  end if;
  perform private.enqueue_process_condition_wait_wakeup(
    v_row.workspace_id,
    v_row.source_entity_type_id,
    v_row.source_record_id,
    v_row.field_definition_id,
    'relation_changed'
  );
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

revoke all on function private.enqueue_process_condition_wait_relation_change()
  from public, anon, authenticated, service_role;
