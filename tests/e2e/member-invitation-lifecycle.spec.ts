import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  memberRoleId: string;
  admin: User;
  existingUser: User;
};

let fixture: Fixture;

function email(label: string) {
  return `e2e-invite-lifecycle-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `InviteLifecycle-${randomUUID()}!`;
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
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId, name: `E2E Invite Lifecycle ${workspaceId.slice(0, 8)}`,
  });
  if (workspaceError) throw new Error(workspaceError.message);

  const adminRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members", "workspace.manage_roles", "workspace.manage_organization", "workspace.manage_settings",
  ]);
  const memberRoleId = await createRole(workspaceId, "Member", []);

  const admin_ = await createUser("admin");
  const existingUser = await createUser("existing");

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: admin_.id, role_id: adminRoleId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  return { workspaceId, memberRoleId, admin: admin_, existingUser };
}

async function cleanupFixture(current: Fixture, extraUserIds: string[]) {
  const admin = createSupabaseTestClient();
  const { error: workspaceError } = await admin.from("workspaces").delete().eq("id", current.workspaceId);
  if (workspaceError) throw new Error(workspaceError.message);
  for (const userId of [current.admin.id, current.existingUser.id, ...extraUserIds]) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
  }
}

const extraUserIds: string[] = [];

test.beforeAll(async () => { fixture = await createFixture(); });
test.afterAll(async () => { if (fixture) await cleanupFixture(fixture, extraUserIds); });

test("invites a brand-new person, who creates an account and joins through the accept link", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, fixture.admin);
  await expect(adminPage).toHaveURL(/\/$/);
  await adminPage.goto("/settings");

  const inviteHeading = adminPage.getByRole("heading", { name: "Invite a member" });
  await expect(inviteHeading).toBeVisible();
  const inviteForm = inviteHeading.locator("..");
  const inviteeEmail = email("new-person");
  await inviteForm.getByLabel("Email").fill(inviteeEmail);
  await inviteForm.getByLabel("Role").selectOption({ label: "Member" });
  await inviteForm.getByRole("button", { name: "Send invite" }).click();
  // 8F.4 made this copy conditional on whether outbound email is configured
  // (app/workspace-invitation-actions.ts) -- accept both intentional exact
  // messages, not a loose substring, so an unrelated future copy change
  // still fails this assertion instead of silently passing.
  await expect(
    adminPage.getByText(
      /^Invitation created\. Share this link with them\.$|^Invitation created and email queued\. You can also share this link manually\.$/,
    ),
  ).toBeVisible();
  const link = await inviteForm.getByLabel("Invitation link").inputValue();
  expect(link).toContain("/accept-invitation?token=");

  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await inviteePage.goto(link);
  await expect(inviteePage.getByRole("heading", { name: "Create your account" })).toBeVisible();
  const password = `NewInvitee-${randomUUID()}!`;
  await inviteePage.getByLabel("Password").fill(password);
  await inviteePage.getByRole("button", { name: "Create account and join" }).click();
  await inviteePage.waitForURL("/");
  await expect(inviteePage.getByRole("heading", { name: "Home" })).toBeVisible();

  await adminPage.goto("/settings");
  await expect(adminPage.getByLabel(`Role for ${inviteeEmail}`)).toBeVisible();

  const { data: createdUser } = await createSupabaseTestClient().auth.admin.listUsers();
  const inviteeId = createdUser.users.find((candidate) => candidate.email === inviteeEmail)?.id;
  if (inviteeId) extraUserIds.push(inviteeId);

  await adminContext.close();
  await inviteeContext.close();
});

test("invites an existing Kinema user, who signs in to accept", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, fixture.admin);
  await expect(adminPage).toHaveURL(/\/$/);
  await adminPage.goto("/settings");

  const inviteForm = adminPage.getByRole("heading", { name: "Invite a member" }).locator("..");
  await inviteForm.getByLabel("Email").fill(fixture.existingUser.email);
  await inviteForm.getByLabel("Role").selectOption({ label: "Member" });
  await inviteForm.getByRole("button", { name: "Send invite" }).click();
  const link = await inviteForm.getByLabel("Invitation link").inputValue();

  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await inviteePage.goto(link);
  await expect(inviteePage.getByRole("heading", { name: "Sign in to accept" })).toBeVisible();
  await inviteePage.getByLabel("Password").fill(fixture.existingUser.password);
  await inviteePage.getByRole("button", { name: "Sign in and join" }).click();
  await inviteePage.waitForURL("/");
  await expect(inviteePage.getByRole("heading", { name: "Home" })).toBeVisible();

  await adminContext.close();
  await inviteeContext.close();
});

test("deactivating a member revokes access immediately, and reactivating restores it", async ({ browser }) => {
  const target = await createUser("deactivate-target");
  extraUserIds.push(target.id);
  const admin = createSupabaseTestClient();
  const { error: membershipError } = await admin.from("workspace_memberships").insert({
    workspace_id: fixture.workspaceId, user_id: target.id, role_id: fixture.memberRoleId,
  });
  if (membershipError) throw new Error(membershipError.message);

  const targetClient = await authenticatedClient(target);
  const beforeDeactivation = await targetClient.from("workspace_memberships").select("user_id").eq("user_id", target.id);
  expect(beforeDeactivation.data).toHaveLength(1);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, fixture.admin);
  await expect(adminPage).toHaveURL(/\/$/);
  await adminPage.goto("/settings");

  const memberRow = adminPage.getByText(target.email).locator("../../..");
  adminPage.once("dialog", (dialog) => dialog.accept());
  await memberRow.getByRole("button", { name: "Deactivate" }).click();
  await expect(adminPage.getByText("Member deactivated.")).toBeVisible();

  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();
  await signIn(targetPage, target);
  await expect(targetPage).toHaveURL(/\/no-workspace/);
  await expect(targetPage.getByRole("heading", { name: "No workspace access" })).toBeVisible();

  await memberRow.getByRole("button", { name: "Reactivate" }).click();
  await expect(adminPage.getByText("Member reactivated.")).toBeVisible();

  await targetPage.goto("/");
  await expect(targetPage.getByRole("heading", { name: "Home" })).toBeVisible();

  await adminContext.close();
  await targetContext.close();
});
