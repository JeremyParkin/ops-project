import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { requireE2eEnv } from "./helpers/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseTestClient, deleteE2eUsers } from "./helpers/supabase-test-data";

// Focused UI coverage for the Record Work / Work Settings v1a worker-facing
// slice: builder configuration on Manage Object, the Assigned Records
// section on My Work, and the authority boundary (assignment never grants
// mutation rights). RPC-level behavior -- validation, dependency safety,
// notification semantics, people-sensitive visibility, timezone -- is
// already fully covered by lib/domain/work-settings-commit.test.ts and is
// deliberately not re-asserted here.
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

type TestUser = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  entityTypeId: string;
  nameFieldKey: string;
  assigneeFieldId: string;
  statusFieldId: string;
  openOptionId: string;
  doneOptionId: string;
  builder: TestUser;
  userA: TestUser;
  userB: TestUser;
  readOnlyUser: TestUser;
};

let fixture: Fixture;

async function createUser(label: string): Promise<TestUser> {
  const admin = createSupabaseTestClient();
  const password = `WorkSettingsE2E-${randomUUID()}!`;
  const email = `e2e-work-settings-${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user.");
  return { id: data.user.id, email, password };
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length > 0) {
    const { error } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (error) throw new Error(error.message);
  }
  return id;
}

async function addMember(workspaceId: string, user: TestUser, roleId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: user.id, role_id: roleId });
  if (error) throw new Error(error.message);
}

// /sign-in redirects straight back to / when a session cookie is already
// present, so switching between four different personas within one test
// (unlike every existing spec, which signs in once per test) requires an
// explicit sign-out first -- otherwise the second signIn's own
// getByLabel("Email") never appears and hangs until timeout.
async function signIn(page: Page, user: TestUser) {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

// Quality Review's own mapping form (entity-type-quality-review-form.tsx)
// happens to reuse the same bare "statusFieldId" input name/label text as
// Work Settings' -- harmless at the <form>-submission level (each is a
// separate <form>, so FormData never crosses between them) but ambiguous
// for a page-wide selector, so every locator below is scoped to this one
// section rather than relying on name/label text alone.
function workSettingsSection(page: Page) {
  return page.locator("details", { has: page.getByRole("heading", { name: "Work settings" }) });
}

// The Work settings CollapsibleSection is a controlled <details open={...}>
// bound to the server's own workEnabled state, so it is already open on any
// fresh navigation once Work is enabled -- only click to open it when it is
// still closed, otherwise a click would toggle it shut.
async function openWorkSettings(page: Page) {
  const details = workSettingsSection(page);
  const isOpen = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!isOpen) {
    await page.getByRole("heading", { name: "Work settings" }).click();
  }
}

async function authenticatedClient(user: TestUser): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

test.beforeAll(async () => {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error: workspaceError } = await admin
    .from("workspaces")
    .insert({ id: workspaceId, name: `E2E Work Settings ${workspaceId.slice(0, 8)}` });
  if (workspaceError) throw new Error(workspaceError.message);

  const builderRoleId = await createRole(workspaceId, "builder", ["schema.manage", "records.operate"]);
  const assigneeRoleId = await createRole(workspaceId, "assignee", ["records.operate"]);
  const readOnlyRoleId = await createRole(workspaceId, "read-only", []);

  const builder = await createUser("builder");
  const userA = await createUser("a");
  const userB = await createUser("b");
  const readOnlyUser = await createUser("readonly");
  await Promise.all([
    addMember(workspaceId, builder, builderRoleId),
    addMember(workspaceId, userA, assigneeRoleId),
    addMember(workspaceId, userB, assigneeRoleId),
    addMember(workspaceId, readOnlyUser, readOnlyRoleId),
  ]);

  const entityTypeId = randomUUID();
  const { error: entityTypeError } = await admin.from("entity_types").insert({
    id: entityTypeId,
    workspace_id: workspaceId,
    name: "Household Task",
    slug: `household-task-${entityTypeId.slice(0, 8)}`,
  });
  if (entityTypeError) throw new Error(entityTypeError.message);

  const builderClient = await authenticatedClient(builder);
  const nameFieldKey = "name";
  const { error: nameFieldError } = await builderClient.rpc("add_field_definition", {
    p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Name", p_slug: nameFieldKey,
    p_key: nameFieldKey, p_type: "text", p_required: false, p_related_entity_type_id: null,
  });
  if (nameFieldError) throw new Error(nameFieldError.message);

  const { data: assigneeFieldId, error: assigneeFieldError } = await builderClient.rpc("add_field_definition", {
    p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Assignee", p_slug: "assignee",
    p_key: "assignee", p_type: "workspace_member", p_required: false, p_related_entity_type_id: null,
  });
  if (assigneeFieldError) throw new Error(assigneeFieldError.message);

  const { data: statusFieldId, error: statusFieldError } = await builderClient.rpc("add_field_definition", {
    p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Status", p_slug: "status",
    p_key: "status", p_type: "choice", p_required: false, p_related_entity_type_id: null,
  });
  if (statusFieldError) throw new Error(statusFieldError.message);

  const { data: openOptionId, error: openOptionError } = await builderClient.rpc("add_field_choice_option", {
    p_workspace_id: workspaceId, p_field_definition_id: statusFieldId, p_label: "Open", p_color: "amber",
  });
  if (openOptionError) throw new Error(openOptionError.message);
  const { data: doneOptionId, error: doneOptionError } = await builderClient.rpc("add_field_choice_option", {
    p_workspace_id: workspaceId, p_field_definition_id: statusFieldId, p_label: "Done", p_color: "emerald",
  });
  if (doneOptionError) throw new Error(doneOptionError.message);

  fixture = {
    workspaceId,
    entityTypeId,
    nameFieldKey,
    assigneeFieldId: assigneeFieldId as string,
    statusFieldId: statusFieldId as string,
    openOptionId: openOptionId as string,
    doneOptionId: doneOptionId as string,
    builder,
    userA,
    userB,
    readOnlyUser,
  };
});

test.afterAll(async () => {
  if (!fixture) return;
  const admin = createSupabaseTestClient();
  await admin.from("workspaces").delete().eq("id", fixture.workspaceId);
  await deleteE2eUsers([fixture.builder.id, fixture.userA.id, fixture.userB.id, fixture.readOnlyUser.id], admin);
});

test("configure Work Settings, assign/reassign/complete a record, and keep it distinct from Process work", async ({ page }) => {
  test.setTimeout(120_000);

  // 1. Builder configures Work Settings on Manage Object.
  await signIn(page, fixture.builder);
  await page.goto(`/entities/${fixture.entityTypeId}?manage=true`);
  await openWorkSettings(page);
  await expect(workSettingsSection(page).getByText("Add a Workspace Member field to this object before turning on Work.")).toHaveCount(0);
  await workSettingsSection(page).locator('select[name="assignmentFieldId"]').selectOption(fixture.assigneeFieldId);
  await workSettingsSection(page).locator('select[name="statusFieldId"]').selectOption(fixture.statusFieldId);
  await workSettingsSection(page).getByRole("checkbox", { name: "Done" }).check();
  await workSettingsSection(page).getByRole("button", { name: "Save mapping" }).click();
  await expect(workSettingsSection(page).getByText("Work Settings mapping saved.")).toBeVisible();
  await workSettingsSection(page).getByRole("button", { name: "Enable Work" }).click();
  await expect(workSettingsSection(page).getByText("Work enabled.")).toBeVisible();
  await expect(workSettingsSection(page).getByText("Work is currently")).toContainText("enabled");

  // 2. Create a record and assign it to userA via the ordinary record edit
  // form -- the same generic surface every other field type already uses,
  // no special assignment UI.
  const { data: recordId, error: recordError } = await (await authenticatedClient(fixture.builder)).rpc(
    "create_entity_record_with_relations_authorized",
    { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityTypeId, p_values: { [fixture.nameFieldKey]: "Renew the annual filing" }, p_relations: [] },
  );
  expect(recordError).toBeNull();

  await page.goto(`/entities/${fixture.entityTypeId}/records/${recordId}/edit`);
  await page.locator(`[name="assignee"]`).selectOption(fixture.userA.id);
  await page.locator(`[name="status"]`).selectOption(fixture.openOptionId);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForURL(new RegExp(`/entities/${fixture.entityTypeId}(/records/${recordId})?$`));

  // 3. userA sees it under Assigned records, distinct from Process work.
  await signIn(page, fixture.userA);
  await page.goto("/my-work");
  await expect(page.getByRole("heading", { name: "Process work" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assigned records" })).toBeVisible();
  await expect(page.getByText("Renew the annual filing")).toBeVisible();
  await expect(page.getByText("Household Task")).toBeVisible();
  // Process work's own three buckets remain their original, unrelated
  // "step(s)" copy -- proving the two sections were not merged into one
  // undifferentiated list.
  await expect(page.getByText(/^0 steps?$/).first()).toBeVisible();

  // 4. Genuine reassignment: userA -> userB moves the record.
  await signIn(page, fixture.builder);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${recordId}/edit`);
  await page.locator(`[name="assignee"]`).selectOption(fixture.userB.id);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForURL(new RegExp(`/entities/${fixture.entityTypeId}(/records/${recordId})?$`));

  await signIn(page, fixture.userA);
  await page.goto("/my-work");
  await expect(page.getByText("Renew the annual filing")).toHaveCount(0);

  await signIn(page, fixture.userB);
  await page.goto("/my-work");
  await expect(page.getByText("Renew the annual filing")).toBeVisible();

  // 5. Configured completion status removes the record from Assigned
  // records.
  await signIn(page, fixture.builder);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${recordId}/edit`);
  await page.locator(`[name="status"]`).selectOption(fixture.doneOptionId);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForURL(new RegExp(`/entities/${fixture.entityTypeId}(/records/${recordId})?$`));

  await signIn(page, fixture.userB);
  await page.goto("/my-work");
  await expect(page.getByText("Renew the annual filing")).toHaveCount(0);

  // 6. Disabling Work removes it from My Work while preserving the mapping
  // in Manage Object (re-opened, not cleared).
  await signIn(page, fixture.builder);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${recordId}/edit`);
  await page.locator(`[name="status"]`).selectOption(fixture.openOptionId);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForURL(new RegExp(`/entities/${fixture.entityTypeId}(/records/${recordId})?$`));

  await page.goto(`/entities/${fixture.entityTypeId}?manage=true`);
  await openWorkSettings(page);
  await workSettingsSection(page).getByRole("button", { name: "Disable Work" }).click();
  // The Work settings section is the shared, pre-existing CollapsibleSection
  // primitive with defaultOpen bound to workEnabled (same as Quality
  // Review's own section) -- disabling flips workEnabled to false and the
  // section re-collapses on the very same render as the confirmation
  // message, so the message is real but momentarily inside a closed
  // <details>. Verified below via the outcome (My Work + the reopened,
  // preserved mapping) rather than asserting transient visibility.
  await page.waitForLoadState("networkidle");

  await signIn(page, fixture.userB);
  await page.goto("/my-work");
  await expect(page.getByText("Renew the annual filing")).toHaveCount(0);

  await signIn(page, fixture.builder);
  await page.goto(`/entities/${fixture.entityTypeId}?manage=true`);
  await openWorkSettings(page);
  await expect(workSettingsSection(page).locator('select[name="assignmentFieldId"]')).toHaveValue(fixture.assigneeFieldId);
  await expect(workSettingsSection(page).locator('select[name="statusFieldId"]')).toHaveValue(fixture.statusFieldId);
  await expect(workSettingsSection(page).getByRole("checkbox", { name: "Done" })).toBeChecked();

  // Re-enable so the remaining assertions exercise a live configuration.
  await workSettingsSection(page).getByRole("button", { name: "Enable Work" }).click();
  await expect(workSettingsSection(page).getByText("Work enabled.")).toBeVisible();
});

test("a read-only assignee sees an assigned record in My Work but gains no mutation authority", async ({ page }) => {
  test.setTimeout(60_000);

  const builderClient = await authenticatedClient(fixture.builder);
  const { data: recordId, error: recordError } = await builderClient.rpc(
    "create_entity_record_with_relations_authorized",
    { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityTypeId, p_values: { [fixture.nameFieldKey]: "Read-only assignment check" }, p_relations: [] },
  );
  expect(recordError).toBeNull();
  await builderClient.rpc("update_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityTypeId, p_record_id: recordId,
    p_values: { [fixture.nameFieldKey]: "Read-only assignment check", status: fixture.openOptionId },
    p_relation_field_ids: [], p_relations: [],
    p_workspace_member_field_ids: [fixture.assigneeFieldId],
    p_workspace_members: [{ field_definition_id: fixture.assigneeFieldId, member_user_id: fixture.readOnlyUser.id }],
  });

  await signIn(page, fixture.readOnlyUser);
  await page.goto("/my-work");
  await expect(page.getByText("Read-only assignment check")).toBeVisible();
  await page.getByText("Read-only assignment check").click();
  await expect(page).toHaveURL(new RegExp(`/entities/${fixture.entityTypeId}/records/${recordId}$`));
  // Not a second visibility check here: Next.js's route announcer
  // (#__next_route_announcer__) transiently duplicates the new page's
  // title text right after navigation, making a getByText re-match
  // ambiguous/flaky. The URL assertion above already proves navigation
  // landed on the correct record.
  await expect(page.getByRole("heading", { name: "Read-only assignment check" })).toBeVisible();

  // No records.operate: assignment must not have opened any alternate
  // mutation path. Attempting the generic edit RPC directly (the same
  // authoritative boundary every edit path already goes through) must
  // still be rejected -- proving the record-detail page's existing
  // authorization, not anything new this slice introduced, is what
  // governs this.
  const readOnlyClient = await authenticatedClient(fixture.readOnlyUser);
  const { error: mutationError } = await readOnlyClient.rpc("update_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityTypeId, p_record_id: recordId,
    p_values: { [fixture.nameFieldKey]: "Tampered", status: fixture.openOptionId },
    p_relation_field_ids: [], p_relations: [],
    p_workspace_member_field_ids: [fixture.assigneeFieldId],
    p_workspace_members: [{ field_definition_id: fixture.assigneeFieldId, member_user_id: fixture.readOnlyUser.id }],
  });
  expect(mutationError).not.toBeNull();

  const admin = createSupabaseTestClient();
  const { data: recordRow } = await admin.from("entity_records").select("values").eq("id", recordId).single<{ values: Record<string, unknown> }>();
  expect(recordRow?.values[fixture.nameFieldKey]).toBe("Read-only assignment check");
});
