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

async function createUpdateRecordWorkflow({
  page,
  fixture,
  workflowName,
  triggerType = "record_updated",
  watchedFields = [],
  mappings,
  conditions = [],
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  workflowName: string;
  triggerType?: "record_created" | "record_updated";
  watchedFields?: TestField[];
  mappings: Array<
    | { target: TestField; type: "clear" | "leave_unchanged" }
    | { target: TestField; type: "constant"; value: string }
    | { target: TestField; type: "source_field"; source: TestField }
    | { target: TestField; type: "template"; tokens: string[] }
  >;
  conditions?: Array<{ field: TestField; operator: string; value?: string }>;
}) {
  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Workflow Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
    value: triggerType,
  });
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.ticket.id,
  });
  await selectReactOption(page.getByLabel("Action", { exact: true }), {
    value: "update_record",
  });
  await expect(page.getByLabel("Then Create Record In")).toHaveCount(0);
  await expect(workflowMappingType(page, fixture.ticket.fields.status)).toBeVisible();

  for (const watchedField of watchedFields) {
    await page
      .locator(
        `input[name="watchedFieldDefinitionId"][value="${watchedField.id}"]`,
      )
      .check();
  }

  for (const mapping of mappings) {
    await selectReactOption(workflowMappingType(page, mapping.target), {
      value: mapping.type,
    });

    if (mapping.type === "constant") {
      if (mapping.target.type === "relation") {
        await selectReactOption(workflowConstantValue(page, mapping.target), {
          value: mapping.value,
        });
      } else {
        await workflowConstantValue(page, mapping.target).fill(mapping.value);
      }
    } else if (mapping.type === "source_field") {
      await selectReactOption(workflowSourceField(page, mapping.target), {
        value: mapping.source.id,
      });
    } else if (mapping.type === "template") {
      for (const token of mapping.tokens) {
        await page.getByRole("button", { name: token }).click();
      }
    }
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

    if (condition.value !== undefined) {
      await page.locator('[name^="conditionValue:"]').last().fill(condition.value);
    }
  }

  await page.getByRole("button", { name: "Create Workflow" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();
}

async function createTicket({
  page,
  fixture,
  title,
  status = "",
  notes = "",
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
  await expect(page.getByText(`${fixture.ticket.name} created.`)).toBeVisible();
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
  changes: { status?: string; notes?: string; clientLabel?: string };
}) {
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

  if (changes.clientLabel !== undefined) {
    await selectReactOption(
      page.locator(`[name="${fixture.ticket.fields.client.key}"]`),
      { label: changes.clientLabel },
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

async function expectTicketRow({
  page,
  fixture,
  title,
  text,
}: {
  page: Page;
  fixture: RecordUpdatedFixture;
  title: string;
  text: string;
}) {
  await gotoEntity(page, fixture.ticket);
  await expect(rowForText(page, title)).toContainText(text);
}

test("record_created updates the triggering record", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Created Sets New`;
  const title = `${run.label} Created update ticket`;

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName,
    triggerType: "record_created",
    mappings: [
      { target: fixture.ticket.fields.status, type: "constant", value: "New" },
    ],
  });
  await createTicket({ page, fixture, title });

  await expectTicketRow({ page, fixture, title, text: "New" });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("record_updated updates the triggering record with a constant", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Updated Constant`;
  const title = `${run.label} Updated constant ticket`;

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      {
        target: fixture.ticket.fields.notes,
        type: "constant",
        value: "Status changed",
      },
    ],
  });
  await createTicket({ page, fixture, title, status: "Open" });
  await editTicket({ page, fixture, title, changes: { status: "Closed" } });

  await expectTicketRow({ page, fixture, title, text: "Status changed" });
  await expectWorkflowLog({ page, workflowName, status: "succeeded" });
});

test("source-field copy and text template update work", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const sourceWorkflowName = `${run.label} Source Copy`;
  const templateWorkflowName = `${run.label} Template Update`;
  const sourceTitle = `${run.label} Source copy ticket`;
  const templateTitle = `${run.label} Template ticket`;

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: sourceWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      {
        target: fixture.ticket.fields.notes,
        type: "source_field",
        source: fixture.ticket.fields.status,
      },
    ],
  });
  await createTicket({ page, fixture, title: sourceTitle, status: "Open" });
  await editTicket({ page, fixture, title: sourceTitle, changes: { status: "Copied" } });
  await expectTicketRow({ page, fixture, title: sourceTitle, text: "Copied" });

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: templateWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      {
        target: fixture.ticket.fields.notes,
        type: "template",
        tokens: [
          `${fixture.ticket.name} → Title (Text, field ${fixture.ticket.fields.title.position})`,
          `${fixture.ticket.name} → Status (Text, field ${fixture.ticket.fields.status.position})`,
        ],
      },
    ],
  });
  await createTicket({ page, fixture, title: templateTitle, status: "Draft" });
  await editTicket({
    page,
    fixture,
    title: templateTitle,
    changes: { status: "Ready" },
  });
  await expectTicketRow({ page, fixture, title: templateTitle, text: "Ready" });
  await expectWorkflowLog({ page, workflowName: templateWorkflowName, status: "succeeded" });
});

test("relation update and optional clears work", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const relationWorkflowName = `${run.label} Relation Update`;
  const clearWorkflowName = `${run.label} Clear Optional Values`;
  const relationTitle = `${run.label} Relation update ticket`;
  const clearTitle = `${run.label} Clear ticket`;

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: relationWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      {
        target: fixture.ticket.fields.client,
        type: "constant",
        value: fixture.secondClientRecordId,
      },
    ],
  });
  await createTicket({
    page,
    fixture,
    title: relationTitle,
    status: "Open",
    clientLabel: `${run.label} Alpha Client`,
  });
  await editTicket({
    page,
    fixture,
    title: relationTitle,
    changes: { status: "Move Client" },
  });
  await expectTicketRow({
    page,
    fixture,
    title: relationTitle,
    text: `${run.label} Beta Client`,
  });

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: clearWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      { target: fixture.ticket.fields.notes, type: "clear" },
      { target: fixture.ticket.fields.client, type: "clear" },
    ],
  });
  await createTicket({
    page,
    fixture,
    title: clearTitle,
    status: "Open",
    notes: "Clear me",
    clientLabel: `${run.label} Alpha Client`,
  });
  await editTicket({ page, fixture, title: clearTitle, changes: { status: "Clear" } });
  await gotoEntity(page, fixture.ticket);
  const clearedRow = rowForText(page, clearTitle);
  await expect(clearedRow).not.toContainText("Clear me");
  await expect(clearedRow).not.toContainText(`${run.label} Alpha Client`);
  await expectWorkflowLog({ page, workflowName: clearWorkflowName, status: "succeeded" });
});

test("required field cannot be cleared", async ({ page }) => {
  const { run, fixture } = await createScenario();

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Workflow Name").fill(`${run.label} Invalid Clear`);
  await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
    value: "record_updated",
  });
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.ticket.id,
  });
  await selectReactOption(page.getByLabel("Action", { exact: true }), {
    value: "update_record",
  });

  await expect(workflowMappingType(page, fixture.ticket.fields.title)).not.toContainText(
    "Clear value",
  );
});

test("leave unchanged preserves values and condition mismatch skips", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const preserveWorkflowName = `${run.label} Preserve Value`;
  const mismatchWorkflowName = `${run.label} Condition Mismatch`;
  const preserveTitle = `${run.label} Preserve ticket`;
  const mismatchTitle = `${run.label} Mismatch ticket`;

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: preserveWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      { target: fixture.ticket.fields.notes, type: "leave_unchanged" },
    ],
  });
  await createTicket({
    page,
    fixture,
    title: preserveTitle,
    status: "Open",
    notes: "Keep me",
  });
  await editTicket({ page, fixture, title: preserveTitle, changes: { status: "Closed" } });
  await expectTicketRow({ page, fixture, title: preserveTitle, text: "Keep me" });

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: mismatchWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      { target: fixture.ticket.fields.notes, type: "constant", value: "Should not set" },
    ],
    conditions: [
      {
        field: fixture.ticket.fields.status,
        operator: "equals",
        value: "Ready",
      },
    ],
  });
  await createTicket({ page, fixture, title: mismatchTitle, status: "Open" });
  await editTicket({ page, fixture, title: mismatchTitle, changes: { status: "Blocked" } });
  await gotoEntity(page, fixture.ticket);
  await expect(rowForText(page, mismatchTitle)).not.toContainText("Should not set");
  await expectWorkflowLog({
    page,
    workflowName: mismatchWorkflowName,
    status: "skipped",
    message: "Workflow conditions did not match.",
  });
});

test("no-op update logs succeeded without changing the record", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const noopWorkflowName = `${run.label} Noop Success`;
  const noopTitle = `${run.label} Noop ticket`;

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: noopWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      { target: fixture.ticket.fields.notes, type: "constant", value: "Already set" },
    ],
  });
  await createTicket({
    page,
    fixture,
    title: noopTitle,
    status: "Open",
    notes: "Already set",
  });
  await editTicket({ page, fixture, title: noopTitle, changes: { status: "Closed" } });
  await expectWorkflowLog({
    page,
    workflowName: noopWorkflowName,
    status: "succeeded",
    message: "No changes required.",
  });
});

test("automated updates do not recurse and multiple workflows are deterministic", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const firstWorkflowName = `${run.label} First Update`;
  const secondWorkflowName = `${run.label} Second Update`;
  const recursiveWorkflowName = `${run.label} Recursive Guard`;
  const title = `${run.label} Deterministic ticket`;

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: firstWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      { target: fixture.ticket.fields.notes, type: "constant", value: "First" },
    ],
  });
  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: secondWorkflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      {
        target: fixture.ticket.fields.status,
        type: "source_field",
        source: fixture.ticket.fields.notes,
      },
    ],
  });
  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName: recursiveWorkflowName,
    watchedFields: [fixture.ticket.fields.notes],
    mappings: [
      { target: fixture.ticket.fields.status, type: "constant", value: "Recursive" },
    ],
  });
  await createTicket({ page, fixture, title, status: "Open" });
  await editTicket({ page, fixture, title, changes: { status: "User Change" } });

  await expectTicketRow({ page, fixture, title, text: "First" });
  await gotoEntity(page, fixture.ticket);
  await expect(rowForText(page, title)).not.toContainText("User Change");
  await page.goto("/workflows");
  await expect(workflowLogRow(page, firstWorkflowName, "succeeded")).toBeVisible();
  await expect(workflowLogRow(page, secondWorkflowName, "succeeded")).toBeVisible();
  await expect(workflowLogRow(page, recursiveWorkflowName, "succeeded")).toHaveCount(0);
});

test("archived referenced field logs failed", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Archived Target Failure`;
  const title = `${run.label} Archived target ticket`;

  await createUpdateRecordWorkflow({
    page,
    fixture,
    workflowName,
    watchedFields: [fixture.ticket.fields.status],
    mappings: [
      { target: fixture.ticket.fields.notes, type: "constant", value: "Archived" },
    ],
  });
  await createTicket({ page, fixture, title, status: "Open" });
  await archiveTestField(fixture.ticket.fields.notes);
  await editTicket({ page, fixture, title, changes: { status: "Closed" } });

  await expectWorkflowLog({
    page,
    workflowName,
    status: "failed",
    message: "archived target field",
  });
});
