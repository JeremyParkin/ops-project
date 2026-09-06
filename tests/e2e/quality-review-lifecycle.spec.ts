import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page, test } from "@playwright/test";
import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

// Phase 12.3.1 Quality Review Lifecycle & Authority: focused E2E coverage
// over the real UI -- builder configuration of the Draft/Finalized
// lifecycle, Reviewer create/edit/Finalize, Subject/manager Draft-hidden/
// Finalized-visible behavior, the Finalized read-only surface, governance
// Reopen (including the impersonation boundary), and truthful Activity
// attribution. DB/RPC-level coverage of every authorization branch, the
// full delete/archive/restore matrix, and the exact configuration guards
// already lives in lib/domain/quality-review-lifecycle-commit.test.ts;
// this spec only proves the UI wires up to that layer correctly and does
// not re-litigate cases already proven there (e.g. the generic update
// RPC's own status-change rejection, which has no distinct UI path to
// exercise beyond what DB tests already cover).
test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  personEntityTypeId: string;
  personNameFieldKey: string;
  reviewEntityTypeId: string;
  subjectFieldId: string;
  reviewerFieldId: string;
  notesFieldKey: string;
  statusFieldId: string;
  statusFieldKey: string;
  builder: User;
  privileged: User;
  subjectUser: User;
  managerUser: User;
  reviewerUser: User;
  subjectPersonRecordId: string;
  reviewerPersonRecordId: string;
};

let fixture: Fixture;
let sharedReviewId: string;

function email(label: string) {
  return `e2e-qr-lifecycle-ui-${label}-${randomUUID()}@example.test`;
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

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `QrLifecycleUi-${randomUUID()}!`;
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
    const { error } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (error) throw new Error(error.message);
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
  return entityTypeId;
}

async function createField(
  workspaceId: string,
  entityTypeId: string,
  opts: { name: string; type: string; position: number; relatedEntityTypeId?: string },
) {
  const admin = createSupabaseTestClient();
  const fieldId = randomUUID();
  const key = `${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${fieldId.slice(0, 8)}`;
  const { error } = await admin.from("field_definitions").insert({
    id: fieldId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    key,
    name: opts.name,
    slug: key,
    type: opts.type,
    required: false,
    position: opts.position,
    related_entity_type_id: opts.relatedEntityTypeId ?? null,
  });
  if (error) throw new Error(error.message);
  return { id: fieldId, key };
}

async function addChoiceOption(workspaceId: string, fieldId: string, label: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.rpc("add_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldId,
    p_label: label,
    p_color: "gray",
  });
  if (error) throw new Error(error.message);
  return data as string;
}

async function createRecordDirect(workspaceId: string, entityTypeId: string, values: Record<string, unknown> = {}) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin.from("entity_records").insert({ id: recordId, workspace_id: workspaceId, entity_type_id: entityTypeId, values });
  if (error) throw new Error(error.message);
  return recordId;
}

async function signIn(page: Page, user: User) {
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

async function impersonateFromSettings(page: Page, targetEmail: string) {
  await page.goto("/settings");
  const memberRow = page.getByLabel(`Role for ${targetEmail}`).locator("../../..");
  await memberRow.getByRole("button", { name: "Log in as" }).click();
  await page.waitForURL("/");
}

async function exitImpersonation(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Exit impersonation" }).click();
  await page.waitForURL("/");
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error: workspaceError } = await admin
    .from("workspaces")
    .insert({ id: workspaceId, name: `E2E QR Lifecycle UI ${workspaceId.slice(0, 8)}` });
  if (workspaceError) throw new Error(workspaceError.message);

  const builderRoleId = await createRole(workspaceId, "Builder", [
    "schema.manage", "workspace.manage_members", "workspace.manage_roles",
    "workspace.impersonate_users", "people_data.view_all", "records.operate",
  ]);
  const privilegedRoleId = await createRole(workspaceId, "Privileged viewer", ["records.operate", "people_data.view_all"]);
  const workerRoleId = await createRole(workspaceId, "Worker", ["records.operate"]);

  const builder = await createUser("builder");
  const privileged = await createUser("privileged");
  const subjectUser = await createUser("subject");
  const managerUser = await createUser("manager");
  const reviewerUser = await createUser("reviewer");

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: builder.id, role_id: builderRoleId },
    { workspace_id: workspaceId, user_id: privileged.id, role_id: privilegedRoleId },
    { workspace_id: workspaceId, user_id: subjectUser.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: managerUser.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: reviewerUser.id, role_id: workerRoleId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const personEntityTypeId = await createEntityType(workspaceId, "Team Member");
  const { key: personNameFieldKey } = await createField(workspaceId, personEntityTypeId, { name: "Name", type: "text", position: 1 });
  await admin.from("workspaces").update({ person_entity_type_id: personEntityTypeId }).eq("id", workspaceId);

  const subjectPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Subject Person" });
  const reviewerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Reviewer Person" });
  await admin.from("entity_record_person_links").insert([
    { workspace_id: workspaceId, entity_type_id: personEntityTypeId, entity_record_id: subjectPersonRecordId, user_id: subjectUser.id },
    { workspace_id: workspaceId, entity_type_id: personEntityTypeId, entity_record_id: reviewerPersonRecordId, user_id: reviewerUser.id },
  ]);
  await admin.from("workspace_reporting_relationships").insert({ workspace_id: workspaceId, manager_user_id: managerUser.id, report_user_id: subjectUser.id });

  const reviewEntityTypeId = await createEntityType(workspaceId, "Quality Review");
  const { id: subjectFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    name: "Reviewed Employee", type: "relation", position: 1, relatedEntityTypeId: personEntityTypeId,
  });
  const { id: reviewerFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: personEntityTypeId,
  });
  const { key: notesFieldKey } = await createField(workspaceId, reviewEntityTypeId, { name: "Notes", type: "text", position: 3 });
  const { id: statusFieldId, key: statusFieldKey } = await createField(workspaceId, reviewEntityTypeId, { name: "Status", type: "choice", position: 4 });
  await addChoiceOption(workspaceId, statusFieldId, "Draft");
  await addChoiceOption(workspaceId, statusFieldId, "Finalized");

  // Sensitive-access prerequisites configured via RPC (fixture setup, not
  // the behavior under test) -- the QR lifecycle configuration itself is
  // configured through the real UI, in the first test below.
  const builderClient = await authenticatedClient(builder);
  const enableSensitive = await builderClient.rpc("set_entity_type_people_sensitive_access_authorized", {
    p_workspace_id: workspaceId, p_entity_type_id: reviewEntityTypeId, p_people_sensitive: true,
    p_subject_person_field_id: subjectFieldId, p_author_person_field_id: reviewerFieldId,
    p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: true,
  });
  if (enableSensitive.error) throw new Error(`enable sensitivity: ${enableSensitive.error.message}`);

  return {
    workspaceId, personEntityTypeId, personNameFieldKey, reviewEntityTypeId, subjectFieldId, reviewerFieldId,
    notesFieldKey, statusFieldId, statusFieldKey, builder, privileged, subjectUser, managerUser, reviewerUser,
    subjectPersonRecordId, reviewerPersonRecordId,
  };
}

test.beforeAll(async () => {
  fixture = await createFixture();
});

test.afterAll(async () => {
  if (!fixture) return;
  const admin = createSupabaseTestClient();
  await admin.from("workspaces").update({ person_entity_type_id: null }).eq("id", fixture.workspaceId);
  await admin.from("entity_types").update({
    subject_person_field_id: null, author_person_field_id: null,
    quality_review: false, quality_review_status_field_id: null,
    quality_review_draft_option_id: null, quality_review_finalized_option_id: null,
  }).eq("workspace_id", fixture.workspaceId);
  for (const table of [
    "workspace_reporting_relationships",
    "entity_record_person_links",
    "entity_record_relation_values",
    "workspace_events",
    "entity_records",
    "field_choice_options",
    "field_definitions",
    "entity_types",
    "workspace_role_capabilities",
    "workspace_memberships",
    "workspace_roles",
    "workspaces",
  ]) {
    await admin.from(table).delete().eq(table === "workspaces" ? "id" : "workspace_id", fixture.workspaceId);
  }
  for (const user of [fixture.builder, fixture.privileged, fixture.subjectUser, fixture.managerUser, fixture.reviewerUser]) {
    await admin.auth.admin.deleteUser(user.id);
  }
});

test.describe("quality review lifecycle", () => {
  test("builder configures Quality Review lifecycle through the real UI", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.builder);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}?manage=true`);
    await expect(page.getByRole("heading", { name: "Quality Review lifecycle" })).toBeVisible();

    // No RLS/security-mechanism terminology in worker-facing copy.
    const sectionText = await page.locator("section", { has: page.getByRole("heading", { name: "Quality Review lifecycle" }) }).innerText();
    expect(sectionText.toLowerCase()).not.toMatch(/\brls\b|row-level security|\btrigger\b|\bpolicy\b|\bpolicies\b/);

    const qrSection = page.locator("section", { has: page.getByRole("heading", { name: "Quality Review lifecycle" }) });
    await qrSection.getByLabel("Track a Draft/Finalized lifecycle for this object").check();
    await qrSection.getByLabel("Status field").selectOption({ label: "Status" });
    await qrSection.getByLabel("Draft option").selectOption({ label: "Draft" });
    await qrSection.getByLabel("Finalized option").selectOption({ label: "Finalized" });
    await qrSection.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Quality Review lifecycle configuration saved.")).toBeVisible();

    const { data } = await createSupabaseTestClient()
      .from("entity_types")
      .select("quality_review, quality_review_status_field_id")
      .eq("id", fixture.reviewEntityTypeId)
      .single();
    expect(data?.quality_review).toBe(true);
    expect(data?.quality_review_status_field_id).toBe(fixture.statusFieldId);
  });

  test("Reviewer creates a Draft through the UI with status omitted, and can edit it", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.reviewerUser);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}`);
    await page.getByRole("link", { name: "Add Quality Review" }).first().click();
    await page.getByLabel("Reviewed Employee", { exact: true }).selectOption({ label: "Subject Person" });
    await page.getByLabel("Reviewer", { exact: true }).selectOption({ label: "Reviewer Person" });
    await page.getByLabel("Notes", { exact: true }).fill("Solid quarter, met all deliverables.");
    // Status deliberately left untouched -- proving the omitted-status ->
    // Draft default from the real create form, not a direct RPC call.
    await page.getByRole("button", { name: "Add Quality Review" }).click();
    await expect(page.getByText("Quality Review created.")).toBeVisible();

    const row = page.locator("tr", { hasText: "Solid quarter, met all deliverables." });
    await row.getByRole("link").first().click();
    await page.waitForURL(/\/records\//);
    sharedReviewId = page.url().split("/records/")[1]?.split(/[?#]/)[0] ?? "";
    expect(sharedReviewId).not.toBe("");

    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Finalize" })).toBeVisible();

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("Notes", { exact: true }).fill("Solid quarter, met all deliverables. Promotion recommended.");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByRole("heading", { name: "Solid quarter, met all deliverables. Promotion recommended." })).toBeVisible();
  });

  test("Subject cannot discover the Draft; a manager who is not the Reviewer cannot either", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.subjectUser);
    const response = await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${sharedReviewId}`);
    expect(response?.status()).toBe(404);

    await signIn(page, fixture.managerUser);
    const managerResponse = await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${sharedReviewId}`);
    expect(managerResponse?.status()).toBe(404);
  });

  test("Reviewer Finalizes; the Finalized surface is read-only; Subject and manager visibility now appears", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.reviewerUser);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${sharedReviewId}`);
    await page.getByRole("button", { name: "Finalize" }).click();
    await expect(page.getByText("Finalized", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Finalize" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
    // Reviewer continues to see their own finalized review.
    await expect(page.getByRole("heading", { name: "Solid quarter, met all deliverables. Promotion recommended." })).toBeVisible();

    await signIn(page, fixture.subjectUser);
    const subjectResponse = await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${sharedReviewId}`);
    expect(subjectResponse?.status()).not.toBe(404);
    await expect(page.getByText("Finalized", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);

    await signIn(page, fixture.managerUser);
    const managerResponse = await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${sharedReviewId}`);
    expect(managerResponse?.status()).not.toBe(404);
    await expect(page.getByText("Finalized", { exact: true }).first()).toBeVisible();
  });

  test("governance Reopen is unavailable while impersonating, and a real privileged actor can reopen for correction", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.builder);
    await impersonateFromSettings(page, fixture.subjectUser.email);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${sharedReviewId}`);
    await expect(page.getByRole("button", { name: "Reopen for correction" })).toHaveCount(0);
    await exitImpersonation(page);

    await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${sharedReviewId}`);
    await page.getByRole("button", { name: "Reopen for correction" }).click();
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
    // Builder is not the Reviewer -- no ordinary edit affordance while Draft.
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  });

  test("after Reopen, the Reviewer corrects the Draft and re-Finalizes, and Activity shows both lifecycle events truthfully", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.reviewerUser);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${sharedReviewId}`);
    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("Notes", { exact: true }).fill("Solid quarter, met all deliverables. Promotion recommended. Corrected typo.");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await page.getByRole("button", { name: "Finalize" }).click();
    await expect(page.getByText("Finalized", { exact: true }).first()).toBeVisible();

    const activityDetails = page.locator("details", { has: page.getByRole("heading", { name: "Activity" }) });
    await activityDetails.locator("summary").click();
    await expect(activityDetails).toContainText(`Finalized by ${fixture.reviewerUser.email}`);
    await expect(activityDetails).toContainText(`Reopened for correction by ${fixture.builder.email}`);
  });

  test("Finalized hard delete remains blocked; governance can archive a Draft for administrative cleanup", async ({ page }) => {
    test.setTimeout(60_000);
    const privilegedClient = await authenticatedClient(fixture.privileged);
    const deleteAttempt = await privilegedClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: sharedReviewId,
    });
    expect(deleteAttempt.error?.message).toMatch(/finalized quality review cannot be deleted/i);

    // A fresh Draft, cleaned up by governance without reassignment -- the
    // approved administrative-cleanup path, exercised through the real UI.
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const created = await reviewerClient.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.reviewerPersonRecordId },
        { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
      ],
    });
    if (created.error) throw new Error(created.error.message);
    const draftForCleanupId = created.data as string;

    await signIn(page, fixture.privileged);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${draftForCleanupId}`);
    await page.locator("summary", { hasText: "More actions" }).click();
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  });
});
