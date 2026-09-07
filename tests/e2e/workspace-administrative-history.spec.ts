import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };

function email(label: string) {
  return `e2e-history-ui-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `HistoryUi-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({ email: email(label), password, email_confirm: true });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create user.");
  return { id: data.user.id, email: data.user.email, password };
}

async function signIn(page: Page, user: User) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

test("authorized history is discoverable and unauthorized access is denied", async ({ browser }) => {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const roleId = randomUUID();
  const workerRoleId = randomUUID();
  const entityTypeId = randomUUID();
  const fieldId = randomUUID();
  const authorized = await createUser("authorized");
  const worker = await createUser("worker");

  try {
    for (const row of [
      { id: workspaceId, name: `E2E Administrative History ${workspaceId.slice(0, 8)}` },
    ]) {
      const result = await admin.from("workspaces").insert(row);
      if (result.error) throw new Error(result.error.message);
    }
    const roles = await admin.from("workspace_roles").insert([
      { id: roleId, workspace_id: workspaceId, name: "History reader" },
      { id: workerRoleId, workspace_id: workspaceId, name: "Worker" },
    ]);
    if (roles.error) throw new Error(roles.error.message);
    const capability = await admin.from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability: "workspace.audit.read" });
    if (capability.error) throw new Error(capability.error.message);
    const memberships = await admin.from("workspace_memberships").insert([
      { workspace_id: workspaceId, user_id: authorized.id, role_id: roleId },
      { workspace_id: workspaceId, user_id: worker.id, role_id: workerRoleId },
    ]);
    if (memberships.error) throw new Error(memberships.error.message);
    const entity = await admin.from("entity_types").insert({
      id: entityTypeId, workspace_id: workspaceId, name: "History objects", slug: `history-objects-${entityTypeId.slice(0, 8)}`,
    });
    if (entity.error) throw new Error(entity.error.message);
    const history = await admin.from("governance_audit_events").insert([
      {
      id: randomUUID(), workspace_id: workspaceId, event_type: "field_created", subject_kind: "field",
      subject_id: fieldId, subject_name_snapshot: "Region", parent_entity_type_id: entityTypeId,
      parent_entity_type_name_snapshot: "History objects", changes: { type: "text" }, authority_kind: "system",
      },
    ]);
    if (history.error) throw new Error(history.error.message);

    const authorizedContext = await browser.newContext();
    const workerContext = await browser.newContext();
    const authorizedPage = await authorizedContext.newPage();
    const workerPage = await workerContext.newPage();
    await signIn(authorizedPage, authorized);
    await authorizedPage.getByRole("button", { name: "Configure" }).click();
    await authorizedPage.getByRole("link", { name: "History", exact: true }).click();
    await authorizedPage.waitForURL("**/settings/history");
    await expect(authorizedPage.getByRole("heading", { name: "Administrative history" })).toBeVisible();
    await expect(authorizedPage.getByText("Added field “Region”")).toBeVisible();
    await authorizedPage.getByText("Details").click();
    await expect(authorizedPage.locator("details").first()).toHaveAttribute("open", "");
    await authorizedPage.getByLabel("Category").selectOption("Schema");
    await authorizedPage.getByRole("button", { name: "Apply filters" }).click();
    await authorizedPage.waitForURL("**/settings/history?category=Schema&days=all");

    await signIn(workerPage, worker);
    await expect(workerPage.getByRole("button", { name: "Configure" })).toHaveCount(0);
    await workerPage.goto("/settings/history");
    await expect(workerPage.getByRole("heading", { name: "Administrative history is managed by workspace administrators." })).toBeVisible();
    await authorizedContext.close();
    await workerContext.close();
  } finally {
    await admin.from("workspaces").delete().eq("id", workspaceId);
    await admin.auth.admin.deleteUser(authorized.id);
    await admin.auth.admin.deleteUser(worker.id);
  }
});

test("loads the next Administrative History page without duplicates", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const roleId = randomUUID();
  const entityTypeId = randomUUID();
  const user = await createUser("pagination");

  try {
    const workspace = await admin.from("workspaces").insert({ id: workspaceId, name: `E2E History Pagination ${workspaceId.slice(0, 8)}` });
    if (workspace.error) throw new Error(workspace.error.message);
    const role = await admin.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: "History reader" });
    if (role.error) throw new Error(role.error.message);
    const capability = await admin.from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability: "workspace.audit.read" });
    if (capability.error) throw new Error(capability.error.message);
    const membership = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: user.id, role_id: roleId });
    if (membership.error) throw new Error(membership.error.message);
    const entity = await admin.from("entity_types").insert({ id: entityTypeId, workspace_id: workspaceId, name: "History objects", slug: `history-objects-${entityTypeId.slice(0, 8)}` });
    if (entity.error) throw new Error(entity.error.message);
    const events = Array.from({ length: 53 }, (_, index) => ({
      id: randomUUID(), workspace_id: workspaceId, event_type: "field_created", subject_kind: "field",
      subject_id: randomUUID(), subject_name_snapshot: `Pagination field ${index + 1}`, parent_entity_type_id: entityTypeId,
      parent_entity_type_name_snapshot: "History objects", changes: { type: "text" }, authority_kind: "system",
      created_at: new Date(Date.now() - index).toISOString(),
    }));
    const history = await admin.from("governance_audit_events").insert(events);
    if (history.error) throw new Error(history.error.message);

    await signIn(page, user);
    await page.goto(`/settings/history`);
    await expect(page.getByRole("heading", { name: "Administrative history" })).toBeVisible();
    const historyEvents = page.getByRole("list", { name: "Administrative history events" }).locator("li");
    await expect(historyEvents).toHaveCount(50);
    await expect(page.getByText("Added field “Pagination field 1”", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(historyEvents).toHaveCount(53);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
    await expect(page.getByText("Added field “Pagination field 53”", { exact: true })).toBeVisible();
    await expect(page.getByText("Administrative change")).toHaveCount(0);
    const titles = await historyEvents.locator("p.font-medium").allTextContents();
    expect(new Set(titles).size).toBe(53);
  } finally {
    await admin.from("workspaces").delete().eq("id", workspaceId);
    await admin.auth.admin.deleteUser(user.id);
  }
});
