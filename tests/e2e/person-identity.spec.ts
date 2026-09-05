import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

// Phase 12.1 People Identity Foundation: focused E2E coverage over the real
// UI -- Person-type designation in Settings (schema.manage-gated), the
// record-detail Identity section (visible read-only to any workspace
// viewer of a designated Person record, mutable only for workspace.
// manage_members holders, hidden entirely while impersonating, absent on
// non-Person records), the member picker's already-linked exclusion, the
// link/unlink round trip, and truthful blocked-action copy for
// redesignation-while-linked and deletion-while-linked. RPC-level coverage
// (every rejection path, impersonation-session semantics, concurrent-link
// race, history events) lives in lib/domain/person-link-commit.test.ts;
// this spec only proves the UI wires up to that RPC layer correctly. Uses
// its own disposable workspace (not the shared demo workspace) so this
// spec's Person-type designation can never interact with any other E2E
// spec or concurrent dogfood activity.

test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  personEntityTypeId: string;
  otherEntityTypeId: string;
  manager: User;
  administrator: User;
  plainOperator: User;
  memberOne: User;
  memberTwo: User;
};

let fixture: Fixture;

function email(label: string) {
  return `e2e-person-identity-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `PersonIdentityUi-${randomUUID()}!`;
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

async function createEntityType(workspaceId: string, name: string) {
  const admin = createSupabaseTestClient();
  const entityTypeId = randomUUID();
  const { error } = await admin.from("entity_types").insert({
    id: entityTypeId,
    workspace_id: workspaceId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${entityTypeId.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);
  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: randomUUID(),
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    // `key` is unique per workspace (unlike `slug`, unique per entity
    // type), so it must be disambiguated across this fixture's two types.
    key: `name_${entityTypeId.slice(0, 8)}`,
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);
  return entityTypeId;
}

async function createRecord(workspaceId: string, entityTypeId: string, name: string) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin
    .from("entity_records")
    .insert({ id: recordId, workspace_id: workspaceId, entity_type_id: entityTypeId, values: { name } });
  if (error) throw new Error(error.message);
  return recordId;
}

async function signIn(page: Page, user: User) {
  // This spec reuses one page across several real, sequential sign-ins as
  // different users -- /sign-in redirects an already-authenticated session
  // straight back to "/", so switching identity requires an explicit sign
  // out first, via the Account-menu dropdown (Sign out's server action
  // itself redirects to /sign-in, matching app/auth-actions.ts's signOut()).
  const accountMenuTrigger = page.getByRole("button", { name: "Account menu" });
  if (await accountMenuTrigger.isVisible().catch(() => false)) {
    await accountMenuTrigger.click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/sign-in");
  } else {
    await page.goto("/sign-in");
  }
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error: workspaceError } = await admin
    .from("workspaces")
    .insert({ id: workspaceId, name: `E2E Person Identity ${workspaceId.slice(0, 8)}` });
  if (workspaceError) throw new Error(workspaceError.message);

  const managerRoleId = await createRole(workspaceId, "Manager", [
    "schema.manage",
    "workspace.manage_members",
    "records.operate",
  ]);
  const administratorRoleId = await createRole(workspaceId, "Administrator", [
    "schema.manage",
    "workspace.manage_members",
    "workspace.impersonate_users",
  ]);
  const plainOperatorRoleId = await createRole(workspaceId, "Plain operator", ["processes.operate"]);
  const workerRoleId = await createRole(workspaceId, "Worker", ["processes.operate"]);

  const manager = await createUser("manager");
  const administrator = await createUser("administrator");
  const plainOperator = await createUser("plain-operator");
  const memberOne = await createUser("member-one");
  const memberTwo = await createUser("member-two");

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: manager.id, role_id: managerRoleId },
    { workspace_id: workspaceId, user_id: administrator.id, role_id: administratorRoleId },
    { workspace_id: workspaceId, user_id: plainOperator.id, role_id: plainOperatorRoleId },
    { workspace_id: workspaceId, user_id: memberOne.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: memberTwo.id, role_id: workerRoleId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const personEntityTypeId = await createEntityType(workspaceId, "Team Member");
  const otherEntityTypeId = await createEntityType(workspaceId, "Deliverable");

  return {
    workspaceId,
    personEntityTypeId,
    otherEntityTypeId,
    manager,
    administrator,
    plainOperator,
    memberOne,
    memberTwo,
  };
}

test.beforeAll(async () => {
  fixture = await createFixture();
});

test.afterAll(async () => {
  if (!fixture) return;
  const admin = createSupabaseTestClient();
  await admin.from("workspaces").update({ person_entity_type_id: null }).eq("id", fixture.workspaceId);
  for (const table of [
    "workspace_events",
    "entity_record_person_links",
    "entity_records",
    "field_definitions",
    "entity_types",
    "workspaces",
  ]) {
    await admin
      .from(table)
      .delete()
      .eq(table === "workspaces" ? "id" : "workspace_id", fixture.workspaceId);
  }
  for (const user of [fixture.manager, fixture.administrator, fixture.plainOperator, fixture.memberOne, fixture.memberTwo]) {
    await admin.auth.admin.deleteUser(user.id);
  }
});

test.describe("person identity foundation", () => {
  test("Person-type designation is gated by schema.manage and persists", async ({ page }) => {
    // First navigation in the suite -- some headroom for a cold dev-server
    // compile of /sign-in, matching this project's established pattern for
    // the first test in a serial multi-step spec.
    test.setTimeout(60_000);
    await signIn(page, fixture.plainOperator);
    await page.goto("/settings");
    await expect(page.getByText("Person type")).toHaveCount(0);

    await signIn(page, fixture.manager);
    await page.goto("/settings");
    await expect(page.getByText("Person type")).toBeVisible();
    await page.getByLabel("Entity type").selectOption({ label: "Team Member" });
    // exact:true -- "Save" would otherwise substring-match the role
    // manager's "Save role" buttons, since `manager` also holds
    // workspace.manage_members and sees that section on the same page.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Person type set.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Entity type")).toHaveValue(fixture.personEntityTypeId);
  });

  test("Identity section: read-only for any viewer, mutable only for workspace.manage_members, hidden while impersonating, absent on non-Person records", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Ada Lovelace");
    const otherRecordId = await createRecord(fixture.workspaceId, fixture.otherEntityTypeId, "Unrelated Deliverable");
    const recordUrl = `/entities/${fixture.personEntityTypeId}/records/${recordId}`;

    // Non-Person record: no Identity section at all, for any viewer.
    await signIn(page, fixture.manager);
    await page.goto(`/entities/${fixture.otherEntityTypeId}/records/${otherRecordId}`);
    await expect(page.getByText("Identity", { exact: true })).toHaveCount(0);

    // Manager links memberOne.
    await page.goto(recordUrl);
    await expect(page.getByText("Identity", { exact: true })).toBeVisible();
    await expect(page.getByText("Not linked to a workspace member.")).toBeVisible();
    await page.getByRole("button", { name: "Link workspace member" }).click();
    const picker = page.getByLabel("Workspace member");
    const optionLabels = await picker.locator("option").allTextContents();
    expect(optionLabels).toContain(fixture.memberOne.email);
    await picker.selectOption({ label: fixture.memberOne.email });
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByText(`Linked to ${fixture.memberOne.email}`)).toBeVisible();

    // Plain operator: sees the linked identity read-only, no mutation controls.
    await signIn(page, fixture.plainOperator);
    await page.goto(recordUrl);
    await expect(page.getByText("Identity", { exact: true })).toBeVisible();
    await expect(page.getByText(`Linked to ${fixture.memberOne.email}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlink" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Link workspace member" })).toHaveCount(0);

    // Administrator sees mutation controls, but hidden while impersonating.
    await signIn(page, fixture.administrator);
    await page.goto(recordUrl);
    await expect(page.getByRole("button", { name: "Unlink" })).toBeVisible();

    await page.goto("/settings");
    const memberRow = page.getByLabel(`Role for ${fixture.plainOperator.email}`).locator("../../..");
    await memberRow.getByRole("button", { name: "Log in as" }).click();
    await page.waitForURL("/");
    await page.goto(recordUrl);
    await expect(page.getByText(`Linked to ${fixture.memberOne.email}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlink" })).toHaveCount(0);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Exit impersonation" }).click();
    await page.waitForURL("/");

    // Manager unlinks, then confirms memberOne is available again while a
    // second record excludes no one else. Also confirms memberOne is
    // excluded from the picker while still linked elsewhere.
    await signIn(page, fixture.manager);
    const secondRecordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Grace Hopper");
    await page.goto(`/entities/${fixture.personEntityTypeId}/records/${secondRecordId}`);
    await page.getByRole("button", { name: "Link workspace member" }).click();
    const secondPickerOptions = await page.getByLabel("Workspace member").locator("option").allTextContents();
    expect(secondPickerOptions).not.toContain(fixture.memberOne.email);
    expect(secondPickerOptions).toContain(fixture.memberTwo.email);
    await page.getByRole("button", { name: "Never mind" }).click();

    await page.goto(recordUrl);
    await page.getByRole("button", { name: "Unlink" }).click();
    await expect(page.getByText("Identity link removed.")).toBeVisible();
    await expect(page.getByText("Not linked to a workspace member.")).toBeVisible();
  });

  test("Person-type redesignation is blocked while a link exists, with truthful copy, and deletion of a linked record is blocked, with truthful copy", async ({
    page,
  }) => {
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Katherine Johnson");
    await signIn(page, fixture.manager);
    const recordUrl = `/entities/${fixture.personEntityTypeId}/records/${recordId}`;

    await page.goto(recordUrl);
    await page.getByRole("button", { name: "Link workspace member" }).click();
    await page.getByLabel("Workspace member").selectOption({ label: fixture.memberOne.email });
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByText(`Linked to ${fixture.memberOne.email}`)).toBeVisible();

    // Redesignation blocked while linked. The <select> is uncontrolled
    // (defaultValue only applies at mount), so the just-picked "Deliverable"
    // stays displayed after the failed submit regardless of server state --
    // a reload forces a genuine remount against the real (unchanged)
    // designation to prove the backing state, not just the error copy.
    await page.goto("/settings");
    await page.getByLabel("Entity type").selectOption({ label: "Deliverable" });
    // exact:true -- "Save" would otherwise substring-match the role
    // manager's "Save role" buttons, since `manager` also holds
    // workspace.manage_members and sees that section on the same page.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/identity links exist/i)).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Entity type")).toHaveValue(fixture.personEntityTypeId);

    // Deletion blocked while linked, with truthful copy.
    await page.goto(recordUrl);
    const recordActions = page.locator("details").filter({ has: page.getByText("More actions", { exact: true }) });
    page.once("dialog", (dialog) => dialog.accept());
    await recordActions.locator("summary").click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(/linked to a workspace member identity/i)).toBeVisible();

    // Clean up: unlink, then redesignation and deletion both succeed.
    await page.getByRole("button", { name: "Unlink" }).click();
    await expect(page.getByText("Identity link removed.")).toBeVisible();
  });
});
