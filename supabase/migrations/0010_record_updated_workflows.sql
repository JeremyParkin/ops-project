alter table workflows
  drop constraint workflows_trigger_type_check;

alter table workflows
  add constraint workflows_trigger_type_check
  check (trigger_type in ('record_created', 'record_updated'));
