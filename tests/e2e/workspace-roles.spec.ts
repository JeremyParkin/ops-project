import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });

const capabilities = [
  "workspace.manage_members", "workspace.manage_roles", "workspace.manage_organization", "workspace.manage_settings",
  "schema.manage", "automation.manage", "records.operate", "processes.operate", "operations.view",
] as const;

type User = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  entityId: string;
  fieldId: string;
  roles: Record<string, string>;
  users: Record<string, User>;
};

let fixture: Fixture;

function email(label: string) {
  return `e2e-roles-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Roles-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: email(label), password, email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create user.");
  return { id: data.user.id, email: data.user.email, password };
}

async function createRole(workspaceId: string, name: string, roleCapabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({
    id, workspace_id: workspaceId, name,
  });
  if (roleError) throw new Error(roleError.message);
  if (roleCapabilities.length) {
    const { error: capabilityError } = await admin.from("workspace_role_capabilities").insert(
      roleCapabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })),
    );
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function authenticatedClient(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

async function signIn(page: Page, user: User) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const users = Object.fromEntries(await Promise.all(
    ["admin", "member", "operator", "schema", "automation", "process", "role-manager", "member-manager", "admin-a", "admin-b"].map(async (label) => [label, await createUser(label)]),
  )) as Record<string, User>;

  const { error: workspaceError } = await admin.from("workspaces").insert([
    { id: workspaceId, name: `E2E Roles ${workspaceId.slice(0, 8)}` },
    { id: otherWorkspaceId, name: `E2E Roles Other ${otherWorkspaceId.slice(0, 8)}` },
  ]);
  if (workspaceError) throw new Error(workspaceError.message);

  const roles = {
    admin: await createRole(workspaceId, "Administrator", [...capabilities]),
    member: await createRole(workspaceId, "Member", []),
    operator: await createRole(workspaceId, "Record operator", ["records.operate"]),
    schema: await createRole(workspaceId, "Schema manager", ["schema.manage"]),
    automation: await createRole(workspaceId, "Automation manager", ["automation.manage"]),
    process: await createRole(workspaceId, "Process operator", ["processes.operate"]),
    roleManager: await createRole(workspaceId, "Role manager", ["workspace.manage_roles"]),
    memberManager: await createRole(workspaceId, "Member manager", ["workspace.manage_members"]),
    adminA: await createRole(workspaceId, "Administrative A", ["workspace.manage_members", "workspace.manage_roles"]),
    adminB: await createRole(workspaceId, "Administrative B", ["workspace.manage_members", "workspace.manage_roles"]),
    other: await createRole(otherWorkspaceId, "Other administrator", [...capabilities]),
  };

  const memberships = [
    ["admin", roles.admin], ["member", roles.member], ["operator", roles.operator],
    ["schema", roles.schema], ["automation", roles.automation], ["process", roles.process],
    ["role-manager", roles.roleManager], ["member-manager", roles.memberManager],
    ["admin-a", roles.adminA], ["admin-b", roles.adminB],
  ].map(([label, roleId]) => ({ workspace_id: workspaceId, user_id: users[label].id, role_id: roleId }));
  memberships.push({ workspace_id: otherWorkspaceId, user_id: users.admin.id, role_id: roles.other });
  const { error: membershipError } = await admin.from("workspace_memberships").insert(memberships);
  if (membershipError) throw new Error(membershipError.message);

  const entityId = randomUUID();
  const fieldId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityId, workspace_id: workspaceId, name: "E2E Role records", slug: `e2e-role-records-${workspaceId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);
  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: fieldId, workspace_id: workspaceId, entity_type_id: entityId, key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);
  return { workspaceId, otherWorkspaceId, entityId, fieldId, roles, users };
}

async function cleanupFixture(current: Fixture) {
  const admin = createSupabaseTestClient();
  const { error: workspaceError } = await admin.from("workspaces").delete().in("id", [current.workspaceId, current.otherWorkspaceId]);
  if (workspaceError) throw new Error(workspaceError.message);
  for (const user of Object.values(current.users)) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(error.message);
  }
}

test.beforeAll(async () => { fixture = await createFixture(); });
test.afterAll(async () => { if (fixture) await cleanupFixture(fixture); });

test("enforces capability-gated reads, mutations, and direct role-management RPCs", async () => {
  const adminClient = await authenticatedClient(fixture.users.admin);
  const memberClient = await authenticatedClient(fixture.users.member);
  const operatorClient = await authenticatedClient(fixture.users.operator);
  const schemaClient = await authenticatedClient(fixture.users.schema);
  const automationClient = await authenticatedClient(fixture.users.automation);
  const processClient = await authenticatedClient(fixture.users.process);
  const roleManagerClient = await authenticatedClient(fixture.users["role-manager"]);
  const memberManagerClient = await authenticatedClient(fixture.users["member-manager"]);

  const memberRead = await memberClient.from("entity_types").select("id").eq("id", fixture.entityId);
  expect(memberRead.error).toBeNull();
  expect(memberRead.data).toHaveLength(1);
  const rawMemberships = await memberClient.from("workspace_memberships").select("user_id").eq("workspace_id", fixture.workspaceId);
  expect(rawMemberships.error).toBeNull();
  expect(rawMemberships.data).toEqual([{ user_id: fixture.users.member.id }]);

  const memberRecordWrite = await memberClient.rpc("create_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityId, p_values: { name: "Denied" }, p_relations: [],
  });
  expect(memberRecordWrite.error?.message).toContain("records.operate");
  const operatorRecordWrite = await operatorClient.rpc("create_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityId, p_values: { name: "Allowed" }, p_relations: [],
  });
  expect(operatorRecordWrite.error).toBeNull();
  const operatorRecordUpdate = await operatorClient.rpc("update_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityId, p_record_id: operatorRecordWrite.data,
    p_values: { name: "Updated" }, p_relation_field_ids: [], p_relations: [],
  });
  expect(operatorRecordUpdate.error).toBeNull();
  const memberViewWrite = await memberClient.from("entity_views").insert({
    workspace_id: fixture.workspaceId, entity_type_id: fixture.entityId, name: "Denied view", position: 1,
  });
  expect(memberViewWrite.error).not.toBeNull();
  const operatorViewWrite = await operatorClient.from("entity_views").insert({
    workspace_id: fixture.workspaceId, entity_type_id: fixture.entityId, name: "Allowed view", position: 1,
  });
  expect(operatorViewWrite.error).toBeNull();

  const memberSchemaWrite = await memberClient.rpc("create_entity_type_with_fields", {
    p_workspace_id: fixture.workspaceId, p_entity_name: "Denied schema", p_entity_slug: `denied-${randomUUID().slice(0, 8)}`, p_entity_description: null, p_fields: [],
  });
  expect(memberSchemaWrite.error).not.toBeNull();
  const schemaWrite = await schemaClient.rpc("create_entity_type_with_fields", {
    p_workspace_id: fixture.workspaceId, p_entity_name: "Allowed schema", p_entity_slug: `allowed-${randomUUID().slice(0, 8)}`, p_entity_description: null,
    p_fields: [{ key: `allowed_name_${randomUUID().slice(0, 8)}`, name: "Name", slug: "name", type: "text", required: false, position: 1 }],
  });
  expect(schemaWrite.error).toBeNull();

  const memberWorkflowWrite = await memberClient.from("workflows").insert({
    workspace_id: fixture.workspaceId, name: "Denied workflow", enabled: false, trigger_type: "record_created", trigger_entity_type_id: fixture.entityId, action_config: { triggerConfig: {}, conditions: [] }, actions: [{ actionType: "update_record", fieldMappings: [] }],
  });
  expect(memberWorkflowWrite.error).not.toBeNull();
  const automationWorkflowWrite = await automationClient.from("workflows").insert({
    workspace_id: fixture.workspaceId, name: "Allowed workflow", enabled: false, trigger_type: "record_created", trigger_entity_type_id: fixture.entityId, action_config: { triggerConfig: {}, conditions: [] }, actions: [{ actionType: "update_record", fieldMappings: [] }],
  });
  expect(automationWorkflowWrite.error).toBeNull();

  const memberProcessStart = await memberClient.rpc("start_process_run_authorized", {
    p_workspace_id: fixture.workspaceId, p_process_template_id: randomUUID(), p_origin_entity_type_id: fixture.entityId, p_origin_record_id: randomUUID(),
  });
  expect(memberProcessStart.error?.message).toContain("processes.operate");
  const allowedProcessGateway = await processClient.rpc("start_process_run_authorized", {
    p_workspace_id: fixture.workspaceId, p_process_template_id: randomUUID(), p_origin_entity_type_id: fixture.entityId, p_origin_record_id: randomUUID(),
  });
  expect(allowedProcessGateway.error?.message).not.toContain("processes.operate");

  const memberList = await roleManagerClient.rpc("list_workspace_members_with_roles_authorized", { p_workspace_id: fixture.workspaceId });
  expect(memberList.error?.message).toContain("workspace.manage_members");
  const roleList = await roleManagerClient.rpc("list_workspace_roles_authorized", { p_workspace_id: fixture.workspaceId });
  expect(roleList.error).toBeNull();
  const managerMemberList = await memberManagerClient.rpc("list_workspace_members_with_roles_authorized", { p_workspace_id: fixture.workspaceId });
  expect(managerMemberList.error).toBeNull();
  const managerRoleList = await memberManagerClient.rpc("list_workspace_roles_authorized", { p_workspace_id: fixture.workspaceId });
  expect(managerRoleList.error).toBeNull();

  const invalidCapability = await adminClient.rpc("create_workspace_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_name: "Invalid", p_description: null, p_capabilities: ["not.a.capability"],
  });
  expect(invalidCapability.error?.message).toContain("Invalid capability");
  const crossWorkspaceAssignment = await adminClient.rpc("set_workspace_member_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_user_id: fixture.users.member.id, p_role_id: fixture.roles.other,
  });
  expect(crossWorkspaceAssignment.error?.message).toContain("Role not found");
  const selfEscalation = await memberManagerClient.rpc("set_workspace_member_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_user_id: fixture.users["member-manager"].id, p_role_id: fixture.roles.admin,
  });
  expect(selfEscalation.error?.message).toContain("cannot grant yourself additional capabilities");
  const selfEdit = await roleManagerClient.rpc("update_workspace_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_role_id: fixture.roles.roleManager, p_name: "Role manager", p_description: null, p_capabilities: [],
  });
  expect(selfEdit.error?.message).toContain("cannot edit the capabilities of your own role");
  const selfDelete = await roleManagerClient.rpc("delete_workspace_role_with_reassignment_authorized", {
    p_workspace_id: fixture.workspaceId, p_role_id: fixture.roles.roleManager, p_replacement_role_id: fixture.roles.member,
  });
  expect(selfDelete.error?.message).toContain("cannot delete your own assigned role");

  const temporaryRole = await adminClient.rpc("create_workspace_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_name: "Temporary role", p_description: null, p_capabilities: ["workspace.manage_organization"],
  });
  expect(temporaryRole.error).toBeNull();
  const { data: temporaryRoleRows, error: temporaryRoleError } = await createSupabaseTestClient()
    .from("workspace_roles").select("id").eq("workspace_id", fixture.workspaceId).eq("name", "Temporary role").single();
  expect(temporaryRoleError).toBeNull();
  const { data: temporaryCapabilities, error: temporaryCapabilitiesError } = await createSupabaseTestClient()
    .from("workspace_role_capabilities")
    .select("capability")
    .eq("workspace_id", fixture.workspaceId)
    .eq("role_id", temporaryRoleRows!.id);
  expect(temporaryCapabilitiesError).toBeNull();
  expect(temporaryCapabilities).toEqual([{ capability: "workspace.manage_organization" }]);
  const assignment = await adminClient.rpc("set_workspace_member_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_user_id: fixture.users.member.id, p_role_id: temporaryRoleRows!.id,
  });
  expect(assignment.error).toBeNull();
  const deletion = await adminClient.rpc("delete_workspace_role_with_reassignment_authorized", {
    p_workspace_id: fixture.workspaceId, p_role_id: temporaryRoleRows!.id, p_replacement_role_id: fixture.roles.member,
  });
  expect(deletion.error).toBeNull();
  const reassignedMembership = await createSupabaseTestClient().from("workspace_memberships").select("role_id").eq("workspace_id", fixture.workspaceId).eq("user_id", fixture.users.member.id).single();
  expect(reassignedMembership.data?.role_id).toBe(fixture.roles.member);
});

test("serializes concurrent role changes and exposes management only through the authorized UI", async ({ page }) => {
  const roleManagerClient = await authenticatedClient(fixture.users["role-manager"]);
  const removeOriginalAdministrator = await roleManagerClient.rpc("update_workspace_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_role_id: fixture.roles.admin, p_name: "Administrator", p_description: null, p_capabilities: ["records.operate"],
  });
  expect(removeOriginalAdministrator.error).toBeNull();
  const removeFromA = roleManagerClient.rpc("update_workspace_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_role_id: fixture.roles.adminA, p_name: "Administrative A", p_description: null, p_capabilities: ["workspace.manage_roles"],
  });
  const removeFromB = roleManagerClient.rpc("update_workspace_role_authorized", {
    p_workspace_id: fixture.workspaceId, p_role_id: fixture.roles.adminB, p_name: "Administrative B", p_description: null, p_capabilities: ["workspace.manage_roles"],
  });
  const results = await Promise.all([removeFromA, removeFromB]);
  expect(results.filter((result) => result.error === null)).toHaveLength(1);
  expect(results.filter((result) => result.error !== null)).toHaveLength(1);

  const survivingAdministrator = results[0].error === null
    ? fixture.users["admin-b"]
    : fixture.users["admin-a"];
  await signIn(page, survivingAdministrator);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Roles", exact: true })).toBeVisible();
  await expect(page.getByLabel(`Role for ${fixture.users.member.email}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create custom role" })).toBeVisible();
  const createRoleForm = page.getByRole("heading", { name: "Create custom role" }).locator("..");
  await createRoleForm.getByLabel("Name").fill("UI-created role");
  await createRoleForm.getByLabel("Create and update records").check();
  await createRoleForm.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByRole("status")).toContainText("Role created.");
  await expect(page.locator('input[value="UI-created role"]')).toBeVisible();
});
