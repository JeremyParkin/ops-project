alter table workflow_execution_logs
  drop constraint workflow_execution_logs_status_check;

alter table workflow_execution_logs
  add constraint workflow_execution_logs_status_check
  check (status in ('succeeded', 'failed', 'skipped'));
