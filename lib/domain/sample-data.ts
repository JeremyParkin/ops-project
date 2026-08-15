import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
  Workspace,
} from "./types";
import { DEMO_WORKSPACE_ID } from "./demo-ids";

const demoClientEntityTypeId = "22222222-2222-4222-8222-222222222222";

const now = "2026-08-14T00:00:00.000Z";

export const sampleWorkspace: Workspace = {
  id: DEMO_WORKSPACE_ID,
  name: "Demo Workspace",
  createdAt: now,
  updatedAt: now,
};

export const sampleEntityType: EntityType = {
  id: demoClientEntityTypeId,
  workspaceId: sampleWorkspace.id,
  name: "Client",
  slug: "client",
  description: "Organizations or people the business works with.",
  createdAt: now,
  updatedAt: now,
};

export const sampleFieldDefinitions: FieldDefinition[] = [
  {
    id: "33333333-3333-4333-8333-333333333331",
    workspaceId: sampleWorkspace.id,
    entityTypeId: sampleEntityType.id,
    key: "fld_client_name",
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "33333333-3333-4333-8333-333333333332",
    workspaceId: sampleWorkspace.id,
    entityTypeId: sampleEntityType.id,
    key: "fld_client_annual_revenue",
    name: "Annual Revenue",
    slug: "annual-revenue",
    type: "number",
    required: false,
    position: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: sampleWorkspace.id,
    entityTypeId: sampleEntityType.id,
    key: "fld_client_start_date",
    name: "Start Date",
    slug: "start-date",
    type: "date",
    required: false,
    position: 3,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "33333333-3333-4333-8333-333333333334",
    workspaceId: sampleWorkspace.id,
    entityTypeId: sampleEntityType.id,
    key: "fld_client_active",
    name: "Active",
    slug: "active",
    type: "boolean",
    required: true,
    position: 4,
    createdAt: now,
    updatedAt: now,
  },
];

export const sampleEntityRecords: EntityRecord[] = [
  {
    id: "44444444-4444-4444-8444-444444444441",
    workspaceId: sampleWorkspace.id,
    entityTypeId: sampleEntityType.id,
    values: {
      fld_client_name: "Acme Industries",
      fld_client_annual_revenue: 1250000,
      fld_client_start_date: "2024-03-15",
      fld_client_active: true,
    },
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "44444444-4444-4444-8444-444444444442",
    workspaceId: sampleWorkspace.id,
    entityTypeId: sampleEntityType.id,
    values: {
      fld_client_name: "Northstar Studio",
      fld_client_annual_revenue: 420000,
      fld_client_start_date: "2025-01-08",
      fld_client_active: true,
    },
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "44444444-4444-4444-8444-444444444443",
    workspaceId: sampleWorkspace.id,
    entityTypeId: sampleEntityType.id,
    values: {
      fld_client_name: "Riverbend Co.",
      fld_client_annual_revenue: 98000,
      fld_client_start_date: "2023-11-21",
      fld_client_active: false,
    },
    createdAt: now,
    updatedAt: now,
  },
];
