import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page, test } from "@playwright/test";
import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

// Phase 12.3.2 Person Review History Experience: focused E2E coverage over
// the real UI -- builder presentation configuration (Review Date/Overall
// Result), the truthful configuration rejection when existing Finalized
// history has an invalid date, the Finalize-time Review Date gate, and the
// Person page's "Review history" section (Finalized-only, newest-first,
// Date/Result/Reviewer rendering, multi-type labels, generic Related left
// unsuppressed). DB/RPC-level coverage of every authorization/visibility
// branch already lives in lib/domain/quality-review-presentation-commit.
// test.ts; this spec only proves the UI wires up to that layer correctly.
test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  personEntityTypeId: string;
  personNameFieldKey: string;
  reviewEntityTypeId: string;
  subjectFieldId: string;
  reviewerFieldId: string;
  dateFieldId: string;
  resultFieldId: string;
  statusFieldId: string;
  builder: User;
  subjectUser: User;
  managerUser: User;
  coworker: User;
  reviewerUser: User;
  otherReviewerUser: User;
  subjectPersonRecordId: string;
  reviewerPersonRecordId: string;
  otherReviewerPersonRecordId: string;
};

let fixture: Fixture;

function email(label: string) {
  return `e2e-qr-history-ui-${label}-${randomUUID()}@example.test`;
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
  const password = `QrHistoryUi-${randomUUID()}!`;
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

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error: workspaceError } = await admin
    .from("workspaces")
    .insert({ id: workspaceId, name: `E2E QR History UI ${workspaceId.slice(0, 8)}` });
  if (workspaceError) throw new Error(workspaceError.message);

  const builderRoleId = await createRole(workspaceId, "Builder", [
    "schema.manage", "workspace.manage_members", "workspace.manage_roles", "people_data.view_all", "records.operate",
  ]);
  const workerRoleId = await createRole(workspaceId, "Worker", ["records.operate"]);

  const builder = await createUser("builder");
  const subjectUser = await createUser("subject");
  const managerUser = await createUser("manager");
  const coworker = await createUser("coworker");
  const reviewerUser = await createUser("reviewer");
  const otherReviewerUser = await createUser("other-reviewer");

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: builder.id, role_id: builderRoleId },
    { workspace_id: workspaceId, user_id: subjectUser.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: managerUser.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: coworker.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: reviewerUser.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: otherReviewerUser.id, role_id: workerRoleId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const personEntityTypeId = await createEntityType(workspaceId, "Team Member");
  const { key: personNameFieldKey } = await createField(workspaceId, personEntityTypeId, { name: "Name", type: "text", position: 1 });
  await admin.from("workspaces").update({ person_entity_type_id: personEntityTypeId }).eq("id", workspaceId);

  const subjectPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Subject Person" });
  const reviewerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Reviewer Person" });
  const otherReviewerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Other Reviewer Person" });
  await admin.from("entity_record_person_links").insert([
    { workspace_id: workspaceId, entity_type_id: personEntityTypeId, entity_record_id: subjectPersonRecordId, user_id: subjectUser.id },
    { workspace_id: workspaceId, entity_type_id: personEntityTypeId, entity_record_id: reviewerPersonRecordId, user_id: reviewerUser.id },
    { workspace_id: workspaceId, entity_type_id: personEntityTypeId, entity_record_id: otherReviewerPersonRecordId, user_id: otherReviewerUser.id },
  ]);
  await admin.from("workspace_reporting_relationships").insert({ workspace_id: workspaceId, manager_user_id: managerUser.id, report_user_id: subjectUser.id });

  const reviewEntityTypeId = await createEntityType(workspaceId, "Quality Review");
  const { id: subjectFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    name: "Reviewed Employee", type: "relation", position: 1, relatedEntityTypeId: personEntityTypeId,
  });
  const { id: reviewerFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: personEntityTypeId,
  });
  await createField(workspaceId, reviewEntityTypeId, { name: "Notes", type: "text", position: 3 });
  const { id: statusFieldId } = await createField(workspaceId, reviewEntityTypeId, { name: "Status", type: "choice", position: 4 });
  const draftOptionId = await addChoiceOption(workspaceId, statusFieldId, "Draft");
  const finalizedOptionId = await addChoiceOption(workspaceId, statusFieldId, "Finalized");
  const { id: dateFieldId } = await createField(workspaceId, reviewEntityTypeId, { name: "Review Date", type: "date", position: 5 });
  const { id: resultFieldId } = await createField(workspaceId, reviewEntityTypeId, { name: "Overall Result", type: "choice", position: 6 });
  await addChoiceOption(workspaceId, resultFieldId, "Pass");
  await addChoiceOption(workspaceId, resultFieldId, "Fail");

  const builderClient = await authenticatedClient(builder);
  const enableSensitive = await builderClient.rpc("set_entity_type_people_sensitive_access_authorized", {
    p_workspace_id: workspaceId, p_entity_type_id: reviewEntityTypeId, p_people_sensitive: true,
    p_subject_person_field_id: subjectFieldId, p_author_person_field_id: reviewerFieldId,
    p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: true,
  });
  if (enableSensitive.error) throw new Error(`enable sensitivity: ${enableSensitive.error.message}`);
  const enableLifecycle = await builderClient.rpc("set_entity_type_quality_review_lifecycle_authorized", {
    p_workspace_id: workspaceId, p_entity_type_id: reviewEntityTypeId, p_quality_review: true,
    p_status_field_id: statusFieldId, p_draft_option_id: draftOptionId, p_finalized_option_id: finalizedOptionId,
  });
  if (enableLifecycle.error) throw new Error(`enable QR lifecycle: ${enableLifecycle.error.message}`);

  return {
    workspaceId, personEntityTypeId, personNameFieldKey, reviewEntityTypeId, subjectFieldId, reviewerFieldId,
    dateFieldId, resultFieldId, statusFieldId, builder, subjectUser, managerUser, coworker, reviewerUser, otherReviewerUser,
    subjectPersonRecordId, reviewerPersonRecordId, otherReviewerPersonRecordId,
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
    quality_review_date_field_id: null, quality_review_result_field_id: null,
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
  for (const user of [fixture.builder, fixture.subjectUser, fixture.managerUser, fixture.coworker, fixture.reviewerUser, fixture.otherReviewerUser]) {
    await admin.auth.admin.deleteUser(user.id);
  }
});

test.describe("person review history", () => {
  test("builder configures Review Date and Overall Result presentation fields through the real UI", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.builder);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}?manage=true`);
    await expect(page.getByRole("heading", { name: "Review presentation" })).toBeVisible();

    const presentationSection = page.locator("section", { has: page.getByRole("heading", { name: "Review presentation" }) });
    const sectionText = await presentationSection.innerText();
    expect(sectionText.toLowerCase()).not.toMatch(/\brls\b|row-level security|\btrigger\b|\bpolicy\b|\bpolicies\b/);

    await presentationSection.getByLabel("Review date field").selectOption({ label: "Review Date" });
    await presentationSection.getByLabel("Overall result field").selectOption({ label: "Overall Result" });
    await presentationSection.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Review presentation configuration saved.")).toBeVisible();

    const { data } = await createSupabaseTestClient()
      .from("entity_types")
      .select("quality_review_date_field_id, quality_review_result_field_id")
      .eq("id", fixture.reviewEntityTypeId)
      .single();
    expect(data?.quality_review_date_field_id).toBe(fixture.dateFieldId);
    expect(data?.quality_review_result_field_id).toBe(fixture.resultFieldId);
  });

  test("existing invalid Finalized history produces a truthful configuration rejection", async ({ page }) => {
    test.setTimeout(60_000);
    const admin = createSupabaseTestClient();
    const scratchWorkspaceId = randomUUID();
    await admin.from("workspaces").insert({ id: scratchWorkspaceId, name: `E2E QR History Invalid ${scratchWorkspaceId.slice(0, 8)}` });
    const scratchRoleId = await createRole(scratchWorkspaceId, "Builder", ["schema.manage", "records.operate"]);
    // A dedicated, single-workspace user -- not fixture.builder, who is
    // already a member of the main fixture workspace. Reusing that account
    // here would make it a member of two workspaces at once, and this
    // app's active-workspace resolution is a session cookie that only
    // tracks one at a time, so navigating as fixture.builder would silently
    // land on the wrong workspace's page instead of this scratch one.
    const scratchBuilder = await createUser("scratch-builder");
    await admin.from("workspace_memberships").insert({ workspace_id: scratchWorkspaceId, user_id: scratchBuilder.id, role_id: scratchRoleId });
    const scratchPersonType = await createEntityType(scratchWorkspaceId, "Person");
    const scratchBuilderClient = await authenticatedClient(scratchBuilder);
    await scratchBuilderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: scratchWorkspaceId, p_entity_type_id: scratchPersonType });
    const scratchSubject = await createRecordDirect(scratchWorkspaceId, scratchPersonType, {});
    const scratchReviewer = await createRecordDirect(scratchWorkspaceId, scratchPersonType, {});

    const scratchType = await createEntityType(scratchWorkspaceId, "Review");
    const { id: subjField } = await createField(scratchWorkspaceId, scratchType, { name: "Subject", type: "relation", position: 1, relatedEntityTypeId: scratchPersonType });
    const { id: revField } = await createField(scratchWorkspaceId, scratchType, { name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: scratchPersonType });
    const { id: statusId, key: statusKey } = await createField(scratchWorkspaceId, scratchType, { name: "Status", type: "choice", position: 3 });
    const draftId = await addChoiceOption(scratchWorkspaceId, statusId, "Draft");
    const finalizedId = await addChoiceOption(scratchWorkspaceId, statusId, "Finalized");
    await createField(scratchWorkspaceId, scratchType, { name: "Review Date", type: "date", position: 4 });

    await scratchBuilderClient.rpc("set_entity_type_people_sensitive_access_authorized", {
      p_workspace_id: scratchWorkspaceId, p_entity_type_id: scratchType, p_people_sensitive: true,
      p_subject_person_field_id: subjField, p_author_person_field_id: revField,
      p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: true,
    });
    await scratchBuilderClient.rpc("set_entity_type_quality_review_lifecycle_authorized", {
      p_workspace_id: scratchWorkspaceId, p_entity_type_id: scratchType, p_quality_review: true,
      p_status_field_id: statusId, p_draft_option_id: draftId, p_finalized_option_id: finalizedId,
    });

    // A pre-existing Finalized record with no Review Date value at all.
    const badRecordId = randomUUID();
    await admin.from("entity_records").insert({ id: badRecordId, workspace_id: scratchWorkspaceId, entity_type_id: scratchType, values: { [statusKey]: finalizedId } });
    await admin.from("entity_record_relation_values").insert([
      { workspace_id: scratchWorkspaceId, source_entity_type_id: scratchType, source_record_id: badRecordId, field_definition_id: subjField, target_entity_type_id: scratchPersonType, target_record_id: scratchSubject },
      { workspace_id: scratchWorkspaceId, source_entity_type_id: scratchType, source_record_id: badRecordId, field_definition_id: revField, target_entity_type_id: scratchPersonType, target_record_id: scratchReviewer },
    ]);

    await signIn(page, scratchBuilder);
    await page.goto(`/entities/${scratchType}?manage=true`);
    const presentationSection = page.locator("section", { has: page.getByRole("heading", { name: "Review presentation" }) });
    await presentationSection.getByLabel("Review date field").selectOption({ label: "Review Date" });
    await presentationSection.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/1 existing finalized review\(s\) do not have a valid review date/i)).toBeVisible();

    // Cleanup this scratch workspace.
    await admin.from("workspaces").update({ person_entity_type_id: null }).eq("id", scratchWorkspaceId);
    await admin.from("entity_types").update({
      subject_person_field_id: null, author_person_field_id: null, quality_review: false,
      quality_review_status_field_id: null, quality_review_draft_option_id: null, quality_review_finalized_option_id: null,
    }).eq("workspace_id", scratchWorkspaceId);
    await admin.from("workspaces").delete().eq("id", scratchWorkspaceId);
    await admin.auth.admin.deleteUser(scratchBuilder.id);
  });

  test("Reviewer cannot Finalize without a valid configured Review Date, and can once one is filled in", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.reviewerUser);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}`);
    await page.getByRole("link", { name: "Add Quality Review" }).first().click();
    await page.getByLabel("Reviewed Employee", { exact: true }).selectOption({ label: "Subject Person" });
    await page.getByLabel("Reviewer", { exact: true }).selectOption({ label: "Reviewer Person" });
    await page.getByLabel("Notes", { exact: true }).fill("Missing date at first.");
    await page.getByRole("button", { name: "Add Quality Review" }).click();
    await expect(page.getByText("Quality Review created.")).toBeVisible();

    const row = page.locator("tr", { hasText: "Missing date at first." });
    await row.getByRole("link").first().click();
    await page.waitForURL(/\/records\//);
    const reviewId = page.url().split("/records/")[1]?.split(/[?#]/)[0] ?? "";
    expect(reviewId).not.toBe("");

    await page.getByRole("button", { name: "Finalize" }).click();
    await expect(page.getByText(/cannot be finalized without a valid review date/i)).toBeVisible();

    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("Review Date", { exact: true }).fill("2026-03-10");
    await page.getByLabel("Overall Result", { exact: true }).selectOption({ label: "Pass" });
    await page.getByRole("button", { name: "Save Changes" }).click();
    await page.getByRole("button", { name: "Finalize" }).click();
    await expect(page.getByText("Finalized", { exact: true }).first()).toBeVisible();
  });

  test("Subject and Manager see Review history after Finalize; an unrelated coworker does not gain record access; multiple reviews render newest-first with Date/Result/Reviewer visible", async ({ page }) => {
    test.setTimeout(60_000);
    // A second, earlier Finalized review with a different Reviewer and Result.
    await signIn(page, fixture.otherReviewerUser);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}`);
    await page.getByRole("link", { name: "Add Quality Review" }).first().click();
    await page.getByLabel("Reviewed Employee", { exact: true }).selectOption({ label: "Subject Person" });
    await page.getByLabel("Reviewer", { exact: true }).selectOption({ label: "Other Reviewer Person" });
    await page.getByLabel("Notes", { exact: true }).fill("Earlier cycle review.");
    await page.getByLabel("Review Date", { exact: true }).fill("2026-01-05");
    await page.getByLabel("Overall Result", { exact: true }).selectOption({ label: "Fail" });
    await page.getByRole("button", { name: "Add Quality Review" }).click();
    await expect(page.getByText("Quality Review created.")).toBeVisible();
    const row = page.locator("tr", { hasText: "Earlier cycle review." });
    await row.getByRole("link").first().click();
    await page.waitForURL(/\/records\//);
    await page.getByRole("button", { name: "Finalize" }).click();
    await expect(page.getByText("Finalized", { exact: true }).first()).toBeVisible();

    await signIn(page, fixture.subjectUser);
    await page.goto(`/entities/${fixture.personEntityTypeId}/records/${fixture.subjectPersonRecordId}`);
    await expect(page.getByRole("heading", { name: "Review history" })).toBeVisible();
    const historySection = page.locator("details", { has: page.getByRole("heading", { name: "Review history" }) });
    const rows = historySection.locator("li");
    await expect(rows).toHaveCount(2);
    // Newest Review Date first.
    await expect(rows.nth(0)).toContainText("Mar");
    await expect(rows.nth(0)).toContainText("Pass");
    await expect(rows.nth(0)).toContainText("Reviewer Person");
    await expect(rows.nth(1)).toContainText("Jan");
    await expect(rows.nth(1)).toContainText("Fail");
    await expect(rows.nth(1)).toContainText("Other Reviewer Person");
    // Generic Related remains present, but the Quality Review subject
    // relation group -- redundant with Review history -- is suppressed;
    // an unrelated group (Reviewer) on the same source type is untouched.
    await expect(page.getByRole("heading", { name: "Related" })).toBeVisible();
    await expect(page.getByText("Quality Reviews via Reviewed Employee")).toHaveCount(0);
    await expect(page.getByText("Quality Reviews via Reviewer")).toBeVisible();

    await signIn(page, fixture.managerUser);
    await page.goto(`/entities/${fixture.personEntityTypeId}/records/${fixture.subjectPersonRecordId}`);
    await expect(page.getByRole("heading", { name: "Review history" })).toBeVisible();
    await expect(page.locator("details", { has: page.getByRole("heading", { name: "Review history" }) }).locator("li")).toHaveCount(2);
    await expect(page.getByText("Quality Reviews via Reviewed Employee")).toHaveCount(0);

    await signIn(page, fixture.coworker);
    const coworkerResponse = await page.goto(`/entities/${fixture.personEntityTypeId}/records/${fixture.subjectPersonRecordId}`);
    expect(coworkerResponse?.status()).not.toBe(404);
    await expect(page.getByRole("heading", { name: "Review history" })).toHaveCount(0);
  });

  test("the Reviewer's own page keeps the unsuppressed Reviewer relation group, with real content, while the subject group stays suppressed", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.managerUser);
    await page.goto(`/entities/${fixture.personEntityTypeId}/records/${fixture.reviewerPersonRecordId}`);
    // No Review history here -- Reviewer Person has never been a review
    // Subject -- but the Reviewer relation group is real, unsuppressed,
    // populated content (managerUser can see it via their own report's
    // Finalized review), proving suppression is selective, not blanket.
    await expect(page.getByRole("heading", { name: "Review history" })).toHaveCount(0);
    await expect(page.getByText("Quality Reviews via Reviewed Employee")).toHaveCount(0);
    const reviewerGroup = page.locator("div", { has: page.getByText("Quality Reviews via Reviewer", { exact: true }) }).first();
    await expect(reviewerGroup.getByText("Missing date at first.")).toBeVisible();
  });

  test("Draft never appears in Review history", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.reviewerUser);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}`);
    await page.getByRole("link", { name: "Add Quality Review" }).first().click();
    await page.getByLabel("Reviewed Employee", { exact: true }).selectOption({ label: "Subject Person" });
    await page.getByLabel("Reviewer", { exact: true }).selectOption({ label: "Reviewer Person" });
    await page.getByLabel("Notes", { exact: true }).fill("Still a draft, not finalized.");
    await page.getByLabel("Review Date", { exact: true }).fill("2026-09-01");
    await page.getByRole("button", { name: "Add Quality Review" }).click();
    await expect(page.getByText("Quality Review created.")).toBeVisible();
    const draftRow = page.locator("tr", { hasText: "Still a draft, not finalized." });
    await draftRow.getByRole("link").first().click();
    await page.waitForURL(/\/records\//);
    const draftReviewId = page.url().split("/records/")[1]?.split(/[?#]/)[0] ?? "";
    expect(draftReviewId).not.toBe("");

    await signIn(page, fixture.managerUser);
    await page.goto(`/entities/${fixture.personEntityTypeId}/records/${fixture.subjectPersonRecordId}`);
    const historySection = page.locator("details", { has: page.getByRole("heading", { name: "Review history" }) });
    await expect(historySection.locator("li")).toHaveCount(2);
    await expect(page.getByText("Still a draft, not finalized.")).toHaveCount(0);

    // Privileged viewer (people_data.view_all): before 12.3.2's Related
    // suppression, this Draft leaked into the generic Related group even
    // though Review history correctly excluded it -- confirm that
    // inconsistency is gone (the whole subject group is suppressed here,
    // Draft included), while the privileged viewer's own direct,
    // authorized access to the Draft record itself is unaffected.
    await signIn(page, fixture.builder);
    await page.goto(`/entities/${fixture.personEntityTypeId}/records/${fixture.subjectPersonRecordId}`);
    await expect(page.locator("details", { has: page.getByRole("heading", { name: "Review history" }) }).locator("li")).toHaveCount(2);
    await expect(page.getByText("Still a draft, not finalized.")).toHaveCount(0);
    await expect(page.getByText("Quality Reviews via Reviewed Employee")).toHaveCount(0);

    const draftDirectResponse = await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${draftReviewId}`);
    expect(draftDirectResponse?.status()).not.toBe(404);
    await expect(page.getByText("Still a draft, not finalized.")).toBeVisible();
  });

  test("multiple Quality Review types each show an understandable type label on their rows", async ({ page }) => {
    test.setTimeout(60_000);
    const admin = createSupabaseTestClient();
    const secondReviewEntityTypeId = await createEntityType(fixture.workspaceId, "Peer Feedback");
    const { id: secondSubjectFieldId } = await createField(fixture.workspaceId, secondReviewEntityTypeId, {
      name: "Reviewed Employee", type: "relation", position: 1, relatedEntityTypeId: fixture.personEntityTypeId,
    });
    const { id: secondReviewerFieldId } = await createField(fixture.workspaceId, secondReviewEntityTypeId, {
      name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: fixture.personEntityTypeId,
    });
    const { id: secondStatusFieldId, key: secondStatusKey } = await createField(fixture.workspaceId, secondReviewEntityTypeId, {
      name: "Status", type: "choice", position: 3,
    });
    const secondDraftId = await addChoiceOption(fixture.workspaceId, secondStatusFieldId, "Draft");
    const secondFinalizedId = await addChoiceOption(fixture.workspaceId, secondStatusFieldId, "Finalized");
    const { id: secondDateFieldId } = await createField(fixture.workspaceId, secondReviewEntityTypeId, { name: "Review Date", type: "date", position: 4 });

    const builderClient = await authenticatedClient(fixture.builder);
    const sensitiveResult = await builderClient.rpc("set_entity_type_people_sensitive_access_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: secondReviewEntityTypeId, p_people_sensitive: true,
      p_subject_person_field_id: secondSubjectFieldId, p_author_person_field_id: secondReviewerFieldId,
      p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: true,
    });
    if (sensitiveResult.error) throw new Error(`sensitive config: ${sensitiveResult.error.message}`);
    const lifecycleResult = await builderClient.rpc("set_entity_type_quality_review_lifecycle_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: secondReviewEntityTypeId, p_quality_review: true,
      p_status_field_id: secondStatusFieldId, p_draft_option_id: secondDraftId, p_finalized_option_id: secondFinalizedId,
    });
    if (lifecycleResult.error) throw new Error(`lifecycle config: ${lifecycleResult.error.message}`);
    const presentationResult = await builderClient.rpc("set_entity_type_quality_review_presentation_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: secondReviewEntityTypeId,
      p_date_field_id: secondDateFieldId, p_result_field_id: null,
    });
    if (presentationResult.error) throw new Error(`presentation config: ${presentationResult.error.message}`);

    // Inserted directly as Finalized WITH its date value already present --
    // the 12.3.1 write-authority trigger correctly blocks any ordinary
    // content edit to an already-Finalized record, so the date must be set
    // in this one insert rather than a follow-up update.
    const { data: secondDateField } = await admin.from("field_definitions").select("key").eq("id", secondDateFieldId).single();
    const secondReviewId = randomUUID();
    const insertResult = await admin.from("entity_records").insert({
      id: secondReviewId, workspace_id: fixture.workspaceId, entity_type_id: secondReviewEntityTypeId,
      values: { [secondStatusKey]: secondFinalizedId, [secondDateField!.key]: "2026-08-01" },
    });
    if (insertResult.error) throw new Error(`second review insert: ${insertResult.error.message}`);
    await admin.from("entity_record_relation_values").insert([
      { workspace_id: fixture.workspaceId, source_entity_type_id: secondReviewEntityTypeId, source_record_id: secondReviewId, field_definition_id: secondSubjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
      { workspace_id: fixture.workspaceId, source_entity_type_id: secondReviewEntityTypeId, source_record_id: secondReviewId, field_definition_id: secondReviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.reviewerPersonRecordId },
    ]);

    await signIn(page, fixture.managerUser);
    await page.goto(`/entities/${fixture.personEntityTypeId}/records/${fixture.subjectPersonRecordId}`);
    const historySection = page.locator("details", { has: page.getByRole("heading", { name: "Review history" }) });
    await expect(historySection.getByText("Peer Feedback")).toBeVisible();
    await expect(historySection.getByText("Quality Review", { exact: true }).first()).toBeVisible();

    // Cleanup the second review type for this workspace.
    await admin.from("entity_record_relation_values").delete().eq("source_record_id", secondReviewId);
    await admin.from("entity_records").delete().eq("id", secondReviewId);
    await admin.from("entity_types").update({
      subject_person_field_id: null, author_person_field_id: null, quality_review: false,
      quality_review_status_field_id: null, quality_review_draft_option_id: null, quality_review_finalized_option_id: null,
      quality_review_date_field_id: null, quality_review_result_field_id: null,
    }).eq("id", secondReviewEntityTypeId);
    await admin.from("field_definitions").delete().eq("entity_type_id", secondReviewEntityTypeId);
    await admin.from("entity_types").delete().eq("id", secondReviewEntityTypeId);
  });
});
