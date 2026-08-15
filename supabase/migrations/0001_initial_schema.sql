create table workspaces (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table entity_types (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, id),
  unique (workspace_id, slug)
);

create table field_definitions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type_id uuid not null,
  key text not null,
  name text not null,
  slug text not null,
  type text not null check (type in ('text', 'number', 'date', 'boolean')),
  required boolean not null default false,
  position integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, key),
  unique (entity_type_id, slug),
  unique (entity_type_id, position),

  foreign key (workspace_id, entity_type_id)
    references entity_types(workspace_id, id)
    on delete cascade
);

create table entity_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type_id uuid not null,
  values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (workspace_id, entity_type_id)
    references entity_types(workspace_id, id)
    on delete cascade
);

create index field_definitions_workspace_entity_type_idx
  on field_definitions (workspace_id, entity_type_id);

create index entity_records_workspace_entity_type_idx
  on entity_records (workspace_id, entity_type_id);
