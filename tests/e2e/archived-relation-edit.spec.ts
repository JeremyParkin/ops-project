import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntityRecord,
  createRelatedRecordWorkflowFixture,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestRun,
} from "./helpers/supabase-test-data";

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

test("preserves an archived relation while saving an unrelated primitive edit", async ({
  page,
}) => {
  const run = createTestRun();
  runs.push(run);
  const fixture = await createRelatedRecordWorkflowFixture(run);
  const sourceRecordId = await createEntityRecord({
    entity: fixture.deliverable,
    valuesBySlug: {
      name: `${run.label} Deliverable`,
      status: "Draft",
    },
    relationsBySlug: {
      client: fixture.firstClientRecordId,
    },
  });
  const supabase = createSupabaseTestClient();
  const archivedAt = new Date().toISOString();

  await supabase
    .from("entity_records")
    .update({ archived_at: archivedAt })
    .eq("id", fixture.firstClientRecordId);

  await page.goto(
    `/entities/${fixture.deliverable.id}/records/${sourceRecordId}/edit`,
  );
  const relationControl = page.locator(
    `[name="${fixture.deliverable.fields.client.key}"]`,
  );
  await expect(relationControl).toHaveValue(fixture.firstClientRecordId);
  await expect(relationControl).toContainText("(Archived)");
  const statusControl = page.locator(
    `[name="${fixture.deliverable.fields.status.key}"]`,
  );
  await statusControl.fill("Complete");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForURL(`/entities/${fixture.deliverable.id}`);

  await expect
    .poll(async () => {
      const { data, error } = await supabase
        .from("entity_records")
        .select("values")
        .eq("id", sourceRecordId)
        .single();

      expect(error).toBeNull();
      return data?.values[fixture.deliverable.fields.status.key];
    })
    .toBe("Complete");

  const { data: relation, error: relationError } = await supabase
    .from("entity_record_relation_values")
    .select("target_record_id")
    .eq("source_record_id", sourceRecordId)
    .eq("field_definition_id", fixture.deliverable.fields.client.id)
    .single();

  expect(relationError).toBeNull();
  expect(relation?.target_record_id).toBe(fixture.firstClientRecordId);
});

test("keeps the source edit when a related-record workflow fails for its archived target", async ({
  page,
}) => {
  const run = createTestRun();
  runs.push(run);
  const fixture = await createRelatedRecordWorkflowFixture(run);
  const sourceRecordId = await createEntityRecord({
    entity: fixture.deliverable,
    valuesBySlug: {
      name: `${run.label} Workflow Deliverable`,
      status: "Draft",
    },
    relationsBySlug: {
      client: fixture.firstClientRecordId,
    },
  });
  const supabase = createSupabaseTestClient();
  const workflowName = `${run.label} Archived Target Does Not Roll Back`;
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
          watchedFieldDefinitionIds: [fixture.deliverable.fields.status.id],
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
  await supabase
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", fixture.firstClientRecordId);

  await page.goto(
    `/entities/${fixture.deliverable.id}/records/${sourceRecordId}/edit`,
  );
  await page
    .locator(`[name="${fixture.deliverable.fields.status.key}"]`)
    .fill("Complete");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForURL(`/entities/${fixture.deliverable.id}`);

  await expect
    .poll(async () => {
      const { data, error } = await supabase
        .from("entity_records")
        .select("values")
        .eq("id", sourceRecordId)
        .single();

      expect(error).toBeNull();
      return data?.values[fixture.deliverable.fields.status.key];
    })
    .toBe("Complete");

  const { data: log, error: logError } = await supabase
    .from("workflow_execution_logs")
    .select("status,error_message,action_entity_type_id,action_record_id")
    .eq("workflow_id", workflow!.id)
    .single();

  expect(logError).toBeNull();
  expect(log).toMatchObject({
    status: "failed",
    error_message: "Workflow related target record is archived.",
    action_entity_type_id: fixture.client.id,
    action_record_id: fixture.firstClientRecordId,
  });
});
