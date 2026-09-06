-- Phase 13.2A: preserve Workflow execution history independently of the
-- mutable Workflow definition. The UUID remains a historical soft ID; it is
-- intentionally not a foreign key because deleting a Workflow must not delete
-- its execution logs or block that deletion.

alter table workflow_execution_logs
  drop constraint if exists workflow_execution_logs_workflow_id_fkey;

alter table workflow_execution_logs
  add column if not exists workflow_name_snapshot text,
  add column if not exists trigger_entity_type_name_snapshot text,
  add column if not exists trigger_context_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists action_context_snapshot jsonb not null default '[]'::jsonb;

comment on column workflow_execution_logs.workflow_id is
  'Historical originating Workflow UUID. This is a soft reference and intentionally has no foreign key.';

comment on column workflow_execution_logs.workflow_name_snapshot is
  'Workflow name captured at execution time; remains available after Workflow deletion.';

comment on column workflow_execution_logs.trigger_entity_type_name_snapshot is
  'Trigger EntityType name captured at execution time.';

comment on column workflow_execution_logs.trigger_context_snapshot is
  'Minimal immutable trigger context: trigger type, watched-field labels, and configured conditions.';

comment on column workflow_execution_logs.action_context_snapshot is
  'Minimal immutable ordered action context with human-readable target, relation, and Process labels. action_results remains the outcome record.';
