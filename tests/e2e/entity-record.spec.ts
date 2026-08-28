import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createTestRun,
  createWorkflowFixture,
  type TestRun,
  type WorkflowFixture,
} from "./helpers/supabase-test-data";
import {
  addRecordSection,
  expectTableValue,
  fillRecordField,
  gotoEntity,
  rowForText,
  submitAddRecord,
} from "./helpers/ui";

test.describe.configure({ mode: "serial" });

let run: TestRun;
let fixture: WorkflowFixture;

test.beforeAll(async () => {
  run = createTestRun();
  await cleanupStaleE2eData();
  fixture = await createWorkflowFixture(run);
});

test.afterAll(async () => {
  await cleanupE2eRun(run);
});

test("navigates entities, validates, creates, and edits records", async ({
  page,
}) => {
  await gotoEntity(page, fixture.client);
  await gotoEntity(page, fixture.deliverable);
  await expect(
    page.getByRole("heading", {
      name: fixture.deliverable.name,
      exact: true,
    }),
  ).toBeVisible();
  await gotoEntity(page, fixture.client);
  await expect(
    page.getByRole("heading", { name: fixture.client.name, exact: true }),
  ).toBeVisible();

  const clientForm = addRecordSection(page, fixture.client);
  await fillRecordField(
    clientForm,
    fixture.client.fields.name,
    `${run.label} Bad Revenue`,
  );
  await fillRecordField(
    clientForm,
    fixture.client.fields.revenue,
    "not-a-number",
  );
  await submitAddRecord(page, fixture.client);

  await expect(
    page.getByText("Please fix the highlighted fields."),
  ).toBeVisible();
  await expect(
    clientForm.locator(`[name="${fixture.client.fields.name.key}"]`),
  ).toHaveValue(
    `${run.label} Bad Revenue`,
  );
  await expect(
    clientForm.locator(`[name="${fixture.client.fields.revenue.key}"]`),
  ).toHaveValue(
    "not-a-number",
  );

  await fillRecordField(clientForm, fixture.client.fields.revenue, "12345");
  await submitAddRecord(page, fixture.client);
  await expect(page.getByText(`${fixture.client.name} created.`)).toBeVisible();
  await expectTableValue(page, `${run.label} Bad Revenue`);

  await rowForText(page, `${run.label} Bad Revenue`)
    .getByRole("link", { name: "Edit" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `Edit ${fixture.client.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(`[name="${fixture.client.fields.name.key}"]`)
    .fill(`${run.label} Edited Client`);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expectTableValue(page, `${run.label} Edited Client`);
});
