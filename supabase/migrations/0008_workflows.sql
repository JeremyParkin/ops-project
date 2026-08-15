create table workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  enabled boolean not null default true,
  trigger_type text not null check (trigger_type = 'record_created'),
  trigger_entity_type_id uuid not null,
  action_type text not null check (action_type = 'create_record'),
  action_target_entity_type_id uuid not null,
  action_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (workspace_id, trigger_entity_type_id)
    references entity_types(workspace_id, id)
    on delete cascade,

  foreign key (workspace_id, action_target_entity_type_id)
    references entity_types(workspace_id, id)
    on delete cascade
);

create index workflows_record_created_lookup_idx
  on workflows (
    workspace_id,
    trigger_type,
    trigger_entity_type_id,
    enabled
  );

create index workflows_workspace_created_at_idx
  on workflows (workspace_id, created_at);

create table workflow_execution_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  trigger_entity_type_id uuid not null,
  trigger_record_id uuid not null,
  status text not null check (status in ('succeeded', 'failed')),
  error_message text,
  created_record_id uuid,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index workflow_execution_logs_workflow_started_idx
  on workflow_execution_logs (workspace_id, workflow_id, started_at desc);

create index workflow_execution_logs_trigger_record_idx
  on workflow_execution_logs (
    workspace_id,
    trigger_entity_type_id,
    trigger_record_id
  );
