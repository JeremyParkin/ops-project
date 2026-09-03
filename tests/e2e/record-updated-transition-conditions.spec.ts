import { expect, type Page, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createRecordUpdatedFixture,
  createSupabaseTestClient,
  createTestRun,
  type RecordUpdatedFixture,
  type TestEntity,
  type TestField,
  type TestRun,
} from "./helpers/supabase-test-data";
import {
  addRecordSection,
  chooseRecordField,
  editRecordFromRow,
  expectTableValue,
  fillRecordField,
  gotoEntity,
  rowForText,
  selectReactOption,
  submitAddRecord,
  waitForWorkflowFormReady,
  workflowConstantValue,
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

async function createScenario() {
  const run = createTestRun();
  runs.push(run);

  return {
    run,
    fixture: await createRecordUpdatedFixture(run),
  };
}

type ConditionInput = {
  field: TestField;
  operator: string;
  value?: string;
  previousValue?: string;
};

async function createTransitionWorkflow({
  page,
  fixture,
  workflowName,
  watchedFields,
  conditions,
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  workflowName: string;
  watchedFields: TestField[];
  conditions: ConditionInput[];
}) {
  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Automation Name").fill(workflowName);
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
  await selectReactOption(workflowMappingType(page, fixture.activity.fields.client), {
    value: "source_field",
  });
  await selectReactOption(workflowSourceField(page, fixture.activity.fields.client), {
    value: fixture.ticket.fields.client.id,
  });

  for (const watchedField of watchedFields) {
    const checkbox = page.locator(
      `input[name="watchedFieldDefinitionId"][value="${watchedField.id}"]`,
    );
    await checkbox.check();
    await expect(checkbox, `watched checkbox for ${watchedField.slug}`).toBeChecked();
  }

  for (const condition of conditions) {
    await page.getByRole("button", { name: "Add Condition" }).click();
    await selectReactOption(page.locator('select[name^="conditionField:"]').last(), {
      value: condition.field.id,
    });
    await selectReactOption(
      page.locator('select[name^="conditionOperator:"]').last(),
      { value: condition.operator },
    );

    if (condition.previousValue !== undefined) {
      if (condition.field.type === "relation") {
        await selectReactOption(
          page.locator('[name^="conditionPreviousValue:"]').last(),
          { value: condition.previousValue },
        );
      } else {
        await page
          .locator('[name^="conditionPreviousValue:"]')
          .last()
          .fill(condition.previousValue);
      }
    }

    if (condition.value !== undefined) {
      if (condition.field.type === "relation") {
        await selectReactOption(page.locator('[name^="conditionValue:"]').last(), {
          value: condition.value,
        });
      } else {
        await page.locator('[name^="conditionValue:"]').last().fill(condition.value);
      }
    }
  }

  await page.getByRole("button", { name: "Create Automation" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();
}

async function createTicket({
  page,
  fixture,
  title,
  status = "Draft",
  clientLabel,
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  title: string;
  status?: string;
  clientLabel?: string;
}) {
  await gotoEntity(page, fixture.ticket);
  const form = addRecordSection(page, fixture.ticket);
  await fillRecordField(form, fixture.ticket.fields.title, title);
  await fillRecordField(form, fixture.ticket.fields.status, status);

  if (clientLabel) {
    await chooseRecordField(form, fixture.ticket.fields.client, clientLabel);
  }

  await submitAddRecord(page, fixture.ticket);
  await expect(page.getByText(`${fixture.ticket.name} created.`)).toBeVisible({ timeout: 15_000 });
}

async function editTicket({
  page,
  fixture,
  title,
  status,
  clientLabel,
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  title: string;
  status?: string;
  clientLabel?: string;
}) {
  await gotoEntity(page, fixture.ticket);
  await editRecordFromRow(page, rowForText(page, title), title);
  await expect(
    page.getByRole("heading", {
      name: `Edit ${fixture.ticket.name}`,
      exact: true,
    }),
  ).toBeVisible();

  if (status !== undefined) {
    await page.locator(`[name="${fixture.ticket.fields.status.key}"]`).fill(status);
  }

  if (clientLabel !== undefined) {
    await selectReactOption(
      page.locator(`[name="${fixture.ticket.fields.client.key}"]`),
      { label: clientLabel },
    );
  }

  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(
    page.getByRole("heading", { name: fixture.ticket.name, exact: true }),
  ).toBeVisible();
}

function workflowLogRow(page: Page, workflowName: string, text: string) {
  return page
    .getByRole("row")
    .filter({ hasText: workflowName })
    .filter({ hasText: text });
}

async function expectWorkflowLog({
  page,
  workflowName,
  status,
  message,
}: {
  page: Page;
  workflowName: string;
  status: "succeeded" | "skipped" | "failed";
  message?: string;
}) {
  await page.goto("/workflows");
  const row = workflowLogRow(page, workflowName, status);
  await expect(row).toBeVisible();

  if (message) {
    await expect(row).toContainText(message);
  }
}

async function expectActivityExists({
  page,
  fixture,
  title,
  text,
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  title: string;
  text?: string;
}) {
  await gotoEntity(page, fixture.activity);
  await expectTableValue(page, title);

  if (text) {
    await expect(rowForText(page, title)).toContainText(text);
  }
}

async function expectActivityMissing({
  page,
  fixture,
  title,
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  title: string;
}) {
  await gotoEntity(page, fixture.activity);
  await expect(rowForText(page, title)).toHaveCount(0);
}

test("changed fires only when its own field changes, not merely when eligibility is met", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Changed Own Field Only`;
  const skippedTitle = `${run.label} Changed skip ticket`;
  const firedTitle = `${run.label} Changed fire ticket`;

  await createTransitionWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status, fixture.ticket.fields.notes],
    conditions: [{ field: fixture.ticket.fields.status, operator: "changed" }],
  });

  await createTicket({ page, fixture, title: skippedTitle, status: "Draft" });
  await gotoEntity(page, fixture.ticket);
  await editRecordFromRow(page, rowForText(page, skippedTitle), skippedTitle);
  await expect(
    page.getByRole("heading", {
      name: `Edit ${fixture.ticket.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(`[name="${fixture.ticket.fields.notes.key}"]`)
    .fill("Notes only, status untouched");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(
    page.getByRole("heading", { name: fixture.ticket.name, exact: true }),
  ).toBeVisible();

  await expectActivityMissing({ page, fixture, title: skippedTitle });
  await expectWorkflowLog({
    page,
    workflowName,
    status: "skipped",
    message: "Workflow conditions did not match.",
  });

  await createTicket({ page, fixture, title: firedTitle, status: "Draft" });
  await editTicket({ page, fixture, title: firedTitle, status: "Approved" });

  await expectActivityExists({ page, fixture, title: firedTitle, text: "Approved" });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("changed_to fires only on the transition into the value, not while already at it", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Changed To Approved`;
  const alreadyTitle = `${run.label} Already approved ticket`;
  const transitionTitle = `${run.label} Transition to approved ticket`;

  await createTransitionWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status, fixture.ticket.fields.notes],
    conditions: [
      { field: fixture.ticket.fields.status, operator: "changed_to", value: "Approved" },
    ],
  });

  await createTicket({ page, fixture, title: alreadyTitle, status: "Approved" });
  await gotoEntity(page, fixture.ticket);
  await editRecordFromRow(page, rowForText(page, alreadyTitle), alreadyTitle);
  await expect(
    page.getByRole("heading", {
      name: `Edit ${fixture.ticket.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(`[name="${fixture.ticket.fields.notes.key}"]`)
    .fill("Still approved, only notes changed");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(
    page.getByRole("heading", { name: fixture.ticket.name, exact: true }),
  ).toBeVisible();

  await expectActivityMissing({ page, fixture, title: alreadyTitle });
  await expectWorkflowLog({
    page,
    workflowName,
    status: "skipped",
    message: "Workflow conditions did not match.",
  });

  await createTicket({ page, fixture, title: transitionTitle, status: "Draft" });
  await editTicket({ page, fixture, title: transitionTitle, status: "Approved" });

  await expectActivityExists({ page, fixture, title: transitionTitle, text: "Approved" });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("changed_from fires only on transition away from the value", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Changed From Draft`;
  const neverDraftTitle = `${run.label} Never draft ticket`;
  const fromDraftTitle = `${run.label} From draft ticket`;

  await createTransitionWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status],
    conditions: [
      { field: fixture.ticket.fields.status, operator: "changed_from", previousValue: "Draft" },
    ],
  });

  await createTicket({ page, fixture, title: neverDraftTitle, status: "Blocked" });
  await editTicket({ page, fixture, title: neverDraftTitle, status: "Approved" });

  await expectActivityMissing({ page, fixture, title: neverDraftTitle });
  await expectWorkflowLog({
    page,
    workflowName,
    status: "skipped",
    message: "Workflow conditions did not match.",
  });

  await createTicket({ page, fixture, title: fromDraftTitle, status: "Draft" });
  await editTicket({ page, fixture, title: fromDraftTitle, status: "Approved" });

  await expectActivityExists({ page, fixture, title: fromDraftTitle, text: "Approved" });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("changed_from_to fires only on the exact transition pair", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Changed From Draft To Approved`;
  const wrongToTitle = `${run.label} Wrong to ticket`;
  const exactTitle = `${run.label} Exact transition ticket`;

  await createTransitionWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status],
    conditions: [
      {
        field: fixture.ticket.fields.status,
        operator: "changed_from_to",
        previousValue: "Draft",
        value: "Approved",
      },
    ],
  });

  await createTicket({ page, fixture, title: wrongToTitle, status: "Draft" });
  await editTicket({ page, fixture, title: wrongToTitle, status: "Rejected" });

  await expectActivityMissing({ page, fixture, title: wrongToTitle });
  await expectWorkflowLog({
    page,
    workflowName,
    status: "skipped",
    message: "Workflow conditions did not match.",
  });

  await createTicket({ page, fixture, title: exactTitle, status: "Draft" });
  await editTicket({ page, fixture, title: exactTitle, status: "Approved" });

  await expectActivityExists({ page, fixture, title: exactTitle, text: "Approved" });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("relation field transition compares record IDs with human-readable labels in the editor", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Client Changed From Alpha To Beta`;
  const title = `${run.label} Relation transition ticket`;

  await createTransitionWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.client],
    conditions: [
      {
        field: fixture.ticket.fields.client,
        operator: "changed_from_to",
        previousValue: fixture.firstClientRecordId,
        value: fixture.secondClientRecordId,
      },
    ],
  });

  await createTicket({
    page,
    fixture,
    title,
    clientLabel: `${run.label} Alpha Client`,
  });
  await editTicket({
    page,
    fixture,
    title,
    clientLabel: `${run.label} Beta Client`,
  });

  await expectActivityExists({
    page,
    fixture,
    title,
    text: `${run.label} Beta Client`,
  });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("selecting a changed operator automatically checks its field as watched", async ({
  page,
}) => {
  const { fixture } = await createScenario();

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
    value: "record_updated",
  });
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.ticket.id,
  });

  const watchedCheckbox = page.locator(
    `input[name="watchedFieldDefinitionId"][value="${fixture.ticket.fields.status.id}"]`,
  );
  await expect(watchedCheckbox).not.toBeChecked();

  await page.getByRole("button", { name: "Add Condition" }).click();
  await selectReactOption(page.locator('select[name^="conditionField:"]').last(), {
    value: fixture.ticket.fields.status.id,
  });
  await selectReactOption(page.locator('select[name^="conditionOperator:"]').last(), {
    value: "changed_to",
  });

  await expect(watchedCheckbox).toBeChecked();
});

test("server-side validation rejects a transition condition on an unwatched field", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Unwatched Transition Rejected`;

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Automation Name").fill(workflowName);
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

  // Watch an unrelated field so the workflow is otherwise eligible.
  await page
    .locator(
      `input[name="watchedFieldDefinitionId"][value="${fixture.ticket.fields.notes.id}"]`,
    )
    .check();

  await page.getByRole("button", { name: "Add Condition" }).click();
  await selectReactOption(page.locator('select[name^="conditionField:"]').last(), {
    value: fixture.ticket.fields.status.id,
  });
  await selectReactOption(page.locator('select[name^="conditionOperator:"]').last(), {
    value: "changed_to",
  });
  await page.locator('[name^="conditionValue:"]').last().fill("Approved");

  const watchedCheckbox = page.locator(
    `input[name="watchedFieldDefinitionId"][value="${fixture.ticket.fields.status.id}"]`,
  );
  await expect(watchedCheckbox).toBeChecked();
  await watchedCheckbox.uncheck();

  await page.getByRole("button", { name: "Create Automation" }).click();

  await expect(page.getByText("Please fix the highlighted fields.")).toBeVisible();
  await expect(page.getByText(/must be a watched field/i)).toBeVisible();
  await expect(page.getByRole("link", { name: workflowName })).toHaveCount(0);
});

test("record_created workflows do not offer changed operators", async ({ page }) => {
  const { fixture } = await createScenario();

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
    value: "record_created",
  });
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.ticket.id,
  });

  await page.getByRole("button", { name: "Add Condition" }).click();
  await selectReactOption(page.locator('select[name^="conditionField:"]').last(), {
    value: fixture.ticket.fields.status.id,
  });

  const operatorOptions = await page
    .locator('select[name^="conditionOperator:"]')
    .last()
    .locator("option")
    .allTextContents();

  expect(operatorOptions).not.toContain("Changed");
  expect(operatorOptions).not.toContain("Changed To");
  expect(operatorOptions).not.toContain("Changed From");
  expect(operatorOptions).not.toContain("Changed From/To");
});

test("0 and false are treated as real transition values, not unset", async ({ page }) => {
  const run = createTestRun();
  runs.push(run);
  const supabase = createSupabaseTestClient();
  const counter: TestEntity = await createEntity(supabase, run, "Counter", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "count", name: "Count", type: "number" },
    { slug: "active", name: "Active", type: "boolean" },
    { slug: "flag", name: "Flag", type: "text" },
  ]);
  const workflowName = `${run.label} Zero And False Real Values`;

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Automation Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
    value: "record_updated",
  });
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: counter.id,
  });
  await selectReactOption(page.getByLabel("Action", { exact: true }), {
    value: "update_record",
  });
  await expect(workflowMappingType(page, counter.fields.flag)).toBeVisible();

  await page
    .locator(`input[name="watchedFieldDefinitionId"][value="${counter.fields.count.id}"]`)
    .check();
  await page
    .locator(`input[name="watchedFieldDefinitionId"][value="${counter.fields.active.id}"]`)
    .check();

  await selectReactOption(workflowMappingType(page, counter.fields.flag), {
    value: "constant",
  });
  await workflowConstantValue(page, counter.fields.flag).fill("Fired");

  await page.getByRole("button", { name: "Add Condition" }).click();
  await selectReactOption(page.locator('select[name^="conditionField:"]').last(), {
    value: counter.fields.count.id,
  });
  await selectReactOption(page.locator('select[name^="conditionOperator:"]').last(), {
    value: "changed_to",
  });
  await page.locator('[name^="conditionValue:"]').last().fill("0");

  await page.getByRole("button", { name: "Add Condition" }).click();
  await selectReactOption(page.locator('select[name^="conditionField:"]').last(), {
    value: counter.fields.active.id,
  });
  await selectReactOption(page.locator('select[name^="conditionOperator:"]').last(), {
    value: "changed_to",
  });
  await selectReactOption(page.locator('select[name^="conditionValue:"]').last(), {
    value: "false",
  });

  await page.getByRole("button", { name: "Create Automation" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();

  await gotoEntity(page, counter);
  const form = addRecordSection(page, counter);
  await fillRecordField(form, counter.fields.name, `${run.label} Item`);
  await fillRecordField(form, counter.fields.count, "5");
  await form
    .locator(`input[type="checkbox"][name="${counter.fields.active.key}"]`)
    .check();
  await submitAddRecord(page, counter);
  await expect(page.getByText(`${counter.name} created.`)).toBeVisible();

  await gotoEntity(page, counter);
  await editRecordFromRow(
    page,
    rowForText(page, `${run.label} Item`),
    `${run.label} Item`,
  );
  await expect(
    page.getByRole("heading", { name: `Edit ${counter.name}`, exact: true }),
  ).toBeVisible();
  await page.locator(`[name="${counter.fields.count.key}"]`).fill("0");
  await page
    .locator(`input[type="checkbox"][name="${counter.fields.active.key}"]`)
    .uncheck();
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(
    page.getByRole("heading", { name: counter.name, exact: true }),
  ).toBeVisible();

  await gotoEntity(page, counter);
  await expect(rowForText(page, `${run.label} Item`)).toContainText("Fired");
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});
