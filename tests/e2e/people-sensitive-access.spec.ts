import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page, test } from "@playwright/test";
import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";
import { apiKeyPreview, generateApiKey, hashApiKey } from "../../lib/domain/api-key-signing";

// Real signed-in Supabase client for a given persona, distinct from the
// service-role admin client -- needed wherever a scenario depends on WHO is
// calling (records.operate/effective-user/impersonation-session state),
// which a service-role call bypasses entirely and would prove nothing.
async function authenticatedClient(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

// Phase 12.2 People-Sensitive Read Access: focused E2E coverage over the
// real UI (and, for the public API, the real HTTP contract) -- builder
// configuration and its guards, subject/manager/reviewer/coworker/
// privileged visibility, impersonation boundaries, leak prevention across
// list/search/Related/relation-picker/API, and archived-Person/governance
// behavior. DB/RPC-level coverage of every rejection path and edge case
// already lives in lib/domain/people-sensitive-access-commit.test.ts; this
// spec only proves the UI/API wire up to that layer correctly. Uses its
// own disposable workspace (never the shared demo workspace), matching
// person-identity.spec.ts's isolation discipline.
test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };
type Fixture = {
  workspaceId: string;
  personEntityTypeId: string;
  personNameFieldKey: string;
  reviewEntityTypeId: string;
  subjectFieldId: string;
  reviewerFieldId: string;
  scoreFieldKey: string;
  ordinaryEntityTypeId: string;
  builder: User; // schema.manage + workspace.manage_members/roles + automation.manage + impersonate_users + people_data.view_all + records.operate (real actor for impersonation/config tests)
  privileged: User; // records.operate + people_data.view_all only, distinct from builder
  coworker: User; // records.operate only, unrelated, also the team lead over subject's team
  subject: User;
  manager: User;
  otherManager: User;
  reviewer: User;
  subjectPersonRecordId: string;
  reviewerPersonRecordId: string;
};

let fixture: Fixture;

function email(label: string) {
  return `e2e-people-sensitive-ui-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `PeopleSensitiveUi-${randomUUID()}!`;
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
  opts: { name: string; type: string; position: number; required?: boolean; relatedEntityTypeId?: string },
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
    required: opts.required ?? false,
    position: opts.position,
    related_entity_type_id: opts.relatedEntityTypeId ?? null,
  });
  if (error) throw new Error(error.message);
  return { id: fieldId, key };
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
    .insert({ id: workspaceId, name: `E2E People Sensitive UI ${workspaceId.slice(0, 8)}` });
  if (workspaceError) throw new Error(workspaceError.message);

  const builderRoleId = await createRole(workspaceId, "Builder", [
    "schema.manage",
    "automation.manage",
    "workspace.manage_members",
    "workspace.manage_roles",
    "workspace.impersonate_users",
    "workspace.manage_integrations",
    "people_data.view_all",
    "records.operate",
  ]);
  const privilegedRoleId = await createRole(workspaceId, "Privileged viewer", ["records.operate", "people_data.view_all"]);
  const workerRoleId = await createRole(workspaceId, "Worker", ["records.operate"]);

  const builder = await createUser("builder");
  const privileged = await createUser("privileged");
  const coworker = await createUser("coworker");
  const subject = await createUser("subject");
  const manager = await createUser("manager");
  const otherManager = await createUser("other-manager");
  const reviewer = await createUser("reviewer");

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: builder.id, role_id: builderRoleId },
    { workspace_id: workspaceId, user_id: privileged.id, role_id: privilegedRoleId },
    { workspace_id: workspaceId, user_id: coworker.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: subject.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: manager.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: otherManager.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: reviewer.id, role_id: workerRoleId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const personEntityTypeId = await createEntityType(workspaceId, "Team Member");
  const { key: personNameFieldKey } = await createField(workspaceId, personEntityTypeId, { name: "Name", type: "text", position: 1 });

  await admin.from("workspaces").update({ person_entity_type_id: personEntityTypeId }).eq("id", workspaceId);

  const subjectPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Subject Person" });
  const reviewerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Reviewer Person" });
  await admin.from("entity_record_person_links").insert([
    { workspace_id: workspaceId, entity_type_id: personEntityTypeId, entity_record_id: subjectPersonRecordId, user_id: subject.id },
    { workspace_id: workspaceId, entity_type_id: personEntityTypeId, entity_record_id: reviewerPersonRecordId, user_id: reviewer.id },
  ]);
  await admin.from("workspace_reporting_relationships").insert({ workspace_id: workspaceId, manager_user_id: manager.id, report_user_id: subject.id });

  // Team + team lead: proves team-lead status alone grants nothing.
  const teamId = randomUUID();
  await admin.from("workspace_teams").insert({ id: teamId, workspace_id: workspaceId, name: "Subject's Team" });
  await admin.from("workspace_team_memberships").insert({ workspace_id: workspaceId, team_id: teamId, user_id: subject.id });
  await admin.from("workspace_team_leads").insert({ workspace_id: workspaceId, team_id: teamId, user_id: coworker.id });

  const reviewEntityTypeId = await createEntityType(workspaceId, "Quality Review");
  const { id: subjectFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    name: "Reviewed Employee", type: "relation", position: 1, relatedEntityTypeId: personEntityTypeId,
  });
  const { id: reviewerFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: personEntityTypeId,
  });
  const { key: scoreFieldKey } = await createField(workspaceId, reviewEntityTypeId, { name: "Score", type: "text", position: 3 });
  await createField(workspaceId, reviewEntityTypeId, { name: "Notes", type: "text", position: 4 });

  const ordinaryEntityTypeId = await createEntityType(workspaceId, "Project");
  await createField(workspaceId, ordinaryEntityTypeId, { name: "Name", type: "text", position: 1, required: true });
  await createField(workspaceId, ordinaryEntityTypeId, {
    name: "Related Review", type: "relation", position: 2, relatedEntityTypeId: reviewEntityTypeId,
  });

  return {
    workspaceId, personEntityTypeId, personNameFieldKey, reviewEntityTypeId, subjectFieldId, reviewerFieldId, scoreFieldKey, ordinaryEntityTypeId,
    builder, privileged, coworker, subject, manager, otherManager, reviewer,
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
  await admin.from("entity_types").update({ subject_person_field_id: null, author_person_field_id: null }).eq("workspace_id", fixture.workspaceId);
  for (const table of [
    "workspace_team_leads",
    "workspace_team_memberships",
    "workspace_teams",
    "workspace_reporting_relationships",
    "entity_record_person_links",
    "entity_record_relation_values",
    "record_comments",
    "record_input_requests",
    "api_keys",
    "entity_records",
    "field_definitions",
    "entity_types",
    "workspace_role_capabilities",
    "workspace_memberships",
    "workspace_roles",
    "workspaces",
  ]) {
    await admin
      .from(table)
      .delete()
      .eq(table === "workspaces" ? "id" : "workspace_id", fixture.workspaceId);
  }
  for (const user of [fixture.builder, fixture.privileged, fixture.coworker, fixture.subject, fixture.manager, fixture.otherManager, fixture.reviewer]) {
    await admin.auth.admin.deleteUser(user.id);
  }
});

test.describe("people-sensitive access", () => {
  test("builder configuration: guards, truthful copy, and successful setup", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page, fixture.builder);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}?manage=true`);
    await expect(page.getByRole("heading", { name: "Sensitive people data" })).toBeVisible();

    // No RLS/security-mechanism terminology in worker-facing copy.
    const sectionText = await page.locator("section", { has: page.getByRole("heading", { name: "Sensitive people data" }) }).innerText();
    expect(sectionText.toLowerCase()).not.toMatch(/\brls\b|row-level security|\bpolicy\b|\bpolicies\b/);

    // The UI itself prevents even attempting to enable author_can_view
    // without a designated author field first -- the control is disabled
    // until one is chosen, so a builder cannot reach an invalid submission
    // through this form at all. (The RPC's own rejection of that same
    // invalid combination, reachable only by bypassing the UI, is already
    // covered in lib/domain/people-sensitive-access-commit.test.ts.)
    await page.getByLabel("Treat this object as sensitive people data").check();
    await page.getByLabel("Subject field").selectOption({ label: "Reviewed Employee" });
    await expect(page.getByLabel("Reviewer/author can view")).toBeDisabled();
    await page.getByLabel("Reviewer/author field (optional)").selectOption({ label: "Reviewer" });
    await expect(page.getByLabel("Reviewer/author can view")).toBeEnabled();
    await page.getByLabel("Reviewer/author field (optional)").selectOption({ label: "None" });

    // Enabling is blocked truthfully while an existing record lacks a valid subject.
    const orphanRecordId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    await page.reload();
    await page.getByLabel("Treat this object as sensitive people data").check();
    await page.getByLabel("Subject field").selectOption({ label: "Reviewed Employee" });
    await page.locator("section", { has: page.getByRole("heading", { name: "Sensitive people data" }) }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/do not have a valid subject relation/i)).toBeVisible();
    await expect(page.getByText(/^1 /)).toBeVisible();
    await createSupabaseTestClient().from("entity_records").delete().eq("id", orphanRecordId);

    // Process Template conflict, truthfully reported. Setup via a real
    // signed-in builder client (automation.manage) -- require_interactive_
    // workspace_capability's service_role bypass does not apply to a
    // service-role-keyed client with no active session, confirmed by
    // inspection here, so fixture setup for capability-gated RPCs uses a
    // genuine authenticated persona throughout this spec.
    const admin = createSupabaseTestClient();
    const builderClientForSetup = await authenticatedClient(fixture.builder);
    const { error: templateError } = await builderClientForSetup.rpc("save_process_template_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_template_id: null,
      p_name: "Conflict Template",
      p_description: null,
      p_applies_to_entity_type_id: fixture.reviewEntityTypeId,
      p_steps: [
        {
          client_key: "step-1", node_id: "", node_type: "human_task", parallel_group_id: null,
          name: "Step 1", assignee_user_id: "", due_rule: null, wait_rule: null,
          condition_wait_rule: null, action_config: null, routes: [],
        },
      ],
    });
    expect(templateError).toBeNull();
    await page.reload();
    await page.getByLabel("Treat this object as sensitive people data").check();
    await page.getByLabel("Subject field").selectOption({ label: "Reviewed Employee" });
    await page.locator("section", { has: page.getByRole("heading", { name: "Sensitive people data" }) }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/process template/i)).toBeVisible();

    // Clean up the conflicting template, then complete a real, successful save.
    const { data: templateRow } = await admin
      .from("process_templates")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("name", "Conflict Template")
      .single();
    await admin.from("process_templates").delete().eq("id", (templateRow as { id: string }).id);

    await page.reload();
    await page.getByLabel("Treat this object as sensitive people data").check();
    await page.getByLabel("Subject field").selectOption({ label: "Reviewed Employee" });
    await page.getByLabel("Reviewer/author field (optional)").selectOption({ label: "Reviewer" });
    await page.getByLabel("Subject can view").check();
    await page.getByLabel("Primary manager can view").check();
    await page.getByLabel("Reviewer/author can view").check();
    await page.locator("section", { has: page.getByRole("heading", { name: "Sensitive people data" }) }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Sensitive people data configuration saved.")).toBeVisible();

    // Person-type redesignation is blocked (this fixture also has identity
    // links, so either guard is a legitimate, sufficient block -- which
    // exact guard fires is already proven at the DB layer in
    // people-sensitive-access-commit.test.ts; this only proves the UI/RPC
    // wiring rejects the attempt and leaves the designation unchanged).
    // Scoped to the Person-type form specifically to avoid the unrelated
    // "View all sensitive people data" capability-checkbox text on the same
    // settings page.
    await page.goto("/settings");
    await page.getByLabel("Entity type").selectOption({ label: "Project" });
    const personTypeSection = page.locator("section", { has: page.getByText("Person type") });
    await personTypeSection.getByRole("button", { name: "Save", exact: true }).click();
    await expect(personTypeSection).toContainText(/identity links exist|sensitive people data/i);
    await page.reload();
    await expect(page.getByLabel("Entity type")).toHaveValue(fixture.personEntityTypeId);
  });

  test("visibility: subject, manager, team lead, reviewer, and unrelated coworker", async ({ page }) => {
    test.setTimeout(60_000);
    const admin = createSupabaseTestClient();
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, { });
    await admin.from("entity_record_relation_values").insert([
      { workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: reviewId, field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
      { workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: reviewId, field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.reviewerPersonRecordId },
    ]);
    const reviewUrl = `/entities/${fixture.reviewEntityTypeId}/records/${reviewId}`;

    // Subject sees it (subject_can_view enabled from the prior test).
    await signIn(page, fixture.subject);
    const subjectResponse = await page.goto(reviewUrl);
    expect(subjectResponse?.status()).not.toBe(404);
    await expect(page.getByText("Reviewed Employee")).toBeVisible();

    // Manager sees it.
    await signIn(page, fixture.manager);
    const managerResponse = await page.goto(reviewUrl);
    expect(managerResponse?.status()).not.toBe(404);

    // Team lead over the subject's team gets nothing merely from that status.
    await signIn(page, fixture.coworker);
    const teamLeadResponse = await page.goto(reviewUrl);
    expect(teamLeadResponse?.status()).toBe(404);

    // Reviewer sees it independently.
    await signIn(page, fixture.reviewer);
    const reviewerResponse = await page.goto(reviewUrl);
    expect(reviewerResponse?.status()).not.toBe(404);

    // Disable subject_can_view; subject loses access.
    await signIn(page, fixture.builder);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}?manage=true`);
    await page.getByLabel("Subject can view").uncheck();
    await page.locator("section", { has: page.getByRole("heading", { name: "Sensitive people data" }) }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Sensitive people data configuration saved.")).toBeVisible();

    await signIn(page, fixture.subject);
    const subjectDeniedResponse = await page.goto(reviewUrl);
    expect(subjectDeniedResponse?.status()).toBe(404);

    // Restore subject_can_view for later tests.
    await signIn(page, fixture.builder);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}?manage=true`);
    await page.getByLabel("Subject can view").check();
    await page.locator("section", { has: page.getByRole("heading", { name: "Sensitive people data" }) }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Sensitive people data configuration saved.")).toBeVisible();

    (fixture as unknown as { sharedReviewId: string }).sharedReviewId = reviewId;
  });

  test("privileged access and impersonation", async ({ page }) => {
    test.setTimeout(60_000);
    const reviewId = (fixture as unknown as { sharedReviewId: string }).sharedReviewId;
    const reviewUrl = `/entities/${fixture.reviewEntityTypeId}/records/${reviewId}`;

    // Ordinary people_data.view_all holder sees it normally.
    await signIn(page, fixture.privileged);
    const privilegedResponse = await page.goto(reviewUrl);
    expect(privilegedResponse?.status()).not.toBe(404);

    // The real admin (builder) also holds people_data.view_all -- but the
    // override must disappear while impersonating someone without access.
    await signIn(page, fixture.builder);
    const ownResponse = await page.goto(reviewUrl);
    expect(ownResponse?.status()).not.toBe(404);

    await impersonateFromSettings(page, fixture.coworker.email);
    const impersonatingCoworkerResponse = await page.goto(reviewUrl);
    expect(impersonatingCoworkerResponse?.status()).toBe(404);
    await exitImpersonation(page);

    // Impersonating the subject gives exactly subject visibility.
    await impersonateFromSettings(page, fixture.subject.email);
    const impersonatingSubjectResponse = await page.goto(reviewUrl);
    expect(impersonatingSubjectResponse?.status()).not.toBe(404);

    // Post-creation subject/reviewer reassignment is blocked while
    // impersonating, even though the real actor (builder) holds
    // people_data.view_all. A second client signed in AS the builder sees
    // the same active impersonation session (it's looked up server-side by
    // real_actor_user_id, not by which client/JWT calls) -- this is what a
    // genuinely-impersonating browser session is actually backed by.
    const builderClient = await authenticatedClient(fixture.builder);
    const reassignAttempt = await builderClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.reviewEntityTypeId,
      p_record_id: reviewId,
      p_values: {},
      p_relation_field_ids: [fixture.subjectFieldId],
      p_relations: [{ field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.reviewerPersonRecordId }],
    });
    expect(reassignAttempt.error).not.toBeNull();
    expect(reassignAttempt.error?.message).toMatch(/impersonat|privileg/i);
    await exitImpersonation(page);
  });

  test("leak prevention: list, search, Related, relation picker, discussion, and API", async ({ page }) => {
    test.setTimeout(60_000);
    const reviewId = (fixture as unknown as { sharedReviewId: string }).sharedReviewId;
    const admin = createSupabaseTestClient();
    const uniqueScoreValue = `Ultra-Unique-Score-${randomUUID()}`;
    await admin.from("entity_records").update({ values: { [fixture.scoreFieldKey]: uniqueScoreValue } }).eq("id", reviewId);

    await signIn(page, fixture.coworker);

    // Not in the entity's own table.
    await page.goto(`/entities/${fixture.reviewEntityTypeId}`);
    await expect(page.getByText(uniqueScoreValue)).toHaveCount(0);

    // Not in global search, including an exact-title query. The search
    // page's own header echoes the query text back ("0 results for
    // '<query>'"), so asserting the value's absence from the whole page
    // would trip on that echo, not a real leak -- the truthful proof is the
    // result count itself.
    await page.goto(`/search?q=${encodeURIComponent(uniqueScoreValue)}`);
    await expect(page.getByText("0 results")).toBeVisible();

    // The subject Person's own Related section never surfaces the hidden review.
    await page.goto(`/entities/${fixture.personEntityTypeId}/records/${fixture.subjectPersonRecordId}`);
    await expect(page.getByRole("heading", { name: "Related" })).toBeVisible();
    await expect(page.getByText(uniqueScoreValue)).toHaveCount(0);

    // An ordinary record's relation picker never lists the hidden review as choosable.
    await page.goto(`/entities/${fixture.ordinaryEntityTypeId}`);
    await page.locator("details#add-record summary").click();
    const relatedReviewSelect = page.getByLabel("Related Review");
    const optionLabels = await relatedReviewSelect.locator("option").allTextContents();
    expect(optionLabels.join(" ")).not.toContain(uniqueScoreValue);

    // Discussion/Request-for-Input on the hidden record is unreachable --
    // the whole record page 404s for this caller, so no discussion UI exists to leak.
    const response = await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${reviewId}`);
    expect(response?.status()).toBe(404);

    // Public API refuses the sensitive type -- real HTTP contract, not just the RPC.
    const rawKey = generateApiKey();
    const builderClientForKey = await authenticatedClient(fixture.builder);
    const { error: keyError } = await builderClientForKey.rpc("create_api_key_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_name: "E2E API refusal check",
      p_key_hash: hashApiKey(rawKey),
      p_key_preview: apiKeyPreview(rawKey),
    });
    // The RPC's own authorization is already covered by api-key-commit.test.ts;
    // this call only needs to obtain a real key for the HTTP call below.
    expect(keyError).toBeNull();

    const apiResponse = await page.request.get(`/api/v1/objects/${fixture.reviewEntityTypeId}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(apiResponse.status()).toBe(404);

    // The list-records route always returns 200 with an empty page for a
    // sensitive/nonexistent object (never a distinct error), per its own
    // documented contract.
    const recordsApiResponse = await page.request.get(`/api/v1/objects/${fixture.reviewEntityTypeId}/records`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(recordsApiResponse.status()).toBe(200);
    const body = await recordsApiResponse.json();
    expect(body.data).toEqual([]);
  });

  test("archival: existing access preserved, new record blocked, reassignment requires governance", async ({ page }) => {
    test.setTimeout(60_000);
    const reviewId = (fixture as unknown as { sharedReviewId: string }).sharedReviewId;
    const admin = createSupabaseTestClient();
    await admin.from("entity_records").update({ archived_at: new Date().toISOString() }).eq("id", fixture.subjectPersonRecordId);

    // Existing sensitive record remains visible per rules after Person archival.
    await signIn(page, fixture.subject);
    const stillVisible = await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${reviewId}`);
    expect(stillVisible?.status()).not.toBe(404);

    await signIn(page, fixture.manager);
    const managerStillVisible = await page.goto(`/entities/${fixture.reviewEntityTypeId}/records/${reviewId}`);
    expect(managerStillVisible?.status()).not.toBe(404);

    // A new review cannot target the now-archived Person through the real create form.
    await signIn(page, fixture.builder);
    await page.goto(`/entities/${fixture.reviewEntityTypeId}`);
    await page.locator("details#add-record summary").click();
    const subjectSelect = page.getByLabel("Reviewed Employee");
    const subjectOptionLabels = await subjectSelect.locator("option").allTextContents();
    expect(subjectOptionLabels).not.toContain("Subject Person");

    // Post-creation subject/reviewer reassignment on the existing (visible,
    // unarchived-record) review requires the governance boundary: an
    // ordinary visible-record editor (the subject, who can see it) may
    // still save an ordinary, relations-unchanged edit, but the real
    // people_data.view_all actor (not impersonating) is required to
    // actually change who the reviewer is.
    // A fresh, unarchived Person target for both attempts below -- the
    // subject Person is still archived at this point, and reassigning to
    // an archived target would fail on the ordinary, unrelated
    // active-target rule (0082) instead of proving the governance
    // boundary specifically.
    const newReviewerPersonId = await createRecordDirect(fixture.workspaceId, fixture.personEntityTypeId, { [fixture.personNameFieldKey]: "New Reviewer Person" });

    const subjectClient = await authenticatedClient(fixture.subject);
    const ordinaryEdit = await subjectClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.reviewEntityTypeId,
      p_record_id: reviewId,
      p_values: {},
      p_relation_field_ids: [],
      p_relations: [],
    });
    expect(ordinaryEdit.error).toBeNull();

    const deniedReassign = await subjectClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.reviewEntityTypeId,
      p_record_id: reviewId,
      p_values: {},
      p_relation_field_ids: [fixture.reviewerFieldId],
      p_relations: [{ field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: newReviewerPersonId }],
    });
    expect(deniedReassign.error).not.toBeNull();
    expect(deniedReassign.error?.message).toMatch(/privileg/i);

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const privilegedReassign = await privilegedClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.reviewEntityTypeId,
      p_record_id: reviewId,
      p_values: {},
      p_relation_field_ids: [fixture.reviewerFieldId],
      p_relations: [{ field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: newReviewerPersonId }],
    });
    expect(privilegedReassign.error).toBeNull();

    // Restore the archived Person for a clean teardown.
    await admin.from("entity_records").update({ archived_at: null }).eq("id", fixture.subjectPersonRecordId);
  });
});
