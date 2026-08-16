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
  chooseRecordField,
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

test("selects a related record and displays its label", async ({ page }) => {
  await gotoEntity(page, fixture.deliverable);

  const form = addRecordSection(page, fixture.deliverable);
  await fillRecordField(form, fixture.deliverable.fields.name, `${run.label} Website`);
  await chooseRecordField(form, fixture.deliverable.fields.client, `${run.label} Acme`);
  await submitAddRecord(page, fixture.deliverable);

  await expect(page.getByText(`${fixture.deliverable.name} created.`)).toBeVisible();
  await expectTableValue(page, `${run.label} Website`);
  await expect(rowForText(page, `${run.label} Website`)).toContainText(
    `${run.label} Acme`,
  );
});
