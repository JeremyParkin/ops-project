import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  restrictedRoleId: string;
  admin: User;
  restrictedMember: User;
};

let fixture: Fixture;

function email(label: string) {
  return `e2e-impersonation-ui-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `ImpersonationUi-${randomUUID()}!`;
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

async function signIn(page: Page, user: User) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId, name: `E2E Impersonation UI ${workspaceId.slice(0, 8)}`,
  });
  if (workspaceError) throw new Error(workspaceError.message);

  const adminRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members", "workspace.manage_roles", "workspace.manage_organization", "workspace.manage_settings",
    "schema.manage", "automation.manage", "records.operate", "processes.operate", "operations.view",
    "workspace.impersonate_users",
  ]);
  const restrictedRoleId = await createRole(workspaceId, "Restricted", []);

  const admin_ = await createUser("admin");
  const restrictedMember = await createUser("restricted");

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: admin_.id, role_id: adminRoleId },
    { workspace_id: workspaceId, user_id: restrictedMember.id, role_id: restrictedRoleId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  return { workspaceId, restrictedRoleId, admin: admin_, restrictedMember };
}

async function cleanupFixture(current: Fixture) {
  const admin = createSupabaseTestClient();
  const { error: workspaceError } = await admin.from("workspaces").delete().eq("id", current.workspaceId);
  if (workspaceError) throw new Error(workspaceError.message);
  for (const userId of [current.admin.id, current.restrictedMember.id]) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
  }
}

test.beforeAll(async () => { fixture = await createFixture(); });
test.afterAll(async () => { if (fixture) await cleanupFixture(fixture); });

test("logging in as a restricted member shows the banner, hides Configure, blocks direct settings access, and exiting restores the admin's own view", async ({ page }) => {
  await signIn(page, fixture.admin);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Configure" })).toBeVisible();

  await page.goto("/settings");
  const memberRow = page.getByLabel(`Role for ${fixture.restrictedMember.email}`).locator("../../..");
  await memberRow.getByRole("button", { name: "Log in as" }).click();
  await page.waitForURL("/");

  await expect(page.getByText(fixture.restrictedMember.email, { exact: false })).toBeVisible();
  await expect(page.getByText("Exit impersonation")).toBeVisible();

  // Configure is unconditionally hidden while impersonating.
  await expect(page.getByRole("button", { name: "Configure" })).toHaveCount(0);

  // Direct navigation to /settings must also be blocked, not merely unlinked.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Not available while impersonating." })).toBeVisible();

  await page.getByRole("button", { name: "Exit impersonation" }).click();
  await page.waitForURL("/");
  await expect(page.getByText("Exit impersonation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Configure" })).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
});
