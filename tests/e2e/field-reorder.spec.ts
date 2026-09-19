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
  await expect(fieldRow(page, "Alpha").getByRole("button", { name: "Move Alpha up" })).toBeDisabled();
  await expect(
    fieldRow(page, "Charlie").getByRole("button", { name: "Move Charlie down" }),
  ).toBeDisabled();

  await fieldRow(page, "Alpha").getByRole("button", { name: "Move Alpha down" }).click();
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

test("compact Manage Fields row preserves rename, required, archive, and narrow layout", async ({
  page,
}) => {
  const run = createScenarioRun();
  const entity = await createReorderScenario(run);
  const admin = createSupabaseTestClient();

  await gotoEntity(page, entity, true);

  const bravoRow = fieldRow(page, "Bravo");
  await bravoRow.getByLabel("Name").fill("Bravo renamed");
  await bravoRow.getByLabel("Required").check();
  await bravoRow.getByRole("button", { name: "Save" }).click();
  await expectAfterMutation(page.getByText("Field updated."));

  const { data: updatedField, error } = await admin
    .from("field_definitions")
    .select("name, required")
    .eq("id", entity.fields.bravo.id)
    .single();
  if (error) throw new Error(error.message);
  expect(updatedField).toEqual({ name: "Bravo renamed", required: true });

  const renamedRow = fieldRow(page, "Bravo renamed");
  await expect(renamedRow.getByText("Text", { exact: true })).toBeVisible();
  await expect(renamedRow.getByRole("button", { name: "Move Bravo renamed up" })).toBeVisible();
  await expect(renamedRow.getByRole("button", { name: "Move Bravo renamed down" })).toBeVisible();

  await renamedRow.getByRole("button", { name: "Archive" }).click();
  await expect(page.locator('input[name="fieldName"][value="Bravo renamed"]')).toHaveCount(0);

  const { data: archivedField, error: archiveError } = await admin
    .from("field_definitions")
    .select("archived_at")
    .eq("id", entity.fields.bravo.id)
    .single();
  if (archiveError) throw new Error(archiveError.message);
  expect(archivedField?.archived_at).not.toBeNull();

  await page.setViewportSize({ width: 390, height: 800 });
  await gotoEntity(page, entity, true);
  const manageFieldsOverflow = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h2")).find(
      (candidate) => candidate.textContent?.trim() === "Manage Fields",
    );
    const section = heading?.closest("section");

    if (!section) {
      throw new Error("Manage Fields section not found.");
    }

    return section.scrollWidth > section.clientWidth;
  });
  expect(manageFieldsOverflow).toBe(false);
  await expect(fieldRow(page, "Alpha").getByRole("button", { name: "Move Alpha down" })).toBeVisible();
  await expect(fieldRow(page, "Charlie").getByRole("button", { name: "Archive" })).toBeVisible();
});
