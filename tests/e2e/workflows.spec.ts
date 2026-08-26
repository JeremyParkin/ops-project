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
  submitAddRecord,
  selectReactOption,
  workflowConstantValue,
  workflowMappingType,
  workflowSourceField,
  waitForWorkflowFormReady,
} from "./helpers/ui";

test.describe.configure({ mode: "serial" });

let run: TestRun;
let fixture: WorkflowFixture;
let workflowName: string;

test.beforeAll(async () => {
  run = createTestRun();
  workflowName = `${run.label} Deliverable to Task`;
  await cleanupStaleE2eData();
  fixture = await createWorkflowFixture(run);
});

test.afterAll(async () => {
  await cleanupE2eRun(run);
});

test("creates, edits, toggles, executes, and logs a workflow", async ({ page }) => {
  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Workflow Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger Entity"), {
    value: fixture.deliverable.id,
  });
  await expect(
    page.getByText(`This workflow runs for every new ${fixture.deliverable.name}.`),
  ).toBeVisible();
  await selectReactOption(page.getByLabel("Then Create Record In"), {
    value: fixture.task.id,
  });
  await expect(workflowMappingType(page, fixture.task.fields.title)).toBeVisible();

  await selectReactOption(workflowMappingType(page, fixture.task.fields.title), {
    value: "source_field",
  });
  await selectReactOption(workflowSourceField(page, fixture.task.fields.title), {
    value: fixture.deliverable.fields.name.id,
  });
  await selectReactOption(workflowMappingType(page, fixture.task.fields.client), {
    value: "source_field",
  });
  await selectReactOption(workflowSourceField(page, fixture.task.fields.client), {
    value: fixture.deliverable.fields.client.id,
  });
  await selectReactOption(workflowMappingType(page, fixture.task.fields.status), {
    value: "constant",
  });
  await workflowConstantValue(page, fixture.task.fields.status).fill("Open");
  await page.getByRole("button", { name: "Create Workflow" }).click();

  await expect(page).toHaveURL(/\/workflows$/);
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();

  await page.getByRole("link", { name: workflowName }).click();
  await page.getByLabel("Workflow Name").fill(`${workflowName} Edited`);
  await page.getByRole("button", { name: "Save Workflow" }).click();
  workflowName = `${workflowName} Edited`;
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();

  const workflowRow = page.getByRole("row").filter({ hasText: workflowName });
  await workflowRow.getByRole("button", { name: "Disable" }).click();
  await expect(workflowRow).toContainText("Disabled", { timeout: 15_000 });
  await workflowRow.getByRole("button", { name: "Enable" }).click();
  await expect(workflowRow).toContainText("Enabled");

  await gotoEntity(page, fixture.deliverable);
  const deliverableName = `${run.label} Launch`;
  const form = addRecordSection(page, fixture.deliverable);
  await fillRecordField(form, fixture.deliverable.fields.name, deliverableName);
  await chooseRecordField(form, fixture.deliverable.fields.client, `${run.label} Acme`);
  await submitAddRecord(page, fixture.deliverable);
  await expect(page.getByText(/1 workflow succeeded/)).toBeVisible();

  await gotoEntity(page, fixture.task);
  await expectTableValue(page, deliverableName);
  const generatedTaskRow = page.getByRole("table").getByRole("row").filter({
    hasText: deliverableName,
  });
  await expect(generatedTaskRow).toContainText(`${run.label} Acme`);
  await expect(generatedTaskRow).toContainText("Open");

  await page.goto("/workflows");
  const finalWorkflowRow = page.getByRole("row").filter({
    has: page.getByRole("link", { name: workflowName }),
  });
  await expect(finalWorkflowRow).toContainText("Enabled");
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: workflowName })
      .filter({ hasText: "succeeded" }),
  ).toBeVisible();
});
