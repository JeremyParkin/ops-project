import { expect, type Page, test } from "@playwright/test";
import {
  archiveTestField,
  cleanupE2eRun,
  cleanupStaleE2eData,
  createRecordUpdatedFixture,
  createTestRun,
  type RecordUpdatedFixture,
  type TestField,
  type TestRun,
} from "./helpers/supabase-test-data";
import {
  addRecordSection,
  chooseRecordField,
  editRecordFromRow,
  expectAfterMutation,
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

async function createRecordUpdatedWorkflow({
  page,
  fixture,
  workflowName,
  watchedFields,
  mappings = [],
  conditions = [],
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  workflowName: string;
  watchedFields: TestField[];
  mappings?: Array<
    | { target: TestField; type: "source_field"; source: TestField }
    | { target: TestField; type: "constant"; value: string }
  >;
  conditions?: Array<{ field: TestField; operator: string; value?: string }>;
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

  for (const watchedField of watchedFields) {
    await page
      .locator(
        `input[name="watchedFieldDefinitionId"][value="${watchedField.id}"]`,
      )
      .check();
  }

  await configureSourceMapping({
    page,
    target: fixture.activity.fields.summary,
    source: fixture.ticket.fields.title,
  });

  for (const mapping of mappings) {
    if (mapping.type === "source_field") {
      await configureSourceMapping({
        page,
        target: mapping.target,
        source: mapping.source,
      });
    } else {
      await configureConstantMapping({
        page,
        target: mapping.target,
        value: mapping.value,
      });
    }
  }

  for (const condition of conditions) {
    await page.getByRole("button", { name: "Add Condition" }).click();
    const conditionField = page.locator('select[name^="conditionField:"]').last();
    const conditionOperator = page
      .locator('select[name^="conditionOperator:"]')
      .last();

    await selectReactOption(conditionField, { value: condition.field.id });
    await selectReactOption(conditionOperator, { value: condition.operator });

    if (condition.value !== undefined) {
      await page.locator('[name^="conditionValue:"]').last().fill(condition.value);
    }
  }

  await page.getByRole("button", { name: "Create Automation" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();
}

async function configureSourceMapping({
  page,
  target,
  source,
}: {
  page: Page;
  target: TestField;
  source: TestField;
}) {
  await selectReactOption(workflowMappingType(page, target), {
    value: "source_field",
  });
  await selectReactOption(workflowSourceField(page, target), {
    value: source.id,
  });
}

async function configureConstantMapping({
  page,
  target,
  value,
}: {
  page: Page;
  target: TestField;
  value: string;
}) {
  await selectReactOption(workflowMappingType(page, target), {
    value: "constant",
  });
  await workflowConstantValue(page, target).fill(value);
}

async function createTicket({
  page,
  fixture,
  title,
  status = "Open",
  notes = "Initial",
  clientLabel,
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  title: string;
  status?: string;
  notes?: string;
  clientLabel?: string;
}) {
  await gotoEntity(page, fixture.ticket);
  const form = addRecordSection(page, fixture.ticket);
  await fillRecordField(form, fixture.ticket.fields.title, title);
  await fillRecordField(form, fixture.ticket.fields.status, status);
  await fillRecordField(form, fixture.ticket.fields.notes, notes);

  if (clientLabel) {
    await chooseRecordField(form, fixture.ticket.fields.client, clientLabel);
  }

  await submitAddRecord(page, fixture.ticket);
  // Post-submit: the create form's Server Action round-trip -- occasionally
  // exceeds the default 5s timeout under full-suite load (documented flake
  // history).
  await expectAfterMutation(page.getByText(`${fixture.ticket.name} created.`));
}

async function editTicket({
  page,
  fixture,
  title,
  changes,
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  title: string;
  changes: { status?: string; notes?: string; clientLabel?: string; clearClient?: boolean };
}) {
  await gotoEntity(page, fixture.ticket);
  await editRecordFromRow(page, rowForText(page, title), title);
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

  if (changes.clientLabel !== undefined) {
    await selectReactOption(
      page.locator(`[name="${fixture.ticket.fields.client.key}"]`),
      { label: changes.clientLabel },
    );
  }

  if (changes.clearClient) {
    await selectReactOption(
      page.locator(`[name="${fixture.ticket.fields.client.key}"]`),
      { value: "" },
    );
  }

  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(
    page.getByRole("heading", { name: fixture.ticket.name, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
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

test("watched field changed executes successfully", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Watched Status Success`;
  const title = `${run.label} Watched status ticket`;

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      {
        target: fixture.activity.fields.status,
        type: "source_field",
        source: fixture.ticket.fields.status,
      },
    ],
  });
  await createTicket({ page, fixture, title });
  await editTicket({
    page,
    fixture,
    title,
    changes: { status: "Closed" },
  });

  await expectActivityExists({ page, fixture, title, text: "Closed" });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("unrelated field changed skips without creating an action record", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Unrelated Change Skip`;
  const title = `${run.label} Unrelated ticket`;

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status],
  });
  await createTicket({ page, fixture, title });
  await editTicket({
    page,
    fixture,
    title,
    changes: { notes: "Only notes changed" },
  });

  await expectActivityMissing({ page, fixture, title });
  await expectWorkflowLog({
    page,
    workflowName,
    status: "skipped",
    message: "Watched fields did not change.",
  });
});

test("watched relation changed executes successfully", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Relation Change Success`;
  const title = `${run.label} Relation change ticket`;

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.client],
    mappings: [
      {
        target: fixture.activity.fields.client,
        type: "source_field",
        source: fixture.ticket.fields.client,
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
    changes: { clientLabel: `${run.label} Beta Client` },
  });

  await expectActivityExists({
    page,
    fixture,
    title,
    text: `${run.label} Beta Client`,
  });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("watched optional relation cleared executes successfully", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Relation Clear Success`;
  const title = `${run.label} Relation clear ticket`;

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.client],
    mappings: [
      {
        target: fixture.activity.fields.status,
        type: "constant",
        value: "Relation cleared",
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
    changes: { clearClient: true },
  });

  await expectActivityExists({
    page,
    fixture,
    title,
    text: "Relation cleared",
  });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("conditions evaluate against the persisted new values", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const matchingWorkflowName = `${run.label} Ready Condition Success`;
  const skippedWorkflowName = `${run.label} Ready Condition Skip`;
  const matchingTitle = `${run.label} Ready ticket`;
  const skippedTitle = `${run.label} Not ready ticket`;

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName: matchingWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      {
        target: fixture.activity.fields.status,
        type: "source_field",
        source: fixture.ticket.fields.status,
      },
    ],
    conditions: [
      {
        field: fixture.ticket.fields.status,
        operator: "equals",
        value: "Ready",
      },
    ],
  });
  await createTicket({ page, fixture, title: matchingTitle, status: "Draft" });
  await editTicket({
    page,
    fixture,
    title: matchingTitle,
    changes: { status: "Ready" },
  });

  await expectActivityExists({
    page,
    fixture,
    title: matchingTitle,
    text: "Ready",
  });
  await expectWorkflowLog({
    page,
    workflowName: matchingWorkflowName,
    status: "succeeded",
  });

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName: skippedWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      {
        target: fixture.activity.fields.status,
        type: "source_field",
        source: fixture.ticket.fields.status,
      },
    ],
    conditions: [
      {
        field: fixture.ticket.fields.status,
        operator: "equals",
        value: "Ready",
      },
    ],
  });
  await createTicket({ page, fixture, title: skippedTitle, status: "Draft" });
  await editTicket({
    page,
    fixture,
    title: skippedTitle,
    changes: { status: "Blocked" },
  });

  await expectActivityMissing({ page, fixture, title: skippedTitle });
  await expectWorkflowLog({
    page,
    workflowName: skippedWorkflowName,
    status: "skipped",
    message: "Workflow conditions did not match.",
  });
});

test("multiple watched fields use any-field semantics", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Any Field Success`;
  const statusTitle = `${run.label} Any status ticket`;
  const notesTitle = `${run.label} Any notes ticket`;

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status, fixture.ticket.fields.notes],
    mappings: [
      {
        target: fixture.activity.fields.status,
        type: "constant",
        value: "Any field fired",
      },
    ],
  });
  await createTicket({ page, fixture, title: statusTitle });
  await editTicket({
    page,
    fixture,
    title: statusTitle,
    changes: { status: "Investigating" },
  });

  await expectActivityExists({
    page,
    fixture,
    title: statusTitle,
    text: "Any field fired",
  });
  await createTicket({ page, fixture, title: notesTitle });
  await editTicket({
    page,
    fixture,
    title: notesTitle,
    changes: { notes: "Notes changed" },
  });

  await expectActivityExists({
    page,
    fixture,
    title: notesTitle,
    text: "Any field fired",
  });
  await page.goto("/workflows");
  await expect(workflowLogRow(page, workflowName, "succeeded")).toHaveCount(2);
});

test("no-op edit skips with watched-fields-did-not-change reason", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Noop Skip`;
  const title = `${run.label} Noop ticket`;

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status],
  });
  await createTicket({ page, fixture, title });
  await editTicket({ page, fixture, title, changes: {} });

  await expectActivityMissing({ page, fixture, title });
  await expectWorkflowLog({
    page,
    workflowName,
    status: "skipped",
    message: "Watched fields did not change.",
  });
});

test("archived watched-field configuration logs failed", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Archived Watched Field Failure`;
  const title = `${run.label} Archived watched ticket`;

  await createRecordUpdatedWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.notes],
  });
  await createTicket({ page, fixture, title });
  await archiveTestField(fixture.ticket.fields.notes);
  await editTicket({
    page,
    fixture,
    title,
    changes: { status: "Changed after archive" },
  });

  await expectActivityMissing({ page, fixture, title });
  await expectWorkflowLog({
    page,
    workflowName,
    status: "failed",
    message: "archived",
  });
});
