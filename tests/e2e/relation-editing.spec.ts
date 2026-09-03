import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestRun,
} from "./helpers/supabase-test-data";
import { gotoEntity } from "./helpers/ui";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const userIds: string[] = [];

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
  const admin = createSupabaseTestClient();
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function archiveRecordDirect(recordId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", recordId);
  if (error) throw new Error(error.message);
}

// Client (target) + Deal (source, optional relation to Client, plus a
// "Link" text field for linkification coverage).
async function createDealFixture(run: TestRun) {
  const admin = createSupabaseTestClient();
  const client = await createEntity(admin, run, "Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const deal = await createEntity(admin, run, "Deal", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "client", name: "Client", type: "relation", relatedEntityTypeId: client.id },
    { slug: "link", name: "Link", type: "text" },
  ]);
  return { client, deal };
}

test("inline relation editing: save persists a new active target, cancel discards a pending change", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client, deal } = await createDealFixture(run);
  const clientA = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} Acme` } });
  const clientB = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} Globex` } });
  await createEntityRecord({
    entity: deal,
    valuesBySlug: { title: `${run.label} Renewal` },
    relationsBySlug: { client: clientA },
  });

  await gotoEntity(page, deal, false);
  const row = page.getByRole("row").filter({ hasText: "Renewal" });
  await expect(row.getByText("Acme")).toBeVisible();

  // Cancel: open, change selection, cancel -- value must stay Acme.
  await row.getByRole("button", { name: "Edit Client" }).click();
  await row.locator('select[name="value"]').selectOption({ label: `${run.label} Globex` });
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row.getByText("Acme")).toBeVisible();
  await expect(row.locator('select[name="value"]')).toHaveCount(0);

  // Save: open, change selection, save -- value must become Globex.
  await row.getByRole("button", { name: "Edit Client" }).click();
  await row.locator('select[name="value"]').selectOption({ label: `${run.label} Globex` });
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("Globex")).toBeVisible();
  await expect(row.getByText("Acme")).toHaveCount(0);
  void clientB;
});

test("clears an optional relation via inline edit", async ({ page }) => {
  const run = createScenarioRun();
  const { client, deal } = await createDealFixture(run);
  const clientA = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} Initech` } });
  await createEntityRecord({
    entity: deal,
    valuesBySlug: { title: `${run.label} Clearable` },
    relationsBySlug: { client: clientA },
  });

  await gotoEntity(page, deal, false);
  const row = page.getByRole("row").filter({ hasText: "Clearable" });
  await row.getByRole("button", { name: "Edit Client" }).click();
  await row.locator('select[name="value"]').selectOption({ value: "" });
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("Initech")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Edit Client" })).toBeVisible();
});

test("rejects clearing a required relation via inline edit", async ({ page }) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const client = await createEntity(admin, run, "Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const order = await createEntity(admin, run, "Order", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "client", name: "Client", type: "relation", required: true, relatedEntityTypeId: client.id },
  ]);
  const clientA = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} RequiredCo` } });
  await createEntityRecord({
    entity: order,
    valuesBySlug: { title: `${run.label} Required Order` },
    relationsBySlug: { client: clientA },
  });

  await gotoEntity(page, order, false);
  const row = page.getByRole("row").filter({ hasText: "Required Order" });
  await row.getByRole("button", { name: "Edit Client" }).click();
  await row.locator('select[name="value"]').selectOption({ value: "" });
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText(/is required/i)).toBeVisible();
  // Still in edit mode with the field still showing RequiredCo bound as the
  // current value (rejection did not clear it).
  await expect(row.locator('select[name="value"]')).toHaveValue(clientA);
});

test("keeps an archived current target visible on its own row, but unavailable to a different row's new assignment", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client, deal } = await createDealFixture(run);
  const archivedTarget = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} SoonArchived` },
  });
  const activeTarget = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} StillActive` },
  });
  await createEntityRecord({
    entity: deal,
    valuesBySlug: { title: `${run.label} HoldsArchived` },
    relationsBySlug: { client: archivedTarget },
  });
  await createEntityRecord({
    entity: deal,
    valuesBySlug: { title: `${run.label} HoldsActive` },
    relationsBySlug: { client: activeTarget },
  });
  await archiveRecordDirect(archivedTarget);

  await gotoEntity(page, deal, false);

  // Row that already references the archived target: its own value stays
  // visible/selected in the dropdown.
  const archivedRow = page.getByRole("row").filter({ hasText: "HoldsArchived" });
  await expect(archivedRow.getByText(/SoonArchived/)).toBeVisible();
  await archivedRow.getByRole("button", { name: "Edit Client" }).click();
  const archivedRowSelect = archivedRow.locator('select[name="value"]');
  await expect(archivedRowSelect.locator("option", { hasText: "SoonArchived" })).toHaveCount(1);
  await expect(archivedRowSelect).toHaveValue(archivedTarget);
  await archivedRow.getByRole("button", { name: "Cancel" }).click();

  // A different row, which never referenced the archived target, must not
  // be able to newly assign it.
  const activeRow = page.getByRole("row").filter({ hasText: "HoldsActive" });
  await activeRow.getByRole("button", { name: "Edit Client" }).click();
  const activeRowSelect = activeRow.locator('select[name="value"]');
  await expect(activeRowSelect.locator("option", { hasText: "SoonArchived" })).toHaveCount(0);
  await expect(activeRowSelect.locator("option", { hasText: "StillActive" })).toHaveCount(1);
});

test("table relation pill opens inline edit rather than navigating", async ({ page }) => {
  const run = createScenarioRun();
  const { client, deal } = await createDealFixture(run);
  const clientA = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} PillTarget` } });
  await createEntityRecord({
    entity: deal,
    valuesBySlug: { title: `${run.label} PillRow` },
    relationsBySlug: { client: clientA },
  });

  await gotoEntity(page, deal, false);
  const urlBeforeClick = page.url();
  const row = page.getByRole("row").filter({ hasText: "PillRow" });
  await row.getByRole("button", { name: "Edit Client" }).click();
  expect(page.url()).toBe(urlBeforeClick);
  await expect(row.locator('select[name="value"]')).toBeVisible();
});

test("record-detail relation pill still navigates to the related record", async ({ page }) => {
  const run = createScenarioRun();
  const { client, deal } = await createDealFixture(run);
  const clientA = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} DetailTarget` } });
  const dealRecordId = await createEntityRecord({
    entity: deal,
    valuesBySlug: { title: `${run.label} DetailDeal` },
    relationsBySlug: { client: clientA },
  });

  await page.goto(`/entities/${deal.id}/records/${dealRecordId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: /DetailTarget/ }).click();
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(new RegExp(`/entities/${client.id}/records/${clientA}$`));
});

test.describe("relation edit capability boundary", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function createMember(run: TestRun, capabilities: string[]) {
    const admin = createSupabaseTestClient();
    const password = `Relation-Member-${randomUUID()}!`;
    const email = `e2e-relation-member-${randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message ?? "Unable to create member user.");
    userIds.push(data.user.id);

    const roleId = randomUUID();
    const { error: roleError } = await admin
      .from("workspace_roles")
      .insert({ id: roleId, workspace_id: DEMO_WORKSPACE_ID, name: `${run.label} Member Role ${randomUUID().slice(0, 8)}` });
    if (roleError) throw new Error(roleError.message);
    if (capabilities.length > 0) {
      const { error: capError } = await admin
        .from("workspace_role_capabilities")
        .insert(capabilities.map((capability) => ({ workspace_id: DEMO_WORKSPACE_ID, role_id: roleId, capability })));
      if (capError) throw new Error(capError.message);
    }
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
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  }

  test("records.operate worker can edit a relation inline", async ({ page }) => {
    const run = createScenarioRun();
    const { client, deal } = await createDealFixture(run);
    const clientA = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} WorkerAlpha` } });
    const clientB = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} WorkerBeta` } });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} WorkerDeal` },
      relationsBySlug: { client: clientA },
    });
    const worker = await createMember(run, ["records.operate"]);

    await signIn(page, worker.email, worker.password);
    await gotoEntity(page, deal, false);
    const row = page.getByRole("row").filter({ hasText: "WorkerDeal" });
    await row.getByRole("button", { name: "Edit Client" }).click();
    await row.locator('select[name="value"]').selectOption({ label: `${run.label} WorkerBeta` });
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByText("WorkerBeta")).toBeVisible();
    void clientB;
  });

  test("a viewer without records.operate cannot edit a relation inline", async ({ page }) => {
    const run = createScenarioRun();
    const { client, deal } = await createDealFixture(run);
    const clientA = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} ViewerAlpha` } });
    const clientB = await createEntityRecord({ entity: client, valuesBySlug: { name: `${run.label} ViewerBeta` } });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} ViewerDeal` },
      relationsBySlug: { client: clientA },
    });
    const viewer = await createMember(run, []);

    await signIn(page, viewer.email, viewer.password);
    await gotoEntity(page, deal, false);
    const row = page.getByRole("row").filter({ hasText: "ViewerDeal" });
    await row.getByRole("button", { name: "Edit Client" }).click();
    await row.locator('select[name="value"]').selectOption({ label: `${run.label} ViewerBeta` });
    await row.getByRole("button", { name: "Save" }).click();
    // Server-side rejection surfaces as an error (EditableCellForm renders
    // it with role="alert"); the value must not actually change.
    await expect(row.getByRole("alert")).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloadedRow = page.getByRole("row").filter({ hasText: "ViewerDeal" });
    await expect(reloadedRow.getByText("ViewerAlpha")).toBeVisible();
    await expect(reloadedRow.getByText("ViewerBeta")).toHaveCount(0);
    void clientB;
  });
});

test.describe("link-aware text cells", () => {
  test("renders absolute http and https URLs as clickable links, but plain-text malformed/unsafe values", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const { deal } = await createDealFixture(run);
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} HttpLink`, link: "http://example.com/path" },
    });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} HttpsLink`, link: "https://example.com/secure" },
    });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} EmailLink`, link: "person@example.com" },
    });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} JsUri`, link: "javascript:alert(1)" },
    });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} DataUri`, link: "data:text/html,hi" },
    });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} FtpUri`, link: "ftp://example.com/file" },
    });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} BareDomain`, link: "example.com" },
    });
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} Malformed`, link: "not a url at all" },
    });

    await gotoEntity(page, deal, false);

    const httpRow = page.getByRole("row").filter({ hasText: "HttpLink" });
    const httpLink = httpRow.getByRole("link", { name: "http://example.com/path" });
    await expect(httpLink).toBeVisible();
    await expect(httpLink).toHaveAttribute("href", "http://example.com/path");
    await expect(httpLink).toHaveAttribute("target", "_blank");
    await expect(httpLink).toHaveAttribute("rel", "noopener noreferrer");

    const httpsRow = page.getByRole("row").filter({ hasText: "HttpsLink" });
    const httpsLink = httpsRow.getByRole("link", { name: "https://example.com/secure" });
    await expect(httpsLink).toHaveAttribute("href", "https://example.com/secure");
    await expect(httpsLink).toHaveAttribute("target", "_blank");

    const emailRow = page.getByRole("row").filter({ hasText: "EmailLink" });
    const emailLink = emailRow.getByRole("link", { name: "person@example.com" });
    await expect(emailLink).toHaveAttribute("href", "mailto:person@example.com");
    // Email links must never open a new tab.
    await expect(emailLink).not.toHaveAttribute("target", "_blank");

    for (const [rowText, rawValue] of [
      ["JsUri", "javascript:alert(1)"],
      ["DataUri", "data:text/html,hi"],
      ["FtpUri", "ftp://example.com/file"],
      ["BareDomain", "example.com"],
      ["Malformed", "not a url at all"],
    ] as const) {
      const row = page.getByRole("row").filter({ hasText: rowText });
      await expect(row.getByRole("link", { name: rawValue })).toHaveCount(0);
      await expect(row.getByText(rawValue, { exact: true })).toBeVisible();
    }
  });

  test("a linkified cell has a separate visible Edit affordance, and clicking the link does not enter edit mode", async ({
    page,
    context,
  }) => {
    const run = createScenarioRun();
    const { deal } = await createDealFixture(run);
    await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: `${run.label} ClickLink`, link: "https://example.com/click-test" },
    });

    await gotoEntity(page, deal, false);
    const row = page.getByRole("row").filter({ hasText: "ClickLink" });
    const link = row.getByRole("link", { name: "https://example.com/click-test" });
    const editButton = row.getByRole("button", { name: "Edit Link" });
    await expect(link).toBeVisible();
    await expect(editButton).toBeVisible();

    const popupPromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
    await link.click();
    const popup = await popupPromise;
    if (popup) {
      await popup.close();
    }
    // The click must have gone to the link, not to the edit trigger -- no
    // select/textarea/Save/Cancel form appeared on the original row.
    await expect(
      row.locator('select[name="value"], input[name="value"], textarea[name="value"]'),
    ).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Save" })).toHaveCount(0);

    // The separate Edit affordance still works normally -- Link is a text
    // field, so this opens the larger multiline editor (a <textarea>), not
    // a single-line <input>.
    await editButton.click();
    await expect(row.locator('textarea[name="value"]')).toBeVisible();
    await row.getByRole("button", { name: "Cancel" }).click();
  });

  test("identity-field linkification remains disabled -- the identity column always navigates to the record", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const admin = createSupabaseTestClient();
    // Title (the identity field for this object) is deliberately given a
    // URL-shaped value, to prove the identity column never linkifies it.
    const deal = await createEntity(admin, run, "IdentityDeal", [
      { slug: "title", name: "Title", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({
      entity: deal,
      valuesBySlug: { title: "https://example.com/should-not-linkify" },
    });

    await gotoEntity(page, deal, false);
    const row = page.getByRole("row").filter({ hasText: "https://example.com/should-not-linkify" });
    // The identity cell's own link (accessible name = the full URL-shaped
    // title text) must be the record-detail navigation link, not an
    // external target="_blank" link to the URL text itself. The row also
    // carries an unrelated "Edit" action link, which this scoped lookup by
    // name deliberately excludes.
    const identityLink = row.getByRole("link", { name: "https://example.com/should-not-linkify" });
    await expect(identityLink).toHaveCount(1);
    await expect(identityLink).not.toHaveAttribute("target", "_blank");
    await expect(identityLink).toHaveAttribute("href", `/entities/${deal.id}/records/${recordId}`);
  });
});
