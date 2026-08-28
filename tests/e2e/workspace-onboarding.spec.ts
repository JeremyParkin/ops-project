import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { requireE2eEnv } from "./helpers/env";
import {
  createE2eWorkspaceAdministratorRole,
  createSupabaseTestClient,
} from "./helpers/supabase-test-data";

const runnerEmail = "e2e-runner@ops-project.test";
const workspaceIds: string[] = [];
const userIds: string[] = [];

async function getRunnerUserId() {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(error.message);

  const user = data.users.find((candidate) => candidate.email === runnerEmail);
  if (!user) throw new Error("Unable to find the authenticated E2E runner.");
  return user.id;
}

async function createWorkspaceForUser(userId: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  workspaceIds.push(workspaceId);
  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: `E2E Onboarding ${workspaceId.slice(0, 8)}`,
  });
  if (workspaceError) throw new Error(workspaceError.message);
  const roleId = await createE2eWorkspaceAdministratorRole(admin, workspaceId);

  const { error: membershipError } = await admin
    .from("workspace_memberships")
    .insert({ workspace_id: workspaceId, user_id: userId, role_id: roleId });
  if (membershipError) throw new Error(membershipError.message);

  return workspaceId;
}

async function activateWorkspace(
  page: Page,
  workspaceId: string,
  expectedHeading = "Set up your workspace",
) {
  const workspaceName = `E2E Onboarding ${workspaceId.slice(0, 8)}`;
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: workspaceName, exact: true }).click();
  await expect(page.getByRole("heading", { name: expectedHeading })).toBeVisible();
}

async function createAuthenticatedClient(email: string, password: string) {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return client;
}

test.afterAll(async () => {
  const admin = createSupabaseTestClient();
  if (workspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", workspaceIds);
    if (error) throw new Error(error.message);
  }

  for (const userId of userIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
  }
});

test("empty workspace onboarding creates Clients, Projects, and Tasks atomically", async ({
  page,
}) => {
  const workspaceId = await createWorkspaceForUser(await getRunnerUserId());
  await activateWorkspace(page, workspaceId);

  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
  await page.getByText("Clients", { exact: true }).click();
  await page.getByText("Projects", { exact: true }).click();
  await page.getByText("Tasks", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Project.Client to Client")).toBeVisible();
  await expect(page.getByText("Task.Project to Project")).toBeVisible();
  await page.getByRole("button", { name: "Create workspace structure" }).click();
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Client", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Task", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add Project" })).toBeVisible();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(page.getByRole("link", { name: "Automations", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Project", exact: true }).click();
  await page.getByRole("link", { name: "Manage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Entity Settings" })).toBeVisible();

  const admin = createSupabaseTestClient();
  const { data: entities, error: entityError } = await admin
    .from("entity_types")
    .select("id, name, display_field_definition_id")
    .eq("workspace_id", workspaceId);
  expect(entityError).toBeNull();
  expect(entities).toHaveLength(3);
  expect(entities?.every((entity) => entity.display_field_definition_id)).toBe(true);

  const project = entities?.find((entity) => entity.name === "Project");
  const client = entities?.find((entity) => entity.name === "Client");
  const { data: projectFields, error: fieldError } = await admin
    .from("field_definitions")
    .select("name, type, related_entity_type_id")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", project!.id);
  expect(fieldError).toBeNull();
  expect(projectFields).toContainEqual({
    name: "Client",
    type: "relation",
    related_entity_type_id: client!.id,
  });

  const task = entities?.find((entity) => entity.name === "Task");
  const { data: taskFields, error: taskFieldError } = await admin
    .from("field_definitions")
    .select("name, type, related_entity_type_id")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", task!.id);
  expect(taskFieldError).toBeNull();
  expect(taskFields).toEqual(
    expect.arrayContaining([
      { name: "Title", type: "text", related_entity_type_id: null },
      { name: "Status", type: "text", related_entity_type_id: null },
      { name: "Due date", type: "date", related_entity_type_id: null },
      { name: "Project", type: "relation", related_entity_type_id: project!.id },
    ]),
  );
});

test("archived-only workspaces remain established and do not re-enter onboarding", async ({
  page,
}) => {
  const workspaceId = await createWorkspaceForUser(await getRunnerUserId());
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("entity_types").insert({
    id: randomUUID(),
    workspace_id: workspaceId,
    name: "E2E Archived Setup",
    slug: "e2e-archived-setup",
    archived_at: new Date().toISOString(),
  });
  expect(error).toBeNull();

  await activateWorkspace(page, workspaceId, "No active business objects yet.");
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No active business objects yet." })).toBeVisible();
});

test("standalone structures omit unavailable relations and custom setup uses the existing form", async ({
  page,
}) => {
  const workspaceId = await createWorkspaceForUser(await getRunnerUserId());
  await activateWorkspace(page, workspaceId);
  await page.getByRole("link", { name: "Start from scratch" }).click();
  await expect(page.getByRole("heading", { name: "Create object" })).toBeVisible();

  await page.goto("/");
  await page.getByText("Tasks", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("No inferred relations are needed for this selection.")).toBeVisible();
  await page.getByRole("button", { name: "Create workspace structure" }).click();
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toHaveCount(0);

  const admin = createSupabaseTestClient();
  const { data: fields, error } = await admin
    .from("field_definitions")
    .select("type")
    .eq("workspace_id", workspaceId);
  expect(error).toBeNull();
  expect(fields?.some((field) => field.type === "relation")).toBe(false);
});

test("Clients and Opportunities create the approved sales relation", async ({ page }) => {
  const workspaceId = await createWorkspaceForUser(await getRunnerUserId());
  await activateWorkspace(page, workspaceId);
  await page.getByText("Clients", { exact: true }).click();
  await page.getByText("Sales / Opportunities", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Opportunity.Client to Client")).toBeVisible();
  await page.getByRole("button", { name: "Create workspace structure" }).click();
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Opportunity", exact: true })).toBeVisible();

  const admin = createSupabaseTestClient();
  const { data: entities, error: entityError } = await admin
    .from("entity_types")
    .select("id, name, display_field_definition_id")
    .eq("workspace_id", workspaceId);
  expect(entityError).toBeNull();
  expect(entities).toHaveLength(2);
  expect(entities?.every((entity) => entity.display_field_definition_id)).toBe(true);

  const client = entities?.find((entity) => entity.name === "Client");
  const opportunity = entities?.find((entity) => entity.name === "Opportunity");
  const { data: fields, error: fieldError } = await admin
    .from("field_definitions")
    .select("name, type, related_entity_type_id")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", opportunity!.id);
  expect(fieldError).toBeNull();
  expect(fields).toEqual(
    expect.arrayContaining([
      { name: "Name", type: "text", related_entity_type_id: null },
      { name: "Stage", type: "text", related_entity_type_id: null },
      { name: "Amount", type: "number", related_entity_type_id: null },
      { name: "Expected close date", type: "date", related_entity_type_id: null },
      { name: "Client", type: "relation", related_entity_type_id: client!.id },
    ]),
  );
});

test("the authorized setup RPC is membership checked and rolls back invalid payloads", async () => {
  const admin = createSupabaseTestClient();
  const password = `E2E-onboarding-${randomUUID()}!`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: `e2e-onboarding-${randomUUID()}@example.test`,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) throw new Error(userError?.message ?? "Unable to create user.");
  userIds.push(userData.user.id);

  const allowedWorkspaceId = await createWorkspaceForUser(userData.user.id);
  const forbiddenWorkspaceId = randomUUID();
  workspaceIds.push(forbiddenWorkspaceId);
  const { error: forbiddenWorkspaceError } = await admin.from("workspaces").insert({
    id: forbiddenWorkspaceId,
    name: `E2E Onboarding Forbidden ${forbiddenWorkspaceId.slice(0, 8)}`,
  });
  if (forbiddenWorkspaceError) throw new Error(forbiddenWorkspaceError.message);

  const client = await createAuthenticatedClient(userData.user.email!, password);
  const malformedPayload = [
    {
      local_id: "clients",
      name: "Client",
      slug: "client",
      fields: [{ key: "client_name", name: "Name", slug: "name", type: "text", position: 1 }],
    },
    {
      local_id: "projects",
      name: "Project",
      slug: "project",
      fields: [{ key: "project_client", name: "Client", slug: "client", type: "relation", position: 1, related_local_id: "missing" }],
    },
  ];
  const invalidResult = await client.rpc("create_entity_types_with_fields_authorized", {
    p_workspace_id: allowedWorkspaceId,
    p_entities: malformedPayload,
  });
  expect(invalidResult.error).not.toBeNull();

  const { data: rolledBackEntities, error: rolledBackError } = await admin
    .from("entity_types")
    .select("id")
    .eq("workspace_id", allowedWorkspaceId);
  expect(rolledBackError).toBeNull();
  expect(rolledBackEntities).toHaveLength(0);

  const forgedResult = await client.rpc("create_entity_types_with_fields_authorized", {
    p_workspace_id: forbiddenWorkspaceId,
    p_entities: malformedPayload.slice(0, 1),
  });
  expect(forgedResult.error).not.toBeNull();

  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const anonymousClient = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anonymousResult = await anonymousClient.rpc(
    "create_entity_types_with_fields_authorized",
    { p_workspace_id: allowedWorkspaceId, p_entities: malformedPayload.slice(0, 1) },
  );
  expect(anonymousResult.error).not.toBeNull();

  const nonMemberPassword = `E2E-onboarding-${randomUUID()}!`;
  const { data: nonMemberData, error: nonMemberError } = await admin.auth.admin.createUser({
    email: `e2e-onboarding-${randomUUID()}@example.test`,
    password: nonMemberPassword,
    email_confirm: true,
  });
  if (nonMemberError || !nonMemberData.user) {
    throw new Error(nonMemberError?.message ?? "Unable to create non-member user.");
  }
  userIds.push(nonMemberData.user.id);
  const nonMemberClient = await createAuthenticatedClient(
    nonMemberData.user.email!,
    nonMemberPassword,
  );
  const nonMemberResult = await nonMemberClient.rpc(
    "create_entity_types_with_fields_authorized",
    { p_workspace_id: allowedWorkspaceId, p_entities: malformedPayload.slice(0, 1) },
  );
  expect(nonMemberResult.error).not.toBeNull();

  const validPayload = malformedPayload.slice(0, 1);
  const [firstSetup, secondSetup] = await Promise.all([
    client.rpc("create_entity_types_with_fields_authorized", {
      p_workspace_id: allowedWorkspaceId,
      p_entities: validPayload,
    }),
    client.rpc("create_entity_types_with_fields_authorized", {
      p_workspace_id: allowedWorkspaceId,
      p_entities: validPayload,
    }),
  ]);
  expect([firstSetup, secondSetup].filter((result) => !result.error)).toHaveLength(1);

  const { data: initializedEntities, error: initializedError } = await admin
    .from("entity_types")
    .select("id")
    .eq("workspace_id", allowedWorkspaceId);
  expect(initializedError).toBeNull();
  expect(initializedEntities).toHaveLength(1);
});
