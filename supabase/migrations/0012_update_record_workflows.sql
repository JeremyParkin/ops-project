alter table workflows
  drop constraint workflows_action_type_check;

alter table workflows
  alter column action_target_entity_type_id drop not null;

alter table workflows
  add constraint workflows_action_type_check
    check (action_type in ('create_record', 'update_record'));

alter table workflows
  add constraint workflows_action_target_entity_type_id_check
    check (
      (action_type = 'create_record' and action_target_entity_type_id is not null)
      or
      (action_type = 'update_record' and action_target_entity_type_id is null)
    );

create index workflows_trigger_lookup_idx
  on workflows (
    workspace_id,
    trigger_type,
    trigger_entity_type_id,
    enabled,
    created_at,
    id
  );

alter table workflow_execution_logs
  add column action_entity_type_id uuid,
  add column action_record_id uuid,
  add column result_message text;

-- Execution logs are audit/history records. Deliberately avoid foreign keys on
-- action_entity_type_id/action_record_id so logs can survive future hard deletes
-- of affected records or entity types.
