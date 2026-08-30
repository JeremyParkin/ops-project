import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };

function email(label: string) {
  return `e2e-health-ui-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `HealthUi-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({ email: email(label), password, email_confirm: true });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create user.");
  return { id: data.user.id, email: data.user.email, password };
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error } = await admin.from("workspaces").insert({ id: workspaceId, name: `${name} ${workspaceId.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  return workspaceId;
}

async function createEntityType(workspaceId: string, name: string, fields: Array<{ key: string; type: "text" | "number" }>) {
  const admin = createSupabaseTestClient();
  const entityTypeId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityTypeId, workspace_id: workspaceId, name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${entityTypeId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);
  let position = 1;
  for (const field of fields) {
    const { error: fieldError } = await admin.from("field_definitions").insert({
      id: randomUUID(), workspace_id: workspaceId, entity_type_id: entityTypeId,
      key: `${field.key}_${entityTypeId.slice(0, 8)}`, name: field.key, slug: field.key,
      type: field.type, required: false, position: position++,
    });
    if (fieldError) throw new Error(fieldError.message);
  }
  return entityTypeId;
}

async function signIn(page: Page, user: User) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("Workspace Health", () => {
  test("a builder sees grouped findings with a working fix link", async ({ page }) => {
    const workspaceId = await createWorkspace("E2E Health UI Findings");
    const roleId = await createRole(workspaceId, "Settings Manager", ["workspace.manage_settings"]);
    const builder = await createUser("builder");
    const admin = createSupabaseTestClient();
    const { error: membershipError } = await admin.from("workspace_memberships").insert({
      workspace_id: workspaceId, user_id: builder.id, role_id: roleId,
    });
    if (membershipError) throw new Error(membershipError.message);

    const noFieldsEntityId = await createEntityType(workspaceId, "Empty UI Object", []);
    await createEntityType(workspaceId, "Numeric UI Object", [{ key: "amount", type: "number" }]);

    try {
      await signIn(page, builder);
      await expect(page).toHaveURL(/\/$/);
      await page.getByRole("button", { name: "Configure" }).click();
      await page.getByRole("link", { name: "Workspace Health" }).click();
      await page.waitForURL("/settings/health");

      await expect(page.getByRole("heading", { name: "Business objects with no active fields" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Business objects with no usable display field" })).toBeVisible();
      const summary = page.locator("p", { hasText: "needing attention" });
      await expect(summary).toContainText("1 needing attention");
      await expect(summary).toContainText("1 worth reviewing");

      const noFieldsRow = page.getByText("Empty UI Object has no active fields").locator("../..");
      await noFieldsRow.getByRole("link", { name: "Fix" }).click();
      await page.waitForURL(`**/entities/${noFieldsEntityId}?manage=true`);
    } finally {
      await admin.from("workspaces").delete().eq("id", workspaceId);
      await admin.auth.admin.deleteUser(builder.id);
    }
  });

  test("a worker cannot reach Workspace Health via nav or direct URL, and neither can an impersonating admin", async ({ browser }) => {
    const workspaceId = await createWorkspace("E2E Health UI Auth");
    // Also needs workspace.manage_members: the "Log in as" control this test
    // clicks lives in the settings page's Members section, gated separately.
    const builderRoleId = await createRole(workspaceId, "Settings Manager", [
      "workspace.manage_settings", "workspace.impersonate_users", "workspace.manage_members",
    ]);
    const workerRoleId = await createRole(workspaceId, "Worker", []);
    const builder = await createUser("auth-builder");
    const worker = await createUser("auth-worker");
    const admin = createSupabaseTestClient();
    const { error: membershipError } = await admin.from("workspace_memberships").insert([
      { workspace_id: workspaceId, user_id: builder.id, role_id: builderRoleId },
      { workspace_id: workspaceId, user_id: worker.id, role_id: workerRoleId },
    ]);
    if (membershipError) throw new Error(membershipError.message);

    const workerContext = await browser.newContext();
    const builderContext = await browser.newContext();
    try {
      const workerPage = await workerContext.newPage();
      await signIn(workerPage, worker);
      await expect(workerPage).toHaveURL(/\/$/);
      await expect(workerPage.getByRole("button", { name: "Configure" })).toHaveCount(0);
      await workerPage.goto("/settings/health");
      await expect(workerPage.getByRole("heading", { name: "Workspace Health is managed by workspace administrators." })).toBeVisible();

      const builderPage = await builderContext.newPage();
      await signIn(builderPage, builder);
      await expect(builderPage).toHaveURL(/\/$/);
      await builderPage.goto("/settings");
      const memberRow = builderPage.getByLabel(`Role for ${worker.email}`).locator("../../..");
      await memberRow.getByRole("button", { name: "Log in as" }).click();
      await builderPage.waitForURL("/");
      await expect(builderPage.getByText("Exit impersonation")).toBeVisible();

      await builderPage.goto("/settings/health");
      await expect(builderPage.getByRole("heading", { name: "Not available while impersonating." })).toBeVisible();
    } finally {
      await workerContext.close();
      await builderContext.close();
      await admin.from("workspaces").delete().eq("id", workspaceId);
      await admin.auth.admin.deleteUser(builder.id);
      await admin.auth.admin.deleteUser(worker.id);
    }
  });

  test("a healthy workspace shows the empty state", async ({ page }) => {
    const workspaceId = await createWorkspace("E2E Health UI Healthy");
    const roleId = await createRole(workspaceId, "Settings Manager", ["workspace.manage_settings"]);
    const builder = await createUser("healthy-builder");
    const admin = createSupabaseTestClient();
    const { error: membershipError } = await admin.from("workspace_memberships").insert({
      workspace_id: workspaceId, user_id: builder.id, role_id: roleId,
    });
    if (membershipError) throw new Error(membershipError.message);
    await createEntityType(workspaceId, "Healthy UI Object", [{ key: "name", type: "text" }]);

    try {
      await signIn(page, builder);
      await expect(page).toHaveURL(/\/$/);
      await page.goto("/settings/health");
      await expect(page.getByText("Everything looks healthy.")).toBeVisible();
    } finally {
      await admin.from("workspaces").delete().eq("id", workspaceId);
      await admin.auth.admin.deleteUser(builder.id);
    }
  });
});
