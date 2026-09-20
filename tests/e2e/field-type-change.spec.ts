import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  type TestRun,
} from "./helpers/supabase-test-data";
import { gotoEntity } from "./helpers/ui";

// Focused coverage for safe pristine-only field-type recovery (migration
// 0141): the Manage Fields "Change type..." recovery affordance. Backend
// dependency-surface coverage (all nine categories, concurrency, workflow
// trigger regressions) lives in lib/domain/field-type-change-commit.test.ts;
// this file only verifies the real UI: truthful read-only Type by default,
// the preflight-gated picker for a pristine field, a truthful blocked
// explanation for a data-bearing field, and the Relation target picker.

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

test("Type is read-only metadata until Change type is invoked, and a pristine field can change type through the real UI", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Ticket", [
    { slug: "priority", name: "Priority", type: "text" },
  ]);

  await gotoEntity(page, entity, true);

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="Priority"]`) })
    .locator("..");

  // Read-only by default: the Type badge is plain text, not a control, and
  // there is no type picker visible before "Change type..." is invoked.
  await expect(fieldRow.getByText("Text", { exact: true })).toBeVisible();
  await expect(fieldRow.locator('select[name="newType"]')).toHaveCount(0);

  await fieldRow.getByRole("button", { name: "Change type…" }).click();
  const newTypeSelect = fieldRow.locator('select[name="newType"]');
  await expect(newTypeSelect).toBeVisible();

  await newTypeSelect.selectOption("number");
  page.once("dialog", (dialog) => dialog.accept());
  await fieldRow.getByRole("button", { name: "Confirm" }).click();

  await expect(fieldRow.getByText("Field type changed.")).toBeVisible();
  await expect(fieldRow.getByText("Number", { exact: true })).toBeVisible();
});

test("a data-bearing field shows a truthful blocking explanation and offers no type picker", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Note", [
    { slug: "body", name: "Body", type: "text" },
  ]);
  await createEntityRecord({ entity, valuesBySlug: { body: "Has a value" } });

  await gotoEntity(page, entity, true);

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="Body"]`) })
    .locator("..");

  await fieldRow.getByRole("button", { name: "Change type…" }).click();

  await expect(fieldRow.getByText(/record value/i)).toBeVisible();
  await expect(fieldRow.locator('select[name="newType"]')).toHaveCount(0);
});

test("changing a pristine field to Relation offers the same active-object target picker as Add Field", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const client = await createEntity(admin, run, "Client", []);
  const deal = await createEntity(admin, run, "Deal", [
    { slug: "owner", name: "Owner", type: "text" },
  ]);

  await gotoEntity(page, deal, true);

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="Owner"]`) })
    .locator("..");

  await fieldRow.getByRole("button", { name: "Change type…" }).click();
  await fieldRow.locator('select[name="newType"]').selectOption("relation");

  const relatedSelect = fieldRow.locator('select[name="newRelatedEntityTypeId"]');
  await expect(relatedSelect).toBeVisible();
  await expect(relatedSelect.getByRole("option", { name: client.name })).toHaveCount(1);
  await relatedSelect.selectOption({ label: client.name });

  page.once("dialog", (dialog) => dialog.accept());
  await fieldRow.getByRole("button", { name: "Confirm" }).click();

  await expect(fieldRow.getByText("Field type changed.")).toBeVisible();
  await expect(fieldRow.getByText("Relation", { exact: false })).toBeVisible();
});
