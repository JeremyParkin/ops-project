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
import { gotoEntity, rowForText } from "./helpers/ui";

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

async function createFixture(run: TestRun, recordTitles: string[]) {
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Bulk Item", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);
  const recordIds: string[] = [];
  for (const title of recordTitles) {
    const id = await createEntityRecord({ entity, valuesBySlug: { title: `${run.label} ${title}` } });
    recordIds.push(id);
  }
  return { entity, recordIds };
}

function rowCheckbox(page: Page, text: string) {
  return rowForText(page, text).getByRole("checkbox");
}

test("selecting rows shows the bulk bar with an accurate count, and Clear selection empties it", async ({ page }) => {
  const run = createScenarioRun();
  const { entity } = await createFixture(run, ["Alpha", "Beta", "Gamma"]);

  await gotoEntity(page, entity, false);
  await expect(page.getByText(/selected$/)).toHaveCount(0);

  await rowCheckbox(page, "Alpha").check();
  await rowCheckbox(page, "Beta").check();
  await expect(page.getByText("2 of 3 selected")).toBeVisible();

  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(page.getByText(/selected$/)).toHaveCount(0);
});

test("the header checkbox selects/deselects every rendered row and reflects partial selection", async ({ page }) => {
  const run = createScenarioRun();
  const { entity } = await createFixture(run, ["Alpha", "Beta", "Gamma"]);

  await gotoEntity(page, entity, false);
  const headerCheckbox = page.getByRole("checkbox", { name: /^Select all 3 records shown$/ });
  await expect(headerCheckbox).toBeVisible();

  await headerCheckbox.click();
  await expect(page.getByText("3 of 3 selected")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^Deselect all 3 records shown$/ })).toBeVisible();

  await rowCheckbox(page, "Alpha").uncheck();
  await expect(page.getByText("2 of 3 selected")).toBeVisible();
  const partialHeaderCheckbox = page.getByRole("checkbox", { name: /^Select all 3 records shown$/ });
  await expect(partialHeaderCheckbox).not.toBeChecked();
});

test("bulk archive removes the selected rows from the default view and requires confirmation", async ({ page }) => {
  const run = createScenarioRun();
  const { entity } = await createFixture(run, ["Alpha", "Beta", "Gamma"]);

  await gotoEntity(page, entity, false);
  await rowCheckbox(page, "Alpha").check();
  await rowCheckbox(page, "Beta").check();

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Archive selected" }).click();
  // Dismissed: nothing archived yet.
  await expect(rowForText(page, "Alpha")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Archive selected" }).click();
  await expect(page.getByText("2 records archived.")).toBeVisible();
  await expect(rowForText(page, "Alpha")).toHaveCount(0);
  await expect(rowForText(page, "Beta")).toHaveCount(0);
  await expect(rowForText(page, "Gamma")).toBeVisible();
  // Selection is cleared after a successful action.
  await expect(page.getByText(/selected$/)).toHaveCount(0);
});

test("bulk restore re-exposes archived rows while Show archived records is on", async ({ page }) => {
  const run = createScenarioRun();
  const { entity, recordIds } = await createFixture(run, ["Alpha", "Beta", "Gamma"]);
  await archiveRecordDirect(recordIds[0]);
  await archiveRecordDirect(recordIds[1]);

  await page.goto(`/entities/${entity.id}?showArchived=true`);
  await page.waitForLoadState("networkidle");
  await rowCheckbox(page, "Alpha").check();
  await rowCheckbox(page, "Beta").check();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Restore selected" }).click();
  await expect(page.getByText("2 records restored.")).toBeVisible();

  await page.goto(`/entities/${entity.id}`);
  await page.waitForLoadState("networkidle");
  await expect(rowForText(page, "Alpha")).toBeVisible();
  await expect(rowForText(page, "Beta")).toBeVisible();
});

test("Restore selected is not offered when no rendered row is archived", async ({ page }) => {
  const run = createScenarioRun();
  const { entity } = await createFixture(run, ["Alpha", "Beta"]);

  await gotoEntity(page, entity, false);
  await rowCheckbox(page, "Alpha").check();
  await expect(page.getByRole("button", { name: "Archive selected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore selected" })).toHaveCount(0);
});

test("selection resets after a filter/sort navigation", async ({ page }) => {
  const run = createScenarioRun();
  const { entity } = await createFixture(run, ["Alpha", "Beta", "Gamma"]);

  await gotoEntity(page, entity, false);
  await rowCheckbox(page, "Alpha").check();
  await expect(page.getByText("1 of 3 selected")).toBeVisible();

  await page.getByRole("columnheader").getByRole("link", { name: "Title" }).click();
  // Not waitForLoadState("networkidle"): a Next.js App Router client-side
  // Link navigation updates the URL/content as the last step of its own
  // background RSC fetch, which can still be in flight after Playwright
  // already considers the network idle -- confirmed directly (a
  // `framenavigated` listener fired with the sorted URL well after both an
  // immediate post-click check and a settled networkidle wait already saw
  // the stale, unsorted URL). Waiting on the header's own aria-sort
  // instead waits for the actual, semantically-meaningful effect of the
  // click -- the column is now genuinely sorted -- rather than a proxy for
  // it that this app's real navigation pattern doesn't reliably satisfy.
  await expect(page.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(page.getByText(/selected$/)).toHaveCount(0);
});

test("a bulk archive rejected mid-flight (a selected record is deleted first) changes nothing", async ({ page }) => {
  const run = createScenarioRun();
  const { entity, recordIds } = await createFixture(run, ["Alpha", "Beta", "Gamma"]);

  await gotoEntity(page, entity, false);
  await rowCheckbox(page, "Alpha").check();
  await rowCheckbox(page, "Beta").check();

  // Simulate a race: the selected "Beta" record is deleted by someone else
  // between selecting it and submitting (archiving an already-archived
  // record is idempotent under this RPC, not a rejection -- only a record
  // that's genuinely gone triggers the atomicity check). The bulk action
  // must reject the whole batch and leave "Alpha" untouched too.
  const admin = createSupabaseTestClient();
  const { error: deleteError } = await admin.from("entity_records").delete().eq("id", recordIds[1]);
  if (deleteError) throw new Error(deleteError.message);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Archive selected" }).click();
  await expect(page.getByText(/could not be found/i)).toBeVisible();

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(rowForText(page, "Alpha")).toBeVisible();
});

test.describe("bulk action capability boundary", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function createMember(run: TestRun, capabilities: string[]) {
    const admin = createSupabaseTestClient();
    const password = `Bulk-Member-${randomUUID()}!`;
    const email = `e2e-bulk-member-${randomUUID()}@example.test`;
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

  test("records.operate worker can bulk-archive", async ({ page }) => {
    const run = createScenarioRun();
    const { entity } = await createFixture(run, ["Alpha", "Beta"]);
    const worker = await createMember(run, ["records.operate"]);

    await signIn(page, worker.email, worker.password);
    await gotoEntity(page, entity, false);
    await rowCheckbox(page, "Alpha").check();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Archive selected" }).click();
    await expect(page.getByText("1 record archived.")).toBeVisible();
  });

  test("a viewer without records.operate cannot bulk-archive", async ({ page }) => {
    const run = createScenarioRun();
    const { entity, recordIds } = await createFixture(run, ["Alpha", "Beta"]);
    const viewer = await createMember(run, []);

    await signIn(page, viewer.email, viewer.password);
    await gotoEntity(page, entity, false);
    await rowCheckbox(page, "Alpha").check();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Archive selected" }).click();
    await expect(page.getByText(/permission denied/i)).toBeVisible();

    const admin = createSupabaseTestClient();
    const { data } = await admin.from("entity_records").select("archived_at").eq("id", recordIds[0]).single();
    expect(data?.archived_at).toBeNull();
  });
});
