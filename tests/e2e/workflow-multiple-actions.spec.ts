import { expect, type Page, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createSupabaseTestClient,
  createTestRun,
  createWorkflowFixture,
  DEMO_WORKSPACE_ID,
  type TestField,
  type TestRun,
  type WorkflowFixture,
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
    fixture: await createWorkflowFixture(run),
  };
}

type ActionInput =
  | {
      actionType: "create_record";
      targetEntityId: string;
      mappings: Array<
        | { target: TestField; type: "constant"; value: string }
        | { target: TestField; type: "source_field"; source: TestField }
      >;
    }
  | {
      actionType: "update_record";
      mappings: Array<
        | { target: TestField; type: "constant"; value: string }
        | { target: TestField; type: "source_field"; source: TestField }
      >;
    }
  | {
      actionType: "update_related_record";
      relatedFieldId: string;
      mappings: Array<
        | { target: TestField; type: "constant"; value: string }
        | { target: TestField; type: "source_field"; source: TestField }
      >;
    };

function actionBlock(page: Page, index: number) {
  return page.locator('input[name="actionId"]').nth(index).locator("xpath=..");
}

async function configureAction({
  page,
  index,
  action,
}: {
  page: Page;
  index: number;
  action: ActionInput;
}) {
  if (index > 0) {
    await page.getByRole("button", { name: "Add Action" }).click();
  }

  const block = actionBlock(page, index);

  await selectReactOption(block.getByLabel("Action", { exact: true }), {
    value: action.actionType,
  });

  if (action.actionType === "create_record") {
    await selectReactOption(block.getByLabel("Then Create Record In"), {
      value: action.targetEntityId,
    });
  }

  if (action.actionType === "update_related_record") {
    await selectReactOption(block.getByLabel("Related Record Field"), {
      value: action.relatedFieldId,
    });
  }

  // Scoped to this action's block rather than the whole page: two actions
  // in the same test can legitimately target the same field id (e.g. two
  // update_record actions on the same trigger entity), which would
  // otherwise make the page-wide workflowMappingType/etc. helpers ambiguous.
  for (const mapping of action.mappings) {
    await selectReactOption(
      block.locator(`select[name^="mappingType:"][name$=":${mapping.target.id}"]`),
      { value: mapping.type },
    );

    if (mapping.type === "constant") {
      const constantLocator = block.locator(
        `[name^="constantValue:"][name$=":${mapping.target.id}"]`,
      );

      if (mapping.target.type === "relation") {
        await selectReactOption(constantLocator, { value: mapping.value });
      } else {
        await constantLocator.fill(mapping.value);
      }
    } else {
      await selectReactOption(
        block.locator(
          `select[name^="sourceFieldDefinitionId:"][name$=":${mapping.target.id}"]`,
        ),
        { value: mapping.source.id },
      );
    }
  }
}

async function createMultiActionWorkflow({
  page,
  workflowName,
  fixture,
  triggerType = "record_created",
  watchedFields = [],
  conditions = [],
  actionsInput,
}: {
  page: Page;
  workflowName: string;
  fixture: WorkflowFixture;
  triggerType?: "record_created" | "record_updated";
  watchedFields?: TestField[];
  conditions?: Array<{ field: TestField; operator: string; value?: string }>;
  actionsInput: ActionInput[];
}) {
  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Automation Name").fill(workflowName);

  if (triggerType === "record_updated") {
    await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
      value: "record_updated",
    });
  }

  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.deliverable.id,
  });

  for (const watchedField of watchedFields) {
    await page
      .locator(
        `input[name="watchedFieldDefinitionId"][value="${watchedField.id}"]`,
      )
      .check();
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

  for (const [index, action] of actionsInput.entries()) {
    await configureAction({ page, index, action });
  }

  await page.getByRole("button", { name: "Create Automation" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();
}

async function createDeliverable({
  page,
  fixture,
  name,
  status = "Draft",
  clientLabel,
}: {
  page: Page;
  fixture: WorkflowFixture;
  name: string;
  status?: string;
  clientLabel: string;
}) {
  await gotoEntity(page, fixture.deliverable);
  const form = addRecordSection(page, fixture.deliverable);
  await fillRecordField(form, fixture.deliverable.fields.name, name);
  await fillRecordField(form, fixture.deliverable.fields.status, status);
  await chooseRecordField(form, fixture.deliverable.fields.client, clientLabel);
  await submitAddRecord(page, fixture.deliverable);
  await expect(page.getByText(`${fixture.deliverable.name} created.`)).toBeVisible();
}

async function editDeliverableStatus({
  page,
  fixture,
  name,
  status,
}: {
  page: Page;
  fixture: WorkflowFixture;
  name: string;
  status: string;
}) {
  await gotoEntity(page, fixture.deliverable);
  await editRecordFromRow(page, rowForText(page, name), name);
  await expect(
    page.getByRole("heading", {
      name: `Edit ${fixture.deliverable.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(`[name="${fixture.deliverable.fields.status.key}"]`)
    .fill(status);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(
    page.getByRole("heading", { name: fixture.deliverable.name, exact: true }),
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

async function expectTaskExists({
  page,
  fixture,
  title,
  text,
}: {
  page: Page;
  fixture: WorkflowFixture;
  title: string;
  text?: string;
}) {
  await gotoEntity(page, fixture.task);
  await expectTableValue(page, title);

  if (text) {
    await expect(rowForText(page, title)).toContainText(text);
  }
}

async function expectTaskMissing({
  page,
  fixture,
  title,
}: {
  page: Page;
  fixture: WorkflowFixture;
  title: string;
}) {
  await gotoEntity(page, fixture.task);
  await expect(rowForText(page, title)).toHaveCount(0);
}

test("three actions execute in order, each seeing earlier actions' effects, with conditions evaluated once", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Three Action Chain`;
  const deliverableName = `${run.label} Chain Deliverable`;

  await createMultiActionWorkflow({
    page,
    workflowName,
    fixture,
    triggerType: "record_updated",
    watchedFields: [fixture.deliverable.fields.status],
    conditions: [
      { field: fixture.deliverable.fields.status, operator: "equals", value: "Approved" },
    ],
    actionsInput: [
      {
        actionType: "update_record",
        mappings: [
          { target: fixture.deliverable.fields.status, type: "constant", value: "Processed" },
        ],
      },
      {
        actionType: "create_record",
        targetEntityId: fixture.task.id,
        mappings: [
          {
            target: fixture.task.fields.title,
            type: "source_field",
            source: fixture.deliverable.fields.name,
          },
          {
            target: fixture.task.fields.status,
            type: "source_field",
            source: fixture.deliverable.fields.status,
          },
          {
            target: fixture.task.fields.client,
            type: "source_field",
            source: fixture.deliverable.fields.client,
          },
        ],
      },
      {
        actionType: "update_related_record",
        relatedFieldId: fixture.deliverable.fields.client.id,
        mappings: [
          { target: fixture.client.fields.tier, type: "constant", value: "Priority" },
        ],
      },
    ],
  });

  await createDeliverable({
    page,
    fixture,
    name: deliverableName,
    status: "Draft",
    clientLabel: `${run.label} Acme`,
  });
  await editDeliverableStatus({
    page,
    fixture,
    name: deliverableName,
    status: "Approved",
  });

  // Action 2 mapped Task.status from the trigger record's status. If it had
  // seen the original "Approved" value instead of action 1's own write, this
  // would read "Approved" instead of "Processed".
  await expectTaskExists({
    page,
    fixture,
    title: deliverableName,
    text: "Processed",
  });

  await gotoEntity(page, fixture.client);
  await expect(rowForText(page, `${run.label} Acme`)).toContainText("Priority");

  await expectWorkflowLog({ page, workflowName, status: "succeeded" });

  // The condition matched "Approved" at trigger time. Action 1 then changed
  // status to "Processed". Actions 2 and 3 still ran, proving the condition
  // was not re-evaluated against that later state.
  await gotoEntity(page, fixture.deliverable);
  await expect(rowForText(page, deliverableName)).toContainText("Processed");
});

test("a failing action stops later actions but keeps earlier writes, and the log identifies the failed action", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Middle Action Fails`;
  const deliverableName = `${run.label} Failing Chain Deliverable`;

  await createMultiActionWorkflow({
    page,
    workflowName,
    fixture,
    triggerType: "record_updated",
    watchedFields: [fixture.deliverable.fields.status],
    actionsInput: [
      {
        actionType: "update_record",
        mappings: [
          { target: fixture.deliverable.fields.status, type: "constant", value: "Touched" },
        ],
      },
      {
        actionType: "update_related_record",
        relatedFieldId: fixture.deliverable.fields.client.id,
        mappings: [
          { target: fixture.client.fields.tier, type: "constant", value: "Should Not Apply" },
        ],
      },
      {
        actionType: "create_record",
        targetEntityId: fixture.task.id,
        mappings: [
          {
            target: fixture.task.fields.title,
            type: "source_field",
            source: fixture.deliverable.fields.name,
          },
          { target: fixture.task.fields.status, type: "constant", value: "Should not exist" },
        ],
      },
    ],
  });

  // Create the record while the related client is still active, then
  // archive that client record (not the field) so action 2's related
  // target resolves but is archived — this deliberately avoids archiving
  // any deliverable field, since a field archived while merely
  // "leave_unchanged" in action 1's default mapping set would trip an
  // unrelated, pre-existing archived-target-field check on action 1 itself.
  await createDeliverable({
    page,
    fixture,
    name: deliverableName,
    clientLabel: `${run.label} Acme`,
  });
  const supabase = createSupabaseTestClient();
  await supabase
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", fixture.clientRecordId);
  await editDeliverableStatus({
    page,
    fixture,
    name: deliverableName,
    status: "Edited",
  });

  // Action 1 (update_record) should have committed even though the overall
  // run later failed — no cross-action rollback.
  await gotoEntity(page, fixture.deliverable);
  await expect(rowForText(page, deliverableName)).toContainText("Touched");

  // Action 3 (create_record) never ran because action 2 failed first.
  await expectTaskMissing({ page, fixture, title: deliverableName });

  await expectWorkflowLog({
    page,
    workflowName,
    status: "failed",
    message: "Action 2 (update_related_record)",
  });

  // The execution log UI exposes the ordered per-action breakdown for a
  // multi-action run: action 1 succeeded, action 2 failed with its own
  // error, and action 3 (never reached) has no entry at all.
  const failedRow = workflowLogRow(page, workflowName, "failed");
  await expect(failedRow).toContainText("Action 1 (update_record): succeeded");
  await expect(failedRow).toContainText(
    "Action 2 (update_related_record): failed — Workflow related target record is archived.",
  );
  await expect(failedRow).not.toContainText("Action 3");
});

test("reordering actions with Move Up changes execution order", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Reordered Actions`;
  const deliverableName = `${run.label} Reorder Deliverable`;

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Automation Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.deliverable.id,
  });

  await configureAction({
    page,
    index: 0,
    action: {
      actionType: "update_record",
      mappings: [
        { target: fixture.deliverable.fields.status, type: "constant", value: "First" },
      ],
    },
  });
  await configureAction({
    page,
    index: 1,
    action: {
      actionType: "update_record",
      mappings: [
        { target: fixture.deliverable.fields.status, type: "constant", value: "Second" },
      ],
    },
  });

  // Swap so the "Second" action runs first and "First" runs last — the
  // final status should end up "First" instead of the unswapped "Second".
  await actionBlock(page, 1).getByRole("button", { name: "Move Up" }).click();

  await page.getByRole("button", { name: "Create Automation" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();

  await createDeliverable({
    page,
    fixture,
    name: deliverableName,
    clientLabel: `${run.label} Acme`,
  });

  await gotoEntity(page, fixture.deliverable);
  await expect(rowForText(page, deliverableName)).toContainText("First");
});

test("removing an action before saving means it never executes", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Removed Action`;
  const deliverableName = `${run.label} Removed Action Deliverable`;

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Automation Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.deliverable.id,
  });

  await configureAction({
    page,
    index: 0,
    action: {
      actionType: "update_record",
      mappings: [
        { target: fixture.deliverable.fields.status, type: "constant", value: "Kept" },
      ],
    },
  });
  await configureAction({
    page,
    index: 1,
    action: {
      actionType: "create_record",
      targetEntityId: fixture.task.id,
      mappings: [
        {
          target: fixture.task.fields.title,
          type: "source_field",
          source: fixture.deliverable.fields.name,
        },
      ],
    },
  });

  await actionBlock(page, 1)
    .getByRole("button", { name: "Remove Action" })
    .click();

  await page.getByRole("button", { name: "Create Automation" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();

  await createDeliverable({
    page,
    fixture,
    name: deliverableName,
    clientLabel: `${run.label} Acme`,
  });

  await gotoEntity(page, fixture.deliverable);
  await expect(rowForText(page, deliverableName)).toContainText("Kept");
  await expectTaskMissing({ page, fixture, title: deliverableName });
});

test("a legacy single-action workflow migrated to actions[] still loads, edits, and executes", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Legacy Single Action`;
  const deliverableName = `${run.label} Legacy Deliverable`;
  const supabase = createSupabaseTestClient();

  // Mirrors exactly what the 0019 migration's backfill produces for a
  // pre-existing single-action workflow: one element in actions[], and
  // action_config narrowed to only triggerConfig/conditions.
  const { data: workflow, error: workflowError } = await supabase
    .from("workflows")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      name: workflowName,
      enabled: true,
      trigger_type: "record_created",
      trigger_entity_type_id: fixture.deliverable.id,
      action_config: {},
      actions: [
        {
          actionType: "update_record",
          fieldMappings: [
            {
              targetFieldDefinitionId: fixture.deliverable.fields.status.id,
              source: { type: "constant", value: "Legacy Applied" },
            },
          ],
        },
      ],
    })
    .select("id")
    .single();
  expect(workflowError).toBeNull();

  await page.goto(`/workflows/${workflow!.id}/edit`);
  await expect(page.getByLabel("Automation Name")).toHaveValue(workflowName);
  await expect(
    actionBlock(page, 0).getByLabel("Action", { exact: true }),
  ).toHaveValue("update_record");
  await expect(workflowMappingType(page, fixture.deliverable.fields.status)).toHaveValue(
    "constant",
  );
  await expect(
    workflowConstantValue(page, fixture.deliverable.fields.status),
  ).toHaveValue("Legacy Applied");

  await page.getByLabel("Automation Name").fill(`${workflowName} Edited`);
  await page.getByRole("button", { name: "Save Automation" }).click();
  await expect(
    page.getByRole("link", { name: `${workflowName} Edited` }),
  ).toBeVisible();

  await createDeliverable({
    page,
    fixture,
    name: deliverableName,
    clientLabel: `${run.label} Acme`,
  });

  await gotoEntity(page, fixture.deliverable);
  await expect(rowForText(page, deliverableName)).toContainText("Legacy Applied");
});

test("submitting a duplicate actionId is rejected server-side", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Duplicate Action Id`;

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Automation Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.deliverable.id,
  });

  // The UI can never produce two actions sharing an id — simulate crafted
  // form data by cloning the first action's hidden actionId input so the
  // submission carries a duplicate, and confirm the server rejects it
  // instead of silently collapsing the two actions into one.
  const firstActionId = await page
    .locator('input[name="actionId"]')
    .first()
    .inputValue();
  const createButton = page.getByRole("button", { name: "Create Automation" });

  // Scope to the submit button's own form — the page also renders the
  // workspace navigation's search form earlier in the DOM, which a bare
  // document.querySelector("form") would grab instead.
  await createButton.evaluate((button, actionId) => {
    const clone = document.createElement("input");
    clone.type = "hidden";
    clone.name = "actionId";
    clone.value = actionId;
    button.closest("form")?.appendChild(clone);
  }, firstActionId);

  await createButton.click();

  await expect(
    page.getByText("Workflow actions must have unique identifiers."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: workflowName })).toHaveCount(0);
});

test("an entity targeted by a create_record action cannot be hard-deleted until the dependency is removed", async ({
  page,
}) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Target Entity Guard`;

  await createMultiActionWorkflow({
    page,
    workflowName,
    fixture,
    actionsInput: [
      {
        actionType: "create_record",
        targetEntityId: fixture.task.id,
        mappings: [
          {
            target: fixture.task.fields.title,
            type: "source_field",
            source: fixture.deliverable.fields.name,
          },
        ],
      },
    ],
  });

  // fixture.task has zero records — the only reason it can't be deleted is
  // that a workflow action still creates records in it.
  await page.goto(`/entities/${fixture.task.id}?manage=true`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Entity" }).click();
  await expect(page.getByText(/Cannot delete/)).toBeVisible();
  await expect(page.getByText(new RegExp(workflowName))).toBeVisible();
  await expect(
    page.getByRole("heading", { name: fixture.task.name, exact: true }),
  ).toBeVisible();

  // Removing the dependency (deleting the workflow) unblocks deletion.
  await page.goto("/workflows");
  const workflowRow = page.getByRole("row").filter({ hasText: workflowName });
  page.once("dialog", (dialog) => dialog.accept());
  await workflowRow.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toHaveCount(0);

  await page.goto(`/entities/${fixture.task.id}?manage=true`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Entity" }).click();
  await expect(page).toHaveURL("/");
});
