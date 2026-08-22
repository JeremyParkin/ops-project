import { expect, type Page, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntityRecord,
  createRelatedRecordWorkflowFixture,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type RelatedRecordWorkflowFixture,
  type TestRun,
} from "./helpers/supabase-test-data";
import { executeRecordUpdatedWorkflows } from "@/lib/domain/workflow-engine";
import {
  addRecordSection,
  chooseRecordField,
  fillRecordField,
  gotoEntity,
  rowForText,
  selectReactOption,
  submitAddRecord,
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

async function createScenario() {
  const run = createTestRun();
  runs.push(run);
  return { run, fixture: await createRelatedRecordWorkflowFixture(run) };
}

async function createRelatedWorkflow({
  page,
  fixture,
  workflowName,
  mappingType = "source_field",
  triggerType = "record_created",
  expectCreated = true,
}: {
  page: Page;
  fixture: RelatedRecordWorkflowFixture;
  workflowName: string;
  mappingType?: "source_field" | "constant" | "leave_unchanged";
  triggerType?: "record_created" | "record_updated";
  expectCreated?: boolean;
}) {
  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Workflow Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
    value: triggerType,
  });
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: fixture.deliverable.id,
  });
  await selectReactOption(page.getByLabel("Action", { exact: true }), {
    value: "update_related_record",
  });
  await selectReactOption(page.getByLabel("Related Record Field"), {
    value: fixture.deliverable.fields.client.id,
  });
  await expect(page.getByText(`Updates one related ${fixture.client.name} record.`)).toBeVisible();
  await selectReactOption(
    workflowMappingType(page, fixture.client.fields.last_status),
    { value: mappingType },
  );

  if (triggerType === "record_updated") {
    await page
      .locator(
        `input[name="watchedFieldDefinitionId"][value="${fixture.deliverable.fields.status.id}"]`,
      )
      .check();
  }

  if (mappingType === "source_field") {
    await selectReactOption(
      workflowSourceField(page, fixture.client.fields.last_status),
      { value: fixture.deliverable.fields.status.id },
    );
  }

  await page.getByRole("button", { name: "Create Workflow" }).click();
  if (expectCreated) {
    await expect(page.getByRole("link", { name: workflowName })).toBeVisible();
  }
}

async function createDeliverable({
  page,
  fixture,
  name,
  status,
  clientLabel,
}: {
  page: Page;
  fixture: RelatedRecordWorkflowFixture;
  name: string;
  status: string;
  clientLabel?: string;
}) {
  await gotoEntity(page, fixture.deliverable);
  const form = addRecordSection(page, fixture.deliverable);
  await fillRecordField(form, fixture.deliverable.fields.name, name);
  await fillRecordField(form, fixture.deliverable.fields.status, status);
  if (clientLabel) {
    await chooseRecordField(form, fixture.deliverable.fields.client, clientLabel);
  }
  await submitAddRecord(page, fixture.deliverable);
}

async function executeDirectRelatedRecordWorkflow({
  fixture,
  workflowName,
  archiveRelatedField = false,
  archiveTargetRecord = false,
}: {
  fixture: RelatedRecordWorkflowFixture;
  workflowName: string;
  archiveRelatedField?: boolean;
  archiveTargetRecord?: boolean;
}) {
  const supabase = createSupabaseTestClient();
  const sourceRecordId = await createEntityRecord({
    entity: fixture.deliverable,
    valuesBySlug: { name: `${workflowName} Source`, status: "Complete" },
    relationsBySlug: { client: fixture.firstClientRecordId },
  });
  const { data: workflow, error: workflowError } = await supabase
    .from("workflows")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      name: workflowName,
      enabled: true,
      trigger_type: "record_updated",
      trigger_entity_type_id: fixture.deliverable.id,
      action_type: "update_related_record",
      action_target_entity_type_id: null,
      action_config: {
        relatedFieldDefinitionId: fixture.deliverable.fields.client.id,
        triggerConfig: {
          watchedFieldDefinitionIds: [fixture.deliverable.fields.name.id],
        },
        conditions: [],
        fieldMappings: [
          {
            targetFieldDefinitionId: fixture.client.fields.last_status.id,
            source: {
              type: "source_field",
              sourceFieldDefinitionId: fixture.deliverable.fields.status.id,
            },
          },
        ],
      },
    })
    .select("id")
    .single();
  expect(workflowError).toBeNull();

  if (archiveRelatedField) {
    await supabase
      .from("field_definitions")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", fixture.deliverable.fields.client.id);
  }

  if (archiveTargetRecord) {
    await supabase
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", fixture.firstClientRecordId);
  }

  await executeRecordUpdatedWorkflows({
    workspaceId: DEMO_WORKSPACE_ID,
    triggerEntityTypeId: fixture.deliverable.id,
    triggerRecord: {
      id: sourceRecordId,
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: fixture.deliverable.id,
      values: {
        [fixture.deliverable.fields.name.key]: `${workflowName} Source`,
        [fixture.deliverable.fields.status.key]: "Complete",
        [fixture.deliverable.fields.client.key]: fixture.firstClientRecordId,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    changedFieldDefinitionIds: [fixture.deliverable.fields.name.id],
  });

  const { data: log, error: logError } = await supabase
    .from("workflow_execution_logs")
    .select("action_entity_type_id, action_record_id, error_message")
    .eq("workflow_id", workflow!.id)
    .single();
  expect(logError).toBeNull();
  return log;
}

test("updates the current related record from a triggering source field", async ({ page }) => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Update Client Status`;
  await createRelatedWorkflow({ page, fixture, workflowName });
  await createDeliverable({
    page,
    fixture,
    name: `${run.label} Launch`,
    status: "Complete",
    clientLabel: `${run.label} Acme`,
  });

  await expect(page.getByText(/1 workflow succeeded/)).toBeVisible();
  await gotoEntity(page, fixture.client);
  await expect(rowForText(page, `${run.label} Acme`)).toContainText("Complete");
  await page.goto("/workflows");
  await expect(page.getByRole("row").filter({ hasText: workflowName }).filter({ hasText: "succeeded" })).toBeVisible();
});

test("rejects an all-leave-unchanged related-record configuration", async ({ page }) => {
  const { run, fixture } = await createScenario();
  await createRelatedWorkflow({
    page,
    fixture,
    workflowName: `${run.label} Invalid Empty Update`,
    mappingType: "leave_unchanged",
    expectCreated: false,
  });
  await expect(page.getByText("Configure at least one field to update.")).toBeVisible();
});

test("logs a resolved archived related target when execution fails", async () => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Archived Target`;
  const log = await executeDirectRelatedRecordWorkflow({
    fixture,
    workflowName,
    archiveTargetRecord: true,
  });
  expect(log).toMatchObject({
    action_entity_type_id: fixture.client.id,
    action_record_id: fixture.firstClientRecordId,
    error_message: "Workflow related target record is archived.",
  });
});

test("fails when the configured related field is archived", async () => {
  const { run, fixture } = await createScenario();
  const workflowName = `${run.label} Archived Relation`;
  const log = await executeDirectRelatedRecordWorkflow({
    fixture,
    workflowName,
    archiveRelatedField: true,
  });
  expect(log?.error_message).toContain("archived related field");
});
