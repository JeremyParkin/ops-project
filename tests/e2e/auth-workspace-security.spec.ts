import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });

type SecurityFixture = {
  workspaceAId: string;
  workspaceBId: string;
  entityAId: string;
  entityBId: string;
  recordAId: string;
  recordBId: string;
  viewBId: string;
  workflowBId: string;
  userA: { email: string; password: string; id: string };
  userB: { email: string; password: string; id: string };
  noMembershipUser: { email: string; password: string; id: string };
};

const allCapabilities = [
  "workspace.manage_members", "workspace.manage_roles", "workspace.manage_organization", "workspace.manage_settings",
  "schema.manage", "automation.manage", "records.operate", "processes.operate", "operations.view",
];

let fixture: SecurityFixture;

function uniqueEmail(label: string) {
  return `e2e-auth-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string) {
  const admin = createSupabaseTestClient();
  const password = `Auth-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: uniqueEmail(label),
    password,
    email_confirm: true,
  });

  if (error || !data.user) throw new Error(error?.message ?? "Unable to create E2E user.");
  return { email: data.user.email!, password, id: data.user.id };
}

async function createCompatibilityRole(workspaceId: string) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({
    id: roleId,
    workspace_id: workspaceId,
    name: "E2E workspace administrator",
    is_builtin: true,
  });
  if (roleError) throw new Error(roleError.message);
  const { error: capabilityError } = await admin.from("workspace_role_capabilities").insert(
    allCapabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })),
  );
  if (capabilityError) throw new Error(capabilityError.message);
  return roleId;
}

async function createFixture(): Promise<SecurityFixture> {
  const admin = createSupabaseTestClient();
  const workspaceAId = randomUUID();
  const workspaceBId = randomUUID();
  const entityAId = randomUUID();
  const entityBId = randomUUID();
  const recordAId = randomUUID();
  const recordBId = randomUUID();
  const fieldAId = randomUUID();
  const fieldBId = randomUUID();
  const viewBId = randomUUID();
  const workflowBId = randomUUID();
  const userA = await createUser("a");
  const userB = await createUser("b");
  const noMembershipUser = await createUser("none");

  const { error: workspaceError } = await admin.from("workspaces").insert([
    { id: workspaceAId, name: `E2E Auth A ${workspaceAId.slice(0, 8)}` },
    { id: workspaceBId, name: `E2E Auth B ${workspaceBId.slice(0, 8)}` },
  ]);
  if (workspaceError) throw new Error(workspaceError.message);
  const [roleAId, roleBId] = await Promise.all([
    createCompatibilityRole(workspaceAId),
    createCompatibilityRole(workspaceBId),
  ]);

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceAId, user_id: userA.id, role_id: roleAId },
    { workspace_id: workspaceBId, user_id: userB.id, role_id: roleBId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const { error: entityError } = await admin.from("entity_types").insert([
    { id: entityAId, workspace_id: workspaceAId, name: "E2E Auth Alpha", slug: `e2e-auth-alpha-${workspaceAId.slice(0, 8)}` },
    { id: entityBId, workspace_id: workspaceBId, name: "E2E Auth Bravo", slug: `e2e-auth-bravo-${workspaceBId.slice(0, 8)}` },
  ]);
  if (entityError) throw new Error(entityError.message);

  const { error: fieldError } = await admin.from("field_definitions").insert([
    { id: fieldAId, workspace_id: workspaceAId, entity_type_id: entityAId, key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1 },
    { id: fieldBId, workspace_id: workspaceBId, entity_type_id: entityBId, key: "name", name: "Name", slug: "name", type: "text", required: false, position: 1 },
  ]);
  if (fieldError) throw new Error(fieldError.message);

  const { error: recordError } = await admin.from("entity_records").insert([
    { id: recordAId, workspace_id: workspaceAId, entity_type_id: entityAId, values: { name: "Alpha record" } },
    { id: recordBId, workspace_id: workspaceBId, entity_type_id: entityBId, values: { name: "Bravo record" } },
  ]);
  if (recordError) throw new Error(recordError.message);

  const { error: viewError } = await admin.from("entity_views").insert({
    id: viewBId,
    workspace_id: workspaceBId,
    entity_type_id: entityBId,
    name: "Bravo view",
    position: 1,
  });
  if (viewError) throw new Error(viewError.message);

  const { error: workflowError } = await admin.from("workflows").insert({
    id: workflowBId,
    workspace_id: workspaceBId,
    name: "Bravo workflow",
    enabled: false,
    trigger_type: "record_created",
    trigger_entity_type_id: entityBId,
    action_config: { triggerConfig: {}, conditions: [] },
    actions: [{ actionType: "create_record", actionTargetEntityTypeId: entityBId, fieldMappings: [] }],
  });
  if (workflowError) throw new Error(workflowError.message);

  return {
    workspaceAId, workspaceBId, entityAId, entityBId, recordAId, recordBId,
    viewBId, workflowBId, userA, userB, noMembershipUser,
  };
}

async function cleanupFixture(current: SecurityFixture) {
  const admin = createSupabaseTestClient();
  const { error: workspaceError } = await admin
    .from("workspaces")
    .delete()
    .in("id", [current.workspaceAId, current.workspaceBId]);
  if (workspaceError) throw new Error(workspaceError.message);

  for (const user of [current.userA, current.userB, current.noMembershipUser]) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(error.message);
  }

  const { data: remainingWorkspaces, error: remainingWorkspaceError } = await admin
    .from("workspaces")
    .select("id")
    .in("id", [current.workspaceAId, current.workspaceBId]);
  if (remainingWorkspaceError || remainingWorkspaces?.length) {
    throw new Error(remainingWorkspaceError?.message ?? "E2E workspaces were not removed.");
  }
}

async function cleanupStaleSecurityFixtures() {
  const admin = createSupabaseTestClient();
  const { data: workspaces, error: workspaceLookupError } = await admin
    .from("workspaces")
    .select("id")
    .ilike("name", "E2E Auth %");
  if (workspaceLookupError) throw new Error(workspaceLookupError.message);

  if (workspaces?.length) {
    const { error } = await admin
      .from("workspaces")
      .delete()
      .in("id", workspaces.map((workspace) => workspace.id));
    if (error) throw new Error(error.message);
  }

  const { data: users, error: userLookupError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (userLookupError) throw new Error(userLookupError.message);

  for (const user of users.users.filter((candidate) =>
    candidate.email?.startsWith("e2e-auth-"),
  )) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(error.message);
  }
}

async function authenticatedClient(user: SecurityFixture["userA"]): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw new Error(error.message);
  return client;
}

async function signIn(page: Page, user: SecurityFixture["userA"]) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.beforeAll(async () => {
  await cleanupStaleSecurityFixtures();
  fixture = await createFixture();
});

test.afterAll(async () => {
  if (fixture) {
    await cleanupFixture(fixture);
  }
});

test("protects routes, signs users in and out, and rejects no-membership users", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);

  await signIn(page, fixture.userA);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "E2E Auth Alpha", exact: true })).toBeVisible();
  await expect(page.getByText("E2E Auth Bravo", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await signIn(page, fixture.noMembershipUser);
  await expect(page).toHaveURL(/\/no-workspace/);
  await expect(page.getByRole("heading", { name: "No workspace access" })).toBeVisible();
});

test("ignores an unauthorized active-workspace cookie", async ({ page, context }) => {
  await context.addCookies([
    { name: "active_workspace_id", value: fixture.workspaceBId, url: "http://localhost:3100" },
  ]);
  await signIn(page, fixture.userA);

  await expect(page.getByRole("heading", { name: "E2E Auth Alpha", exact: true })).toBeVisible();
  await expect(page.getByText("E2E Auth Bravo", { exact: true })).toHaveCount(0);
});

test("RLS blocks cross-workspace table and RPC access while own operations work", async () => {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const anonymousClient = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anonymousRpc = await anonymousClient.rpc("create_entity_record_with_relations", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_values: { name: "anonymous" },
    p_relations: [],
  });
  expect(anonymousRpc.error).not.toBeNull();
  const anonymousWrapper = await anonymousClient.rpc(
    "create_entity_record_with_relations_authorized",
    {
      p_workspace_id: fixture.workspaceAId,
      p_entity_type_id: fixture.entityAId,
      p_values: { name: "anonymous" },
      p_relations: [],
    },
  );
  expect(anonymousWrapper.error).not.toBeNull();
  const anonymousSafeEntityDelete = await anonymousClient.rpc(
    "delete_entity_type_if_safe_authorized",
    { p_workspace_id: fixture.workspaceAId, p_entity_type_id: fixture.entityAId },
  );
  expect(anonymousSafeEntityDelete.error).not.toBeNull();
  const anonymousSafeFieldDelete = await anonymousClient.rpc(
    "delete_field_definition_if_safe_authorized",
    {
      p_workspace_id: fixture.workspaceAId,
      p_entity_type_id: fixture.entityAId,
      p_field_definition_id: randomUUID(),
    },
  );
  expect(anonymousSafeFieldDelete.error).not.toBeNull();

  const client = await authenticatedClient(fixture.userA);
  const clientB = await authenticatedClient(fixture.userB);

  const ownEntities = await client.from("entity_types").select("id").eq("id", fixture.entityAId);
  expect(ownEntities.error).toBeNull();
  expect(ownEntities.data).toHaveLength(1);

  const ownEntitiesB = await clientB
    .from("entity_types")
    .select("id")
    .eq("id", fixture.entityBId);
  expect(ownEntitiesB.error).toBeNull();
  expect(ownEntitiesB.data).toHaveLength(1);
  const deniedEntitiesB = await clientB
    .from("entity_types")
    .select("id")
    .eq("id", fixture.entityAId);
  expect(deniedEntitiesB.error).toBeNull();
  expect(deniedEntitiesB.data).toEqual([]);

  for (const [table, id] of [
    ["entity_types", fixture.entityBId],
    ["entity_records", fixture.recordBId],
    ["entity_views", fixture.viewBId],
    ["workflows", fixture.workflowBId],
  ] as const) {
    const result = await client.from(table).select("id").eq("id", id);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  }

  const deniedInsert = await client.from("entity_records").insert({
    workspace_id: fixture.workspaceBId,
    entity_type_id: fixture.entityBId,
    values: { name: "forged" },
  });
  expect(deniedInsert.error).not.toBeNull();

  const deniedCreateRecord = await client.rpc("create_entity_record_with_relations", {
    p_workspace_id: fixture.workspaceBId,
    p_entity_type_id: fixture.entityBId,
    p_values: { name: "forged" },
    p_relations: [],
  });
  expect(deniedCreateRecord.error).not.toBeNull();

  const deniedAuthorizedCreateRecord = await client.rpc(
    "create_entity_record_with_relations_authorized",
    {
      p_workspace_id: fixture.workspaceBId,
      p_entity_type_id: fixture.entityBId,
      p_values: { name: "forged" },
      p_relations: [],
    },
  );
  expect(deniedAuthorizedCreateRecord.error).not.toBeNull();

  const deniedOriginalUpdate = await client.rpc("update_entity_record_with_relations", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_record_id: fixture.recordAId,
    p_values: { name: "forged" },
    p_relation_field_ids: [],
    p_relations: [],
  });
  expect(deniedOriginalUpdate.error).not.toBeNull();
  const deniedOriginalDelete = await client.rpc("delete_entity_record_if_unreferenced", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_record_id: fixture.recordAId,
  });
  expect(deniedOriginalDelete.error).not.toBeNull();
  const deniedOriginalEntityDelete = await client.rpc("delete_entity_type_if_safe", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
  });
  expect(deniedOriginalEntityDelete.error).not.toBeNull();
  const deniedOriginalFieldDelete = await client.rpc("delete_field_definition_if_safe", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_field_definition_id: randomUUID(),
  });
  expect(deniedOriginalFieldDelete.error).not.toBeNull();

  const deniedAddField = await client.rpc("add_field_definition", {
    p_workspace_id: fixture.workspaceBId,
    p_entity_type_id: fixture.entityBId,
    p_name: "Forged",
    p_slug: "forged",
    p_key: "forged",
    p_type: "text",
    p_required: false,
    p_related_entity_type_id: null,
  });
  expect(deniedAddField.error).not.toBeNull();

  const directRequiredRecordInsert = await client.from("entity_records").insert({
    workspace_id: fixture.workspaceAId,
    entity_type_id: fixture.entityAId,
    values: {},
  });
  expect(directRequiredRecordInsert.error).not.toBeNull();

  const admin = createSupabaseTestClient();
  const { data: workspaceBRole, error: workspaceBRoleError } = await admin
    .from("workspace_roles")
    .select("id")
    .eq("workspace_id", fixture.workspaceBId)
    .single();
  expect(workspaceBRoleError).toBeNull();
  const { error: secondMembershipError } = await admin
    .from("workspace_memberships")
    .insert({
      workspace_id: fixture.workspaceBId,
      user_id: fixture.userA.id,
      role_id: workspaceBRole?.id,
    });
  expect(secondMembershipError).toBeNull();

  const rejectedReassignment = await client
    .from("entity_types")
    .update({ workspace_id: fixture.workspaceBId })
    .eq("id", fixture.entityAId);
  expect(rejectedReassignment.error).not.toBeNull();

  const sameWorkspaceUpdate = await client
    .from("entity_types")
    .update({ name: "E2E Auth Alpha Updated" })
    .eq("id", fixture.entityAId);
  expect(sameWorkspaceUpdate.error).toBeNull();

  const newEntity = await client.rpc("create_entity_type_with_fields", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_name: "E2E Auth Created",
    p_entity_slug: `e2e-auth-created-${randomUUID().slice(0, 8)}`,
    p_entity_description: null,
    p_fields: [{ key: "title", name: "Title", slug: "title", type: "text", required: false, position: 1 }],
  });
  expect(newEntity.error).toBeNull();
  expect(newEntity.data).toBeTruthy();
  const relatedEntityTypeId = String(newEntity.data);

  const targetRecord = await client.rpc("create_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: relatedEntityTypeId,
    p_values: { title: "Created by authenticated user" },
    p_relations: [],
  });
  expect(targetRecord.error).toBeNull();
  const targetRecordId = String(targetRecord.data);

  const relationField = await client.rpc("add_field_definition", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_name: "Related created record",
    p_slug: "related-created-record",
    p_key: "related_created_record",
    p_type: "relation",
    p_required: false,
    p_related_entity_type_id: relatedEntityTypeId,
  });
  expect(relationField.error).toBeNull();
  const relationFieldId = String(relationField.data);

  const sourceRecord = await client.rpc("create_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_values: { name: "Canonical source record" },
    p_relations: [{
      field_definition_id: relationFieldId,
      target_entity_type_id: relatedEntityTypeId,
      target_record_id: targetRecordId,
    }],
  });
  expect(sourceRecord.error).toBeNull();
  const sourceRecordId = String(sourceRecord.data);

  const updatedSourceRecord = await client.rpc("update_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_record_id: sourceRecordId,
    p_values: { name: "Canonical source record updated" },
    p_relation_field_ids: [relationFieldId],
    p_relations: [{
      field_definition_id: relationFieldId,
      target_entity_type_id: relatedEntityTypeId,
      target_record_id: targetRecordId,
    }],
  });
  expect(updatedSourceRecord.error).toBeNull();

  const rawEntityInsert = await client.from("entity_types").insert({
    id: randomUUID(),
    workspace_id: fixture.workspaceAId,
    name: "Raw entity",
    slug: `raw-entity-${randomUUID().slice(0, 8)}`,
  });
  expect(rawEntityInsert.error).toBeNull();
  const rawEntityDelete = await client
    .from("entity_types")
    .delete()
    .eq("id", relatedEntityTypeId);
  expect(rawEntityDelete.error).not.toBeNull();

  const safeEntity = await client.rpc("create_entity_type_with_fields", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_name: "E2E Safe Delete Entity",
    p_entity_slug: `e2e-safe-delete-${randomUUID().slice(0, 8)}`,
    p_entity_description: null,
    p_fields: [{ key: "safe_delete_name", name: "Name", slug: "name", type: "text", required: false, position: 1 }],
  });
  expect(safeEntity.error).toBeNull();
  const safeEntityDelete = await client.rpc("delete_entity_type_if_safe_authorized", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: String(safeEntity.data),
  });
  expect((safeEntityDelete.data as Array<{ deleted: boolean }>)[0]?.deleted).toBe(true);

  const archivedField = await client
    .from("field_definitions")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", relationFieldId);
  expect(archivedField.error).toBeNull();
  const restoredField = await client
    .from("field_definitions")
    .update({ archived_at: null })
    .eq("id", relationFieldId);
  expect(restoredField.error).toBeNull();
  const rawFieldChange = await client
    .from("field_definitions")
    .update({ name: "Raw field change" })
    .eq("id", relationFieldId);
  expect(rawFieldChange.error).toBeNull();
  const rawFieldDelete = await client
    .from("field_definitions")
    .delete()
    .eq("id", relationFieldId);
  expect(rawFieldDelete.error).not.toBeNull();

  const safeField = await client.rpc("add_field_definition", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_name: "Safe delete field",
    p_slug: "safe-delete-field",
    p_key: "safe_delete_field",
    p_type: "text",
    p_required: false,
    p_related_entity_type_id: null,
  });
  expect(safeField.error).toBeNull();
  const safeFieldDelete = await client.rpc("delete_field_definition_if_safe_authorized", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_field_definition_id: String(safeField.data),
  });
  expect((safeFieldDelete.data as Array<{ deleted: boolean }>)[0]?.deleted).toBe(true);

  const archivedRecord = await client
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", sourceRecordId);
  expect(archivedRecord.error).toBeNull();
  const restoredRecord = await client
    .from("entity_records")
    .update({ archived_at: null })
    .eq("id", sourceRecordId);
  expect(restoredRecord.error).toBeNull();
  const rawRecordChange = await client
    .from("entity_records")
    .update({ values: { name: "Raw record change" } })
    .eq("id", sourceRecordId);
  expect(rawRecordChange.error).not.toBeNull();

  const rawRelationInsert = await client.from("entity_record_relation_values").insert({
    workspace_id: fixture.workspaceAId,
    source_entity_type_id: fixture.entityAId,
    source_record_id: sourceRecordId,
    field_definition_id: relationFieldId,
    target_entity_type_id: relatedEntityTypeId,
    target_record_id: targetRecordId,
  });
  expect(rawRelationInsert.error).not.toBeNull();

  const ownView = await client.from("entity_views").insert({
    workspace_id: fixture.workspaceAId,
    entity_type_id: relatedEntityTypeId,
    name: "Authenticated view",
    position: 1,
  }).select("id").single();
  expect(ownView.error).toBeNull();
  const ownViewId = String(ownView.data?.id);
  const updatedView = await client
    .from("entity_views")
    .update({ name: "Authenticated view updated" })
    .eq("id", ownViewId);
  expect(updatedView.error).toBeNull();

  const ownWorkflow = await client.from("workflows").insert({
    workspace_id: fixture.workspaceAId,
    name: "Authenticated workflow",
    enabled: false,
    trigger_type: "record_created",
    trigger_entity_type_id: relatedEntityTypeId,
    action_config: { triggerConfig: {}, conditions: [] },
    actions: [{ actionType: "create_record", actionTargetEntityTypeId: relatedEntityTypeId, fieldMappings: [] }],
  }).select("id").single();
  expect(ownWorkflow.error).toBeNull();
  const ownWorkflowId = String(ownWorkflow.data?.id);
  const updatedWorkflow = await client
    .from("workflows")
    .update({ name: "Authenticated workflow updated" })
    .eq("id", ownWorkflowId);
  expect(updatedWorkflow.error).toBeNull();
  const blockedEntityDelete = await client.rpc("delete_entity_type_if_safe_authorized", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: relatedEntityTypeId,
  });
  expect((blockedEntityDelete.data as Array<{ deleted: boolean }>)[0]?.deleted).toBe(false);
  const workflowStillExists = await client.from("workflows").select("id").eq("id", ownWorkflowId);
  expect(workflowStillExists.data).toHaveLength(1);

  const workflowFieldReference = await client
    .from("workflows")
    .update({
      actions: [{
        actionType: "update_record",
        fieldMappings: [{ targetFieldDefinitionId: relationFieldId }],
      }],
    })
    .eq("id", ownWorkflowId);
  expect(workflowFieldReference.error).toBeNull();
  const blockedFieldDelete = await client.rpc("delete_field_definition_if_safe_authorized", {
    p_workspace_id: fixture.workspaceAId,
    p_entity_type_id: fixture.entityAId,
    p_field_definition_id: relationFieldId,
  });
  expect((blockedFieldDelete.data as Array<{ deleted: boolean }>)[0]?.deleted).toBe(false);

  const ownLog = await client.from("workflow_execution_logs").insert({
    workspace_id: fixture.workspaceAId,
    workflow_id: ownWorkflowId,
    trigger_entity_type_id: fixture.entityAId,
    trigger_record_id: sourceRecordId,
    status: "succeeded",
    action_results: [],
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  }).select("id").single();
  expect(ownLog.error).toBeNull();
  const ownLogId = String(ownLog.data?.id);
  const rawLogUpdate = await client
    .from("workflow_execution_logs")
    .update({ status: "failed" })
    .eq("id", ownLogId);
  expect(rawLogUpdate.error).not.toBeNull();
  const rawLogDelete = await client
    .from("workflow_execution_logs")
    .delete()
    .eq("id", ownLogId);
  expect(rawLogDelete.error).not.toBeNull();

  const rawMembershipInsert = await client.from("workspace_memberships").insert({
    workspace_id: fixture.workspaceAId,
    user_id: fixture.userB.id,
  });
  expect(rawMembershipInsert.error).not.toBeNull();
  const rawMembershipDelete = await client
    .from("workspace_memberships")
    .delete()
    .eq("workspace_id", fixture.workspaceAId)
    .eq("user_id", fixture.userA.id);
  expect(rawMembershipDelete.error).not.toBeNull();

  async function expectImmutableWorkspaceId(table: string, id: string) {
    const result = await admin
      .from(table)
      .update({ workspace_id: fixture.workspaceBId })
      .eq("id", id);
    expect(result.error?.message).toContain("workspace_id is immutable");
  }

  const relationRow = await admin
    .from("entity_record_relation_values")
    .select("id")
    .eq("source_record_id", sourceRecordId)
    .single();
  expect(relationRow.error).toBeNull();

  await expectImmutableWorkspaceId("entity_types", fixture.entityAId);
  await expectImmutableWorkspaceId("field_definitions", relationFieldId);
  await expectImmutableWorkspaceId("entity_records", sourceRecordId);
  await expectImmutableWorkspaceId("entity_record_relation_values", String(relationRow.data?.id));
  await expectImmutableWorkspaceId("entity_views", ownViewId);
  await expectImmutableWorkspaceId("workflows", ownWorkflowId);
  await expectImmutableWorkspaceId("workflow_execution_logs", ownLogId);

  const deletedView = await client.from("entity_views").delete().eq("id", ownViewId);
  expect(deletedView.error).toBeNull();
  const deletedWorkflow = await client.from("workflows").delete().eq("id", ownWorkflowId);
  expect(deletedWorkflow.error).toBeNull();
});
