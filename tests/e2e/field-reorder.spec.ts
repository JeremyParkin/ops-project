import { expect, type Page, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  type TestRun,
} from "./helpers/supabase-test-data";
import { expectAfterMutation, gotoEntity } from "./helpers/ui";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);

  return run;
}

async function createReorderScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();

  return createEntity(supabase, run, "Reorder Widget", [
    { slug: "alpha", name: "Alpha", type: "text" },
    { slug: "bravo", name: "Bravo", type: "text" },
    { slug: "charlie", name: "Charlie", type: "text" },
  ]);
}

function fieldRow(page: Page, fieldName: string) {
  return page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="${fieldName}"]`) })
    .locator("..");
}

test("Move up/down reorders fields, persists, and updates the records table column order", async ({
  page,
}) => {
  const run = createScenarioRun();
  const entity = await createReorderScenario(run);
  await createEntityRecord({
    entity,
    valuesBySlug: { alpha: "A", bravo: "B", charlie: "C" },
  });

  await gotoEntity(page, entity, true);

  // First field can't move up; last field can't move down.
  await expect(fieldRow(page, "Alpha").getByRole("button", { name: "Move Up" })).toBeDisabled();
  await expect(
    fieldRow(page, "Charlie").getByRole("button", { name: "Move Down" }),
  ).toBeDisabled();

  await fieldRow(page, "Alpha").getByRole("button", { name: "Move Down" }).click();
  await expectAfterMutation(page.getByText("Field order updated."));

  const nameInputs = page.locator('input[id^="field-edit-name-"]');

  async function nameOrder() {
    return nameInputs.evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value),
    );
  }

  await expect(async () => {
    expect(await nameOrder()).toEqual(["Bravo", "Alpha", "Charlie"]);
  }).toPass();

  await page.reload();
  expect(await nameOrder()).toEqual(["Bravo", "Alpha", "Charlie"]);

  // Field position also drives the plain records table's column order.
  // Exclude the leading bulk-select checkbox header (Phase 9.5) -- it's not
  // a field column, and its presence would otherwise shift every index by 1.
  await gotoEntity(page, entity, false);
  const headers = page.locator("thead th").filter({ hasNot: page.locator("input") });
  // toContainText, not toHaveText: sortable headers also carry an sr-only
  // ", click to sort"/", sorted ..." suffix for accessible sort state.
  await expect(headers.nth(0)).toContainText("Bravo");
  await expect(headers.nth(1)).toContainText("Alpha");
  await expect(headers.nth(2)).toContainText("Charlie");
});
