import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createRecordUpdatedFixture,
  createTestRun,
  type RecordUpdatedFixture,
  type TestRun,
} from "./helpers/supabase-test-data";
import {
  addRecordSection,
  expectTableValue,
  fillRecordField,
  gotoEntity,
  rowForText,
  selectReactOption,
  submitAddRecord,
  workflowMappingType,
  workflowSourceField,
  waitForWorkflowFormReady,
} from "./helpers/ui";

test.describe.configure({ mode: "serial" });

let run: TestRun;
let fixture: RecordUpdatedFixture;
let workflowName: string;

test.beforeAll(async () => {
  run = createTestRun();
  workflowName = `${run.label} Ticket update to Activity`;
  await cleanupStaleE2eData();
  fixture = await createRecordUpdatedFixture(run);
});

test.afterAll(async () => {
  await cleanupE2eRun(run);
});

async function createRecordUpdatedWorkflow(page: import("@playwright/test").Page) {
  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Workflow Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
    value: "record_updated",
  });
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.ticket.id,
  });
  await selectReactOption(page.getByLabel("Then Create Record In"), {
    value: fixture.activity.id,
  });
  await expect(workflowMappingType(page, fixture.activity.fields.summary)).toBeVisible();
  await page
    .locator(
      `input[name="watchedFieldDefinitionId"][value="${fixture.ticket.fields.status.id}"]`,
    )
    .check();

  await selectReactOption(workflowMappingType(page, fixture.activity.fields.summary), {
    value: "source_field",
  });
  await selectReactOption(workflowSourceField(page, fixture.activity.fields.summary), {
    value: fixture.ticket.fields.title.id,
  });
  await selectReactOption(workflowMappingType(page, fixture.activity.fields.status), {
    value: "source_field",
  });
  await selectReactOption(workflowSourceField(page, fixture.activity.fields.status), {
    value: fixture.ticket.fields.status.id,
  });
  await page.getByRole("button", { name: "Create Workflow" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();
}

async function createTicket(page: import("@playwright/test").Page, title: string) {
  await gotoEntity(page, fixture.ticket);
  const form = addRecordSection(page, fixture.ticket);
  await fillRecordField(form, fixture.ticket.fields.title, title);
  await fillRecordField(form, fixture.ticket.fields.status, "Open");
  await fillRecordField(form, fixture.ticket.fields.notes, "Initial");
  await submitAddRecord(page, fixture.ticket);
  await expect(page.getByText(`${fixture.ticket.name} created.`)).toBeVisible();
}

async function editTicket(
  page: import("@playwright/test").Page,
  title: string,
  changes: { status?: string; notes?: string },
) {
  await gotoEntity(page, fixture.ticket);
  await rowForText(page, title).getByRole("link", { name: "Edit" }).click();
  await expect(
    page.getByRole("heading", {
      name: `Edit ${fixture.ticket.name}`,
      exact: true,
    }),
  ).toBeVisible();

  if (changes.status !== undefined) {
    await page
      .locator(`[name="${fixture.ticket.fields.status.key}"]`)
      .fill(changes.status);
  }

  if (changes.notes !== undefined) {
    await page
      .locator(`[name="${fixture.ticket.fields.notes.key}"]`)
      .fill(changes.notes);
  }

  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(
    page.getByRole("heading", { name: fixture.ticket.name, exact: true }),
  ).toBeVisible();
}

test("runs on watched field changes and skips unrelated or no-op edits", async ({
  page,
}) => {
  await createRecordUpdatedWorkflow(page);

  const title = `${run.label} Login bug`;
  await createTicket(page, title);

  await editTicket(page, title, { status: "Closed" });
  await expect(rowForText(page, title)).toContainText("Closed");
  await gotoEntity(page, fixture.activity);
  await expectTableValue(page, title);
  await expect(page.getByText("Closed")).toBeVisible();

  await editTicket(page, title, { notes: "Unrelated update" });
  await page.goto("/workflows");
  const skippedLogRows = page
    .getByRole("row")
    .filter({ hasText: "Watched fields did not change." });
  await expect(skippedLogRows).toHaveCount(1);

  await editTicket(page, title, {});
  await page.goto("/workflows");
  await expect(skippedLogRows).toHaveCount(2);
});
