insert into workspaces (id, name, created_at, updated_at)
values (
  '11111111-1111-4111-8111-111111111111',
  'Demo Workspace',
  '2026-08-14T00:00:00.000Z',
  '2026-08-14T00:00:00.000Z'
)
on conflict (id) do nothing;

insert into entity_types (
  id,
  workspace_id,
  name,
  slug,
  description,
  created_at,
  updated_at
)
values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'Client',
  'client',
  'Organizations or people the business works with.',
  '2026-08-14T00:00:00.000Z',
  '2026-08-14T00:00:00.000Z'
)
on conflict (id) do nothing;

insert into field_definitions (
  id,
  workspace_id,
  entity_type_id,
  key,
  name,
  slug,
  type,
  required,
  position,
  created_at,
  updated_at
)
values
  (
    '33333333-3333-4333-8333-333333333331',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'fld_client_name',
    'Name',
    'name',
    'text',
    true,
    1,
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T00:00:00.000Z'
  ),
  (
    '33333333-3333-4333-8333-333333333332',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'fld_client_annual_revenue',
    'Annual Revenue',
    'annual-revenue',
    'number',
    false,
    2,
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T00:00:00.000Z'
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'fld_client_start_date',
    'Start Date',
    'start-date',
    'date',
    false,
    3,
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T00:00:00.000Z'
  ),
  (
    '33333333-3333-4333-8333-333333333334',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'fld_client_active',
    'Active',
    'active',
    'boolean',
    true,
    4,
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T00:00:00.000Z'
  )
on conflict (id) do nothing;

insert into entity_records (
  id,
  workspace_id,
  entity_type_id,
  values,
  created_at,
  updated_at
)
values
  (
    '44444444-4444-4444-8444-444444444441',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '{"fld_client_name":"Acme Industries","fld_client_annual_revenue":1250000,"fld_client_start_date":"2024-03-15","fld_client_active":true}'::jsonb,
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T00:00:00.000Z'
  ),
  (
    '44444444-4444-4444-8444-444444444442',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '{"fld_client_name":"Northstar Studio","fld_client_annual_revenue":420000,"fld_client_start_date":"2025-01-08","fld_client_active":true}'::jsonb,
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T00:00:00.000Z'
  ),
  (
    '44444444-4444-4444-8444-444444444443',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '{"fld_client_name":"Riverbend Co.","fld_client_annual_revenue":98000,"fld_client_start_date":"2023-11-21","fld_client_active":false}'::jsonb,
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T00:00:00.000Z'
  )
on conflict (id) do nothing;
