import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { createSupabaseTestClient, deleteE2eUsers } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };

type Fixture = {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  archivedRecordId: string;
  worker: User;
  secondWorker: User;
  administrator: User;
  readOnly: User;
};

let fixture: Fixture;
const createdUserIds: string[] = [];

function uniqueEmail(label: string) {
  return `e2e-discussion-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Discussion-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: uniqueEmail(label),
    password,
    email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create E2E user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email: data.user.email, password };
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({
    id: roleId,
    workspace_id: workspaceId,
    name,
  });
  if (roleError) throw new Error(roleError.message);

  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }

  return roleId;
}

async function signIn(page: Page, user: User) {
  await page.context().clearCookies();
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

function discussion(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Discussion", exact: true }),
  });
}

function activity(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Activity", exact: true }),
  });
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const entityTypeId = randomUUID();
  const recordId = randomUUID();
  const archivedRecordId = randomUUID();
  const fieldId = randomUUID();
  const worker = await createUser("worker");
  const secondWorker = await createUser("second-worker");
  const administrator = await createUser("administrator");
  const readOnly = await createUser("read-only");

  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: `E2E Discussion ${workspaceId.slice(0, 8)}`,
  });
  if (workspaceError) throw new Error(workspaceError.message);

  const workerRoleId = await createRole(workspaceId, "Worker", ["records.operate"]);
  const adminRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members",
    "workspace.manage_roles",
    "workspace.manage_settings",
    "schema.manage",
    "records.operate",
    "workspace.impersonate_users",
  ]);
  const readOnlyRoleId = await createRole(workspaceId, "Read only", []);

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: worker.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: secondWorker.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: administrator.id, role_id: adminRoleId },
    { workspace_id: workspaceId, user_id: readOnly.id, role_id: readOnlyRoleId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityTypeId,
    workspace_id: workspaceId,
    name: "E2E Discussion Client",
    slug: `e2e-discussion-client-${workspaceId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);

  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: fieldId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    key: "name",
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);

  const { error: displayError } = await admin.rpc("set_entity_display_field", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_field_definition_id: fieldId,
  });
  if (displayError) throw new Error(displayError.message);

  const { error: recordError } = await admin.from("entity_records").insert([
    {
      id: recordId,
      workspace_id: workspaceId,
      entity_type_id: entityTypeId,
      values: { name: "Discussion Acme" },
    },
    {
      id: archivedRecordId,
      workspace_id: workspaceId,
      entity_type_id: entityTypeId,
      values: { name: "Archived Discussion Acme" },
      archived_at: new Date().toISOString(),
    },
  ]);
  if (recordError) throw new Error(recordError.message);

  return {
    workspaceId,
    entityTypeId,
    recordId,
    archivedRecordId,
    worker,
    secondWorker,
    administrator,
    readOnly,
  };
}

test.beforeAll(async () => {
  fixture = await createFixture();
});

test.afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];
  if (fixture?.workspaceId) {
    const { error: commentError } = await admin.from("record_comments").delete().eq("workspace_id", fixture.workspaceId);
    if (commentError) failures.push(commentError.message);
    const { error: workspaceError } = await admin.from("workspaces").delete().eq("id", fixture.workspaceId);
    if (workspaceError) failures.push(workspaceError.message);
  }
  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (failures.length > 0) {
    throw new Error(`record-discussion cleanup failed:\n${failures.join("\n")}`);
  }
});

test("Discussion supports create, ordering, validation, tombstone, and remains distinct from Activity", async ({ page }) => {
  await signIn(page, fixture.worker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);

  await expect(discussion(page).getByText("No comments yet.")).toBeVisible();
  await expect(activity(page)).toBeVisible();

  await discussion(page).getByLabel("Add a comment").fill("   ");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByRole("alert")).toContainText("Comment body is required.");

  await discussion(page).getByLabel("Add a comment").evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.value = "x".repeat(4001);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByRole("alert")).toContainText("4000 characters or fewer");

  await discussion(page).getByLabel("Add a comment").fill("Second visible comment");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByText("Second visible comment")).toBeVisible();

  await discussion(page).getByLabel("Add a comment").fill("First visible comment");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByText("First visible comment")).toBeVisible();

  const bodies = discussion(page).locator("li").filter({ hasText: "visible comment" });
  await expect(bodies.nth(0)).toContainText("Second visible comment");
  await expect(bodies.nth(1)).toContainText("First visible comment");
  await expect(bodies.first().getByText(fixture.worker.email)).toBeVisible();
  await expect(discussion(page).locator("time").first()).toBeVisible();

  const removedComment = discussion(page).locator("li").filter({ hasText: "Second visible comment" });
  await removedComment.getByRole("button", { name: "Remove" }).click();
  await expect(discussion(page).getByText("Comment removed")).toBeVisible();
  await expect(discussion(page).getByText("Second visible comment")).toHaveCount(0);
  await expect(activity(page).getByText("Comment removed")).toHaveCount(0);
});

test("archived records keep discussion readable but remove the composer", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("record_comments").insert({
    workspace_id: fixture.workspaceId,
    entity_type_id: fixture.entityTypeId,
    entity_record_id: fixture.archivedRecordId,
    body: "Comment before archive",
    author_user_id: fixture.worker.id,
    author_label: fixture.worker.email,
  });
  expect(error).toBeNull();

  await signIn(page, fixture.worker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.archivedRecordId}`);

  await expect(discussion(page).getByText("Comment before archive")).toBeVisible();
  await expect(discussion(page).getByLabel("Add a comment")).toHaveCount(0);
  await expect(discussion(page).getByText("Archived records are read-only. Existing discussion remains available.")).toBeVisible();

  await discussion(page).getByRole("button", { name: "Remove" }).click();
  await expect(discussion(page).getByText("Comment removed")).toBeVisible();
});

test("records.operate and administrator boundaries are enforced from record detail", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("record_comments").insert({
    workspace_id: fixture.workspaceId,
    entity_type_id: fixture.entityTypeId,
    entity_record_id: fixture.recordId,
    body: "Administrator tombstone target",
    author_user_id: fixture.worker.id,
    author_label: fixture.worker.email,
  });
  expect(error).toBeNull();

  await signIn(page, fixture.readOnly);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await discussion(page).getByLabel("Add a comment").fill("Read-only attempt");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByRole("alert")).toContainText("records.operate");

  await signIn(page, fixture.secondWorker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  const otherComment = discussion(page).locator("li").filter({ hasText: "Administrator tombstone target" });
  await otherComment.getByRole("button", { name: "Remove" }).click();
  await expect(otherComment.getByRole("alert")).toContainText("only remove your own comments");

  await signIn(page, fixture.administrator);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await discussion(page).locator("li").filter({ hasText: "Administrator tombstone target" }).getByRole("button", { name: "Remove" }).click();
  await expect(discussion(page).getByText("Comment removed")).toBeVisible();
  await expect(discussion(page).getByText("Administrator tombstone target")).toHaveCount(0);
});

test("impersonated comments show effective author and real actor attribution", async ({ page }) => {
  await signIn(page, fixture.administrator);

  await page.goto("/settings");
  const memberRow = page.getByLabel(`Role for ${fixture.worker.email}`).locator("../../..");
  await memberRow.getByRole("button", { name: "Log in as" }).click();
  await page.waitForURL("/");
  await expect(page.getByText("Exit impersonation")).toBeVisible();

  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await discussion(page).getByLabel("Add a comment").fill("Impersonated UI comment");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByText("Impersonated UI comment")).toBeVisible();
  await expect(discussion(page).getByText(`${fixture.worker.email} via ${fixture.administrator.email}`)).toBeVisible();
});
