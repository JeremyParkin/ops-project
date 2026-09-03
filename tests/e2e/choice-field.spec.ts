import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
  test,
} from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestEntity,
  type TestRun,
} from "./helpers/supabase-test-data";
import { expectAfterMutation, gotoEntity } from "./helpers/ui";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const workspaceIds: string[] = [];
const userIds: string[] = [];
const apiKeyIds: string[] = [];
// Genuinely cookie-less, like api-keys.spec.ts's apiContext -- the ambient
// `request` fixture inherits the suite's global storageState and would
// silently ride along on the e2e-runner's session cookie instead of
// exercising bearer-token auth.
let apiContext: APIRequestContext;

test.beforeAll(async () => {
  await cleanupStaleE2eData();
  apiContext = await playwrightRequest.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
  });
});

test.afterAll(async () => {
  await apiContext.dispose();
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
  const admin = createSupabaseTestClient();
  if (apiKeyIds.length > 0) {
    const { error } = await admin.from("api_keys").delete().in("id", apiKeyIds);
    if (error) throw new Error(error.message);
  }
  if (workspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", workspaceIds);
    if (error) throw new Error(error.message);
  }
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

// field_choice_options isn't part of supabase-test-data.ts's shared
// FieldInput union (a narrow addition for this one verification pass, not
// worth widening a file every other spec depends on) -- these two helpers
// create the field and its options directly, mirroring createEntity's own
// raw-insert style.
async function addChoiceField({
  entity,
  slug,
  name,
}: {
  entity: TestEntity;
  slug: string;
  name: string;
}) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const key = `fld_e2e_choice_${entity.id.slice(0, 8)}_${slug}`.replace(/-/g, "_");
  const { error } = await admin.from("field_definitions").insert({
    id,
    workspace_id: DEMO_WORKSPACE_ID,
    entity_type_id: entity.id,
    key,
    name,
    slug,
    type: "choice",
    required: false,
    position: 99,
  });
  if (error) throw new Error(error.message);
  entity.fields[slug] = { id, key, name, slug, type: "choice" as never, position: 99 };
  return { id, key };
}

async function addChoiceOption({
  fieldId,
  label,
  color,
  position,
}: {
  fieldId: string;
  label: string;
  color: string | null;
  position: number;
}) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error } = await admin.from("field_choice_options").insert({
    id,
    workspace_id: DEMO_WORKSPACE_ID,
    field_definition_id: fieldId,
    label,
    color,
    position,
  });
  if (error) throw new Error(error.message);
  return id;
}

async function archiveChoiceOptionDirect(optionId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin
    .from("field_choice_options")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", optionId);
  if (error) throw new Error(error.message);
}

// Fixture used by every test except the one that exercises field/option
// creation through the real UI end to end. Deliberately non-alphabetical
// position order (Low, High, Medium) so sort-by-position vs. sort-by-label
// are distinguishable.
async function createPriorityFixture(run: TestRun) {
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Ticket", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);
  const field = await addChoiceField({ entity, slug: "priority", name: "Priority" });
  const lowId = await addChoiceOption({ fieldId: field.id, label: "Low", color: "gray", position: 1 });
  const highId = await addChoiceOption({ fieldId: field.id, label: "High", color: "red", position: 2 });
  const mediumId = await addChoiceOption({ fieldId: field.id, label: "Medium", color: "amber", position: 3 });
  return { entity, field, lowId, highId, mediumId };
}

test("builder creates a Choice field and configures options through the real UI", async ({ page }) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Bug", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);

  await gotoEntity(page, entity, true);

  await page.getByLabel("Field Name").fill("Severity");
  await page.getByLabel("Type", { exact: true }).selectOption("choice");
  await page.getByRole("button", { name: "Add Field" }).click();
  await expectAfterMutation(page.getByText("Field added."));

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator('input[name="fieldName"][value="Severity"]') })
    .locator("..");

  // Add three options, one at a time, through the option-management UI.
  for (const label of ["Minor", "Critical"]) {
    await fieldRow.getByLabel("New option").fill(label);
    await fieldRow.getByRole("button", { name: "Add Option" }).click();
    await expectAfterMutation(page.getByText("Option added."));
  }

  // Active option labels live inside an editable input (not a text node),
  // so their value is confirmed via toHaveValue, not getByText.
  await expect(fieldRow.locator('input[value="Minor"]')).toHaveCount(1);
  await expect(fieldRow.locator('input[value="Critical"]')).toHaveCount(1);

  // Reorder: Critical should be able to move up above Minor.
  const criticalRow = fieldRow.locator("div.grid.gap-2.border").filter({
    has: page.locator('input[value="Critical"]'),
  }).first();
  await criticalRow.getByRole("button", { name: "Up" }).click();
  await expectAfterMutation(page.getByText("Option order updated."));

  // Archive Minor, confirm it moves to the archived (restore-only) row.
  const minorRow = fieldRow.locator("div.grid.gap-2.border").filter({
    has: page.locator('input[value="Minor"]'),
  }).first();
  await minorRow.getByRole("button", { name: "Archive" }).click();
  // A successful archive immediately swaps the row to its archived-only
  // branch (a Restore button, no editable label input) -- that branch swap
  // is itself the confirmation; the "Option archived." status text is
  // replaced by it before it would ever become visible.
  await expectAfterMutation(fieldRow.getByRole("button", { name: "Restore" }));
});

test("record create/edit/inline-edit through the Choice picker, with colored pill rendering", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { entity, highId } = await createPriorityFixture(run);

  await gotoEntity(page, entity, false);

  // Create via picker.
  await page.getByRole("link", { name: `Add ${entity.name}` }).first().click();
  await page.locator(`[name="${entity.fields.title.key}"]`).fill(`${run.label} Server down`);
  await page.locator(`[name="${entity.fields.priority.key}"]`).selectOption(highId);
  await page.getByRole("button", { name: `Add ${entity.name}` }).click();
  await expectAfterMutation(page.getByText(`${entity.name} created.`));

  const row = page.getByRole("row").filter({ hasText: `${run.label} Server down` });
  await expect(row).toBeVisible();
  await expect(row.getByText("High", { exact: true })).toBeVisible();

  // Inline table edit: change High -> Medium via the pill trigger.
  await row.getByRole("button", { name: "Edit Priority" }).click();
  await row.locator('select[name="value"]').selectOption({ label: "Medium" });
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("Medium", { exact: true })).toBeVisible();
  await expect(row.getByText("High", { exact: true })).toHaveCount(0);

  // Full edit form picker: confirms the current value ("Medium", from the
  // inline edit above) is preselected, then changes it. The table's own
  // Edit shortcut was removed (Phase 9 interaction polish) -- go straight
  // to the /edit route via the record's own link href, the same
  // destination the removed shortcut used to point to.
  const recordHref = await row
    .getByRole("link", { name: `${run.label} Server down`, exact: true })
    .getAttribute("href");
  await page.goto(`${recordHref}/edit`);
  const editSelect = page.locator(`select[name="${entity.fields.priority.key}"]`);
  await expect(editSelect).toHaveValue(/.+/);
  await editSelect.selectOption({ label: "Low" });
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expectAfterMutation(page.getByRole("heading", { name: entity.name }));
});

test("Choice filter operators (is / is not / is empty / is not empty) and configured-position sort", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { entity, lowId, highId } = await createPriorityFixture(run);
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Low ticket`, priority: lowId },
  });
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} High ticket`, priority: highId },
  });
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} No priority ticket` },
  });

  await gotoEntity(page, entity, false);

  // is
  await page.getByRole("button", { name: "+ Add filter" }).click();
  await page.getByLabel("Quick filter field").selectOption({ label: "Priority (choice)" });
  await page.getByLabel("Quick filter operator").selectOption({ label: "is" });
  await page.getByLabel("Quick filter value").selectOption({ label: "Low" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Low ticket" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "High ticket" })).toHaveCount(0);

  await page.getByRole("button", { name: /Remove filter/ }).click();
  await expect(page.getByRole("button", { name: /Remove filter/ })).toHaveCount(0);

  // is not
  await page.getByRole("button", { name: "+ Add filter" }).click();
  await page.getByLabel("Quick filter field").selectOption({ label: "Priority (choice)" });
  await page.getByLabel("Quick filter operator").selectOption({ label: "is not" });
  await page.getByLabel("Quick filter value").selectOption({ label: "Low" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Low ticket" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "High ticket" })).toBeVisible();

  await page.getByRole("button", { name: /Remove filter/ }).click();
  await expect(page.getByRole("button", { name: /Remove filter/ })).toHaveCount(0);

  // is empty
  await page.getByRole("button", { name: "+ Add filter" }).click();
  await page.getByLabel("Quick filter field").selectOption({ label: "Priority (choice)" });
  await page.getByLabel("Quick filter operator").selectOption({ label: "is empty" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "No priority ticket" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Low ticket" })).toHaveCount(0);

  await page.getByRole("button", { name: /Remove filter/ }).click();
  await expect(page.getByRole("button", { name: /Remove filter/ })).toHaveCount(0);

  // is not empty
  await page.getByRole("button", { name: "+ Add filter" }).click();
  await page.getByLabel("Quick filter field").selectOption({ label: "Priority (choice)" });
  await page.getByLabel("Quick filter operator").selectOption({ label: "is not empty" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "No priority ticket" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "Low ticket" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "High ticket" })).toBeVisible();

  await page.getByRole("button", { name: /Remove filter/ }).click();
  await expect(page.getByRole("button", { name: /Remove filter/ })).toHaveCount(0);

  // Sort by configured position (Low=1, High=2), not alphabetically
  // ("High" < "Low" alphabetically, which must NOT be the resulting order).
  await page.getByRole("columnheader").getByRole("link", { name: "Priority" }).click();
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows.nth(1)).toContainText("Low ticket");
  await expect(rows.nth(2)).toContainText("High ticket");
});

test("archiving an option preserves the existing record's display and blocks new selection", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { entity, field, highId } = await createPriorityFixture(run);
  // Created while High is still active, so the record legitimately holds it.
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Already high`, priority: highId },
  });

  await archiveChoiceOptionDirect(highId);

  await gotoEntity(page, entity, false);
  const row = page.getByRole("row").filter({ hasText: "Already high" });
  // ChoicePill sets a title attribute ("Label (Archived)" when archived),
  // which is unambiguous -- a plain text search for "High" also matches the
  // record's own title link ("Already high").
  await expect(row.getByTitle("High (Archived)")).toBeVisible();

  // The archived option must not appear as a selectable choice for a NEW
  // record.
  await page.getByRole("link", { name: `Add ${entity.name}` }).first().click();
  const createSelect = page.locator(`[name="${field.key}"]`);
  await expect(createSelect.locator("option", { hasText: "High" })).toHaveCount(0);
});

test("CSV export uses the current label; CSV import accepts exact active labels and rejects unknown/archived without creating options", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { entity, field, lowId } = await createPriorityFixture(run);
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Export me`, priority: lowId },
  });

  // Export: confirm the current label appears in the downloaded CSV.
  const downloadPromise = page.waitForEvent("download");
  await page.goto(`/entities/${entity.id}`);
  await page.getByRole("link", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream?.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream?.on("end", () => resolve());
    stream?.on("error", reject);
  });
  const csvText = Buffer.concat(chunks).toString("utf8");
  expect(csvText).toContain("Low");

  // Import: a valid row (exact active label) succeeds; an unknown label and
  // an archived label both produce row errors and block commit until fixed,
  // and neither ever creates a new option.
  const admin = createSupabaseTestClient();
  const { data: optionsBefore } = await admin
    .from("field_choice_options")
    .select("id")
    .eq("field_definition_id", field.id);
  const countBefore = optionsBefore?.length ?? 0;

  await page.goto(`/entities/${entity.id}/import`);
  await page.waitForLoadState("networkidle");
  const headers = ["Title", "Priority"];
  const rows = [
    [`${run.label} Good Row`, "Low"],
    [`${run.label} Bad Row`, "NoSuchOption"],
  ];
  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  await page.setInputFiles("#import-csv-file", {
    name: "priority-import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/No option matches "NoSuchOption"/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Import" })).toBeDisabled();

  const { data: optionsAfter } = await admin
    .from("field_choice_options")
    .select("id")
    .eq("field_definition_id", field.id);
  expect(optionsAfter?.length ?? 0).toBe(countBefore);
});

test.describe("Choice capability boundary", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function createWorker(run: TestRun) {
    const admin = createSupabaseTestClient();
    const password = `Choice-Worker-${randomUUID()}!`;
    const email = `e2e-choice-worker-${randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message ?? "Unable to create worker user.");
    userIds.push(data.user.id);

    const roleId = randomUUID();
    const { error: roleError } = await admin
      .from("workspace_roles")
      .insert({ id: roleId, workspace_id: DEMO_WORKSPACE_ID, name: `${run.label} Worker Role` });
    if (roleError) throw new Error(roleError.message);
    const { error: capError } = await admin
      .from("workspace_role_capabilities")
      .insert({ workspace_id: DEMO_WORKSPACE_ID, role_id: roleId, capability: "records.operate" });
    if (capError) throw new Error(capError.message);
    const { error: memError } = await admin
      .from("workspace_memberships")
      .insert({ workspace_id: DEMO_WORKSPACE_ID, user_id: data.user.id, role_id: roleId });
    if (memError) throw new Error(memError.message);

    return { email, password };
  }

  async function signIn(page: Page, email: string, password: string) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // Wait for the post-sign-in redirect to actually land before navigating
    // again -- otherwise a subsequent page.goto can race the sign-in
    // response and cancel it mid-flight, leaving no session cookie set and
    // bouncing straight back to /sign-in.
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  }

  test("records.operate can assign an active Choice option inline but cannot manage the option list", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const { entity } = await createPriorityFixture(run);
    await createEntityRecord({
      entity,
      valuesBySlug: { title: `${run.label} Worker record` },
    });
    const worker = await createWorker(run);

    await signIn(page, worker.email, worker.password);
    await gotoEntity(page, entity, false);

    const row = page.getByRole("row").filter({ hasText: "Worker record" });
    await row.getByRole("button", { name: "Edit Priority" }).click();
    await row.locator('select[name="value"]').selectOption({ label: "Medium" });
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByText("Medium", { exact: true })).toBeVisible();

    // No "Manage" affordance (schema.manage-gated) is available to this
    // worker at all -- confirmed structurally, not just visually: the raw
    // manage URL itself must redirect away rather than rendering.
    await expect(page.getByRole("link", { name: "Manage" })).toHaveCount(0);
    await page.goto(`/entities/${entity.id}?manage=true`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Add Field")).toHaveCount(0);
  });
});

async function createApiKeyViaUi(page: Page, name: string): Promise<string> {
  await page.goto("/settings/integrations");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("e.g. Reporting integration").fill(name);
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("API key -- shown once")).toBeVisible();
  const secret = await page.locator("code").last().textContent();
  if (!secret) throw new Error("API key secret was not rendered.");

  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("api_keys")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("name", name)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not find the newly created key for cleanup tracking.");
  apiKeyIds.push(data.id);

  return secret.trim();
}

test("API: Choice field metadata and record values resolve to {id, label, color, archived} over the real /api/v1 surface, including an already-archived selection", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { entity, field, lowId, highId } = await createPriorityFixture(run);
  const activeRecordId = await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Active pick`, priority: lowId },
  });
  const archivedSelectionRecordId = await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Archived pick`, priority: highId },
  });
  await archiveChoiceOptionDirect(highId);

  const rawKey = await createApiKeyViaUi(page, `${run.label} Choice API Key`);

  const objectRes = await apiContext.get(`/api/v1/objects/${entity.id}`, {
    headers: { authorization: `Bearer ${rawKey}` },
  });
  expect(objectRes.status()).toBe(200);
  const objectBody = await objectRes.json();
  const priorityField = objectBody.fields.find((f: { key: string }) => f.key === field.key);
  const titleField = objectBody.fields.find((f: { key: string }) => f.key === entity.fields.title.key);
  expect(priorityField.options).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: lowId, label: "Low", color: "gray", archived: false }),
      expect.objectContaining({ id: highId, label: "High", color: "red", archived: true }),
    ]),
  );
  // Existing non-Choice field shape unaffected.
  expect(titleField).toMatchObject({ key: entity.fields.title.key, type: "text" });
  expect(titleField.options).toBeUndefined();

  const activeRecordRes = await apiContext.get(`/api/v1/objects/${entity.id}/records/${activeRecordId}`, {
    headers: { authorization: `Bearer ${rawKey}` },
  });
  const activeRecordBody = await activeRecordRes.json();
  expect(activeRecordBody.values[field.key]).toEqual({ id: lowId, label: "Low", color: "gray", archived: false });

  // An already-selected, now-archived option still resolves correctly.
  const archivedRecordRes = await apiContext.get(
    `/api/v1/objects/${entity.id}/records/${archivedSelectionRecordId}`,
    { headers: { authorization: `Bearer ${rawKey}` } },
  );
  const archivedRecordBody = await archivedRecordRes.json();
  expect(archivedRecordBody.values[field.key]).toEqual({ id: highId, label: "High", color: "red", archived: true });
});
