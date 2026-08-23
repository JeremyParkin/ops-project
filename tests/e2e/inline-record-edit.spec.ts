import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createRecordUpdatedFixture,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type RecordUpdatedFixture,
  type TestField,
  type TestRun,
} from "./helpers/supabase-test-data";
import {
  gotoEntity,
  rowForText,
  selectReactOption,
  waitForWorkflowFormReady,
  workflowMappingType,
  workflowSourceField,
} from "./helpers/ui";

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

function inlineEditButton(row: Locator, field: TestField) {
  return row.getByRole("button", { name: `Edit ${field.name}` });
}

async function inlineEditText(row: Locator, field: TestField, value: string) {
  await inlineEditButton(row, field).click();
  const input = row.locator('input[name="value"]');
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press("Enter");
}

test.describe("inline record editing", () => {
  async function createTaskFixture(run: TestRun) {
    const supabase = createSupabaseTestClient();
    const client = await createEntity(supabase, run, "Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const task = await createEntity(supabase, run, "Task", [
      { slug: "title", name: "Title", type: "text", required: true },
      { slug: "status", name: "Status", type: "text" },
      { slug: "amount", name: "Amount", type: "number" },
      { slug: "due", name: "Due Date", type: "date" },
      { slug: "active", name: "Active", type: "boolean" },
      {
        slug: "client",
        name: "Client",
        type: "relation",
        relatedEntityTypeId: client.id,
      },
    ]);
    const clientRecordId = await createEntityRecord({
      entity: client,
      valuesBySlug: { name: `${run.label} Acme` },
    });

    return { client, task, clientRecordId };
  }

  test("inline-edits a text field with Enter, and a reload confirms persistence", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const { task } = await createTaskFixture(run);
    const title = `${run.label} Text Edit Task`;
    await createEntityRecord({
      entity: task,
      valuesBySlug: { title, status: "Draft" },
    });

    await gotoEntity(page, task);
    const row = rowForText(page, title);
    await inlineEditText(row, task.fields.status, "In Progress");

    await expect(inlineEditButton(row, task.fields.status)).toBeVisible();
    await expect(row).toContainText("In Progress");

    await page.reload();
    await expect(rowForText(page, title)).toContainText("In Progress");
  });

  test("shows an inline error for an invalid number and does not persist it", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const { task } = await createTaskFixture(run);
    const title = `${run.label} Number Validation Task`;
    await createEntityRecord({
      entity: task,
      valuesBySlug: { title, amount: 100 },
    });

    await gotoEntity(page, task);
    const row = rowForText(page, title);
    await inlineEditButton(row, task.fields.amount).click();
    const input = row.locator('input[name="value"]');
    await input.fill("not-a-number");
    await input.press("Enter");

    await expect(row.getByRole("alert")).toContainText("must be a number");
    await expect(input).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(inlineEditButton(row, task.fields.amount)).toBeVisible();
    await expect(row).toContainText("100");

    await page.reload();
    await expect(rowForText(page, title)).toContainText("100");
  });

  test("inline-edits a date field", async ({ page }) => {
    const run = createScenarioRun();
    const { task } = await createTaskFixture(run);
    const title = `${run.label} Date Edit Task`;
    await createEntityRecord({
      entity: task,
      valuesBySlug: { title, due: "2026-08-01" },
    });

    await gotoEntity(page, task);
    const row = rowForText(page, title);
    await inlineEditText(row, task.fields.due, "2026-08-15");

    await expect(inlineEditButton(row, task.fields.due)).toBeVisible();
    await expect(row).toContainText("2026-08-15");

    await page.reload();
    await expect(rowForText(page, title)).toContainText("2026-08-15");
  });

  test("inline-edits a boolean field with an explicit Save", async ({ page }) => {
    const run = createScenarioRun();
    const { task } = await createTaskFixture(run);
    const title = `${run.label} Boolean Edit Task`;
    await createEntityRecord({
      entity: task,
      valuesBySlug: { title, active: false },
    });

    await gotoEntity(page, task);
    const row = rowForText(page, title);
    await expect(row).toContainText("No");

    await inlineEditButton(row, task.fields.active).click();
    const checkbox = row.locator('input[name="value"][type="checkbox"]');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await row.getByRole("button", { name: "Save" }).click();

    await expect(inlineEditButton(row, task.fields.active)).toBeVisible();
    await expect(row).toContainText("Yes");

    await page.reload();
    await expect(rowForText(page, title)).toContainText("Yes");
  });

  test("Escape cancels an in-progress inline edit without persisting", async ({ page }) => {
    const run = createScenarioRun();
    const { task } = await createTaskFixture(run);
    const title = `${run.label} Escape Cancel Task`;
    await createEntityRecord({
      entity: task,
      valuesBySlug: { title, status: "Original" },
    });

    await gotoEntity(page, task);
    const row = rowForText(page, title);
    await inlineEditButton(row, task.fields.status).click();
    const input = row.locator('input[name="value"]');
    await input.fill("Should not save");
    await input.press("Escape");

    await expect(inlineEditButton(row, task.fields.status)).toBeVisible();
    await expect(row).toContainText("Original");
    await expect(row).not.toContainText("Should not save");

    await page.reload();
    await expect(rowForText(page, title)).toContainText("Original");
  });

  test("identity and relation cells stay read-only inline; archived records and entities disable inline edit", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const { task, clientRecordId } = await createTaskFixture(run);
    const activeTitle = `${run.label} Active Row Task`;
    const archivedTitle = `${run.label} Archived Row Task`;
    await createEntityRecord({
      entity: task,
      valuesBySlug: { title: activeTitle, status: "Draft" },
      relationsBySlug: { client: clientRecordId },
    });
    const archivedRecordId = await createEntityRecord({
      entity: task,
      valuesBySlug: { title: archivedTitle, status: "Draft" },
    });

    await gotoEntity(page, task);
    const activeRow = rowForText(page, activeTitle);
    await expect(
      activeRow.getByRole("link", { name: activeTitle, exact: true }),
    ).toBeVisible();
    await expect(inlineEditButton(activeRow, task.fields.title)).toHaveCount(0);
    await expect(inlineEditButton(activeRow, task.fields.client)).toHaveCount(0);
    await expect(inlineEditButton(activeRow, task.fields.status)).toBeVisible();

    const supabase = createSupabaseTestClient();
    await supabase
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", archivedRecordId);

    await page.goto(`/entities/${task.id}?showArchived=true`);
    const archivedRow = rowForText(page, archivedTitle);
    await expect(archivedRow).toContainText("Archived");
    await expect(inlineEditButton(archivedRow, task.fields.status)).toHaveCount(0);

    await supabase
      .from("entity_types")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", task.id);

    await page.goto(`/entities/${task.id}`);
    const archivedEntityRow = rowForText(page, activeTitle);
    await expect(inlineEditButton(archivedEntityRow, task.fields.status)).toHaveCount(0);
  });
});

test.describe("inline record editing preserves workflow semantics", () => {
  async function createScenario() {
    const run = createScenarioRun();
    return { run, fixture: await createRecordUpdatedFixture(run) };
  }

  async function createTransitionWorkflow({
    page,
    fixture,
    workflowName,
  }: {
    page: Page;
    fixture: RecordUpdatedFixture;
    workflowName: string;
  }) {
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
    await expect(
      workflowMappingType(page, fixture.activity.fields.summary),
    ).toBeVisible();
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

    await page
      .locator(
        `input[name="watchedFieldDefinitionId"][value="${fixture.ticket.fields.status.id}"]`,
      )
      .check();

    await page.getByRole("button", { name: "Add Condition" }).click();
    await selectReactOption(page.locator('select[name^="conditionField:"]').last(), {
      value: fixture.ticket.fields.status.id,
    });
    await selectReactOption(page.locator('select[name^="conditionOperator:"]').last(), {
      value: "changed",
    });

    await page.getByRole("button", { name: "Create Workflow" }).click();
    await expect(page.getByRole("link", { name: workflowName })).toBeVisible();
  }

  function workflowLogRow(page: Page, workflowName: string, text: string) {
    return page
      .getByRole("row")
      .filter({ hasText: workflowName })
      .filter({ hasText: text });
  }

  test("a no-op inline edit does not trigger any record_updated workflow event", async ({
    page,
  }) => {
    const { run, fixture } = await createScenario();
    const workflowName = `${run.label} No-op Guard`;
    const title = `${run.label} No-op ticket`;
    await createEntityRecord({
      entity: fixture.ticket,
      valuesBySlug: { title, status: "Draft" },
    });

    await createTransitionWorkflow({ page, fixture, workflowName });

    await gotoEntity(page, fixture.ticket);
    const row = rowForText(page, title);
    await inlineEditText(row, fixture.ticket.fields.status, "Draft");
    await expect(inlineEditButton(row, fixture.ticket.fields.status)).toBeVisible();

    await gotoEntity(page, fixture.activity);
    await expect(rowForText(page, title)).toHaveCount(0);

    await page.goto("/workflows");
    await expect(workflowLogRow(page, workflowName, "succeeded")).toHaveCount(0);
    await expect(workflowLogRow(page, workflowName, "skipped")).toHaveCount(0);
  });

  test("a real inline edit fires the record_updated workflow with correct semantics", async ({
    page,
  }) => {
    const { run, fixture } = await createScenario();
    const workflowName = `${run.label} Fires On Real Change`;
    const title = `${run.label} Real change ticket`;
    await createEntityRecord({
      entity: fixture.ticket,
      valuesBySlug: { title, status: "Draft" },
    });

    await createTransitionWorkflow({ page, fixture, workflowName });

    await gotoEntity(page, fixture.ticket);
    const row = rowForText(page, title);
    await inlineEditText(row, fixture.ticket.fields.status, "Approved");
    await expect(inlineEditButton(row, fixture.ticket.fields.status)).toBeVisible();
    await expect(row).toContainText("Approved");

    await gotoEntity(page, fixture.activity);
    await expect(rowForText(page, title)).toContainText("Approved");

    await page.goto("/workflows");
    await expect(workflowLogRow(page, workflowName, "succeeded")).toBeVisible();
  });
});
