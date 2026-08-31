import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { loadE2eEnv } from "./helpers/env";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

loadE2eEnv();

test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  memberRoleId: string;
  admin: User;
};

const hasEmailConfig = Boolean(
  process.env.RESEND_API_KEY?.trim() &&
    process.env.EMAIL_FROM?.trim() &&
    process.env.KINEMA_PUBLIC_APP_URL?.trim(),
);

function email(label: string) {
  return `e2e-email-ui-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `EmailUi-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({ email: email(label), password, email_confirm: true });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create user.");
  return { id: data.user.id, email: data.user.email, password };
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function createFixture(label: string): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId, name: `E2E Email ${label} ${workspaceId.slice(0, 8)}`,
  });
  if (workspaceError) throw new Error(workspaceError.message);

  const adminRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members",
    "workspace.manage_roles",
    "workspace.manage_settings",
  ]);
  const memberRoleId = await createRole(workspaceId, "Member", []);
  const adminUser = await createUser(`admin-${label}`);

  const { error: membershipError } = await admin.from("workspace_memberships").insert({
    workspace_id: workspaceId,
    user_id: adminUser.id,
    role_id: adminRoleId,
  });
  if (membershipError) throw new Error(membershipError.message);

  return { workspaceId, memberRoleId, admin: adminUser };
}

async function cleanupFixture(fixture: Fixture | null) {
  if (!fixture) return;
  const admin = createSupabaseTestClient();
  const { error: workspaceError } = await admin.from("workspaces").delete().eq("id", fixture.workspaceId);
  if (workspaceError) throw new Error(workspaceError.message);
  const { error: userError } = await admin.auth.admin.deleteUser(fixture.admin.id);
  if (userError) throw new Error(userError.message);
}

async function signIn(page: Page, user: User) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

async function inviteThroughUi(page: Page, inviteeEmail: string) {
  const inviteForm = page.getByRole("heading", { name: "Invite a member" }).locator("..");
  await inviteForm.getByLabel("Email").fill(inviteeEmail);
  await inviteForm.getByLabel("Role").selectOption({ label: "Member" });
  await inviteForm.getByRole("button", { name: "Send invite" }).click();
  const link = await inviteForm.getByLabel("Invitation link").inputValue();
  expect(link).toContain("/accept-invitation?token=");
  return link;
}

async function deliveryRowsForEmail(workspaceId: string, inviteeEmail: string) {
  const admin = createSupabaseTestClient();
  const { data: invitation } = await admin
    .from("workspace_invitations")
    .select("id, token, email_generation_id")
    .eq("workspace_id", workspaceId)
    .eq("email", inviteeEmail)
    .single();
  expect(invitation).not.toBeNull();

  const { data: deliveries, error } = await admin
    .from("outbound_email_deliveries")
    .select("id, status, invitation_generation_id")
    .eq("workspace_invitation_id", invitation!.id)
    .order("created_at", { ascending: true });
  expect(error).toBeNull();
  return { invitation: invitation!, deliveries: deliveries ?? [] };
}

test.describe("provider-disabled invitation email behavior", () => {
  test.skip(hasEmailConfig, "This case verifies manual mode without deployment email config.");

  let fixture: Fixture | null = null;

  test.afterEach(async () => cleanupFixture(fixture));

  test("keeps the previous manual invitation flow and creates no email delivery", async ({ page }) => {
    fixture = await createFixture("disabled");
    await signIn(page, fixture.admin);
    await page.goto("/settings");

    const inviteeEmail = email("disabled-target");
    await inviteThroughUi(page, inviteeEmail);
    await expect(page.getByText("Invitation created. Share this link with them.")).toBeVisible();

    const { deliveries } = await deliveryRowsForEmail(fixture.workspaceId, inviteeEmail);
    expect(deliveries).toHaveLength(0);
  });
});

test.describe("provider-configured invitation email behavior", () => {
  test.skip(!hasEmailConfig, "This case requires RESEND_API_KEY, EMAIL_FROM, and KINEMA_PUBLIC_APP_URL.");

  let fixture: Fixture | null = null;

  test.afterEach(async () => cleanupFixture(fixture));

  test("queues invitation email, keeps manual fallback visible, and supersedes the old generation on resend", async ({ page }) => {
    fixture = await createFixture("configured");
    await signIn(page, fixture.admin);
    await page.goto("/settings");

    const inviteeEmail = email("configured-target");
    const firstLink = await inviteThroughUi(page, inviteeEmail);
    await expect(page.getByText("Invitation created and email queued. You can also share this link manually.")).toBeVisible();

    const first = await deliveryRowsForEmail(fixture.workspaceId, inviteeEmail);
    expect(first.deliveries).toHaveLength(1);
    expect(first.deliveries[0].status).toBe("pending");
    expect(first.deliveries[0].invitation_generation_id).toBe(first.invitation.email_generation_id);

    const invitationRow = page.getByText(inviteeEmail).locator("../..");
    await invitationRow.getByRole("button", { name: "Resend" }).click();
    await expect(page.getByText("Invitation refreshed and email queued. You can also share this new link manually.")).toBeVisible();
    const secondLink = await page.getByLabel("New invitation link").inputValue();
    expect(secondLink).toContain("/accept-invitation?token=");
    expect(secondLink).not.toBe(firstLink);

    const second = await deliveryRowsForEmail(fixture.workspaceId, inviteeEmail);
    expect(second.invitation.email_generation_id).not.toBe(first.invitation.email_generation_id);
    expect(second.deliveries).toHaveLength(2);
    expect(second.deliveries.filter((delivery) => delivery.status === "superseded")).toHaveLength(1);
    expect(second.deliveries.filter((delivery) => delivery.status === "pending")).toHaveLength(1);

    const admin = createSupabaseTestClient();
    const oldDelivery = second.deliveries.find((delivery) => delivery.status === "superseded")!;
    const preparedOld = await admin.rpc("prepare_workspace_invitation_email_delivery_system", {
      p_delivery_id: oldDelivery.id,
    });
    expect(preparedOld.error).toBeNull();
    expect(preparedOld.data).toEqual([]);
  });
});
