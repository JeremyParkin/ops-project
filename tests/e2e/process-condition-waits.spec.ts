import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestEntity,
  type TestRun,
} from "./helpers/supabase-test-data";
import { requireE2eEnv } from "./helpers/env";
import { expectAfterMutation } from "./helpers/ui";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const E2E_RUNNER_PASSWORD = "E2E-runner-password-2026";

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function authenticatedClient() {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: E2E_RUNNER_EMAIL,
    password: E2E_RUNNER_PASSWORD,
  });
  if (error) throw new Error(`Unable to sign in as E2E runner: ${error.message}`);
  return client;
}

async function createConditionTemplate({
  entity,
  config,
  run,
}: {
  entity: TestEntity;
  config: Record<string, unknown>;
  run: TestRun;
}) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const conditionNodeId = randomUUID();
  const nextNodeId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Condition wait`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);
  const { error: nodeError } = await admin.from("process_nodes").insert([
    {
      id: conditionNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "condition_wait",
      name: "Wait for readiness",
      position: 1,
      config,
    },
    {
      id: nextNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name: "Continue",
      position: 2,
      config: {},
    },
  ]);
  if (nodeError) throw new Error(nodeError.message);
  const { error: edgeError } = await admin.from("process_edges").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    source_node_id: conditionNodeId,
    target_node_id: nextNodeId,
    priority: 0,
    condition_config: null,
    is_default: true,
    is_parallel: false,
  });
  if (edgeError) throw new Error(edgeError.message);
  return { templateId, conditionNodeId, nextNodeId };
}

async function startRun(client: Awaited<ReturnType<typeof authenticatedClient>>, entity: TestEntity, recordId: string, templateId: string) {
  const { data, error } = await client.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: templateId,
    p_origin_entity_type_id: entity.id,
    p_origin_record_id: recordId,
  });
  if (error || typeof data !== "string") throw new Error(error?.message ?? "Unable to start process run");
  return data;
}

async function stepsForRun(runId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("process_step_runs")
    .select("*")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", runId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function dependenciesForStep(stepRunId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("process_condition_wait_dependencies")
    .select("*")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("step_run_id", stepRunId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function dispatchWakeups() {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.rpc("dispatch_process_condition_wait_wakeups_system", { p_limit: 100 });
  if (error) throw new Error(error.message);
  return data;
}

async function updateValues(
  client: Awaited<ReturnType<typeof authenticatedClient>>,
  entity: TestEntity,
  recordId: string,
  values: Record<string, unknown>,
  relations: unknown[] = [],
  relationFieldIds: string[] = [],
) {
  const { error } = await client.rpc("update_entity_record_with_relations_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_record_id: recordId,
    p_values: values,
    p_relation_field_ids: relationFieldIds,
    p_relations: relations,
  });
  if (error) throw new Error(error.message);
}

test.beforeAll(async () => cleanupStaleE2eData());
test.afterAll(async () => {
  for (const run of runs) await cleanupE2eRun(run);
});

test("activates already-true waits immediately and resumes false waits only after a qualifying canonical record update", async () => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Case", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "ready", name: "Ready", type: "boolean" },
  ]);
  const readyRecordId = await createEntityRecord({ entity, valuesBySlug: { name: "Ready", ready: true } });
  const waitingRecordId = await createEntityRecord({ entity, valuesBySlug: { name: "Waiting", ready: false } });
  const template = await createConditionTemplate({
    entity,
    run,
    config: {
      condition_wait_rule: {
        target: { kind: "origin" },
        conditions: [{ sourceFieldDefinitionId: entity.fields.ready.id, operator: "equals", value: true }],
      },
    },
  });
  const client = await authenticatedClient();
  const readyRunId = await startRun(client, entity, readyRecordId, template.templateId);
  const readySteps = await stepsForRun(readyRunId);
  expect(readySteps.find((step) => step.source_node_id === template.conditionNodeId)?.status).toBe("completed");
  expect(readySteps.find((step) => step.source_node_id === template.nextNodeId)?.status).toBe("active");
  expect(await dependenciesForStep(readySteps.find((step) => step.source_node_id === template.conditionNodeId)!.id)).toHaveLength(0);

  const waitingRunId = await startRun(client, entity, waitingRecordId, template.templateId);
  const waitingStep = (await stepsForRun(waitingRunId)).find((step) => step.source_node_id === template.conditionNodeId)!;
  expect(waitingStep.status).toBe("active");
  expect(await dependenciesForStep(waitingStep.id)).toHaveLength(1);

  await updateValues(client, entity, waitingRecordId, {
    [entity.fields.name.key]: "Waiting renamed",
    [entity.fields.ready.key]: false,
  });
  await dispatchWakeups();
  expect((await stepsForRun(waitingRunId)).find((step) => step.id === waitingStep.id)?.status).toBe("active");

  await updateValues(client, entity, waitingRecordId, {
    [entity.fields.name.key]: "Ready now",
    [entity.fields.ready.key]: true,
  });
  const batches = await Promise.all([dispatchWakeups(), dispatchWakeups()]);
  expect(batches.reduce((total, batch) => total + Number(batch?.resolved ?? 0), 0)).toBe(1);
  const resolved = await stepsForRun(waitingRunId);
  expect(resolved.find((step) => step.id === waitingStep.id)?.status).toBe("completed");
  expect(resolved.find((step) => step.source_node_id === template.nextNodeId)?.status).toBe("active");
  expect(await dependenciesForStep(waitingStep.id)).toHaveLength(0);
  expect(
    (await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: waitingRunId,
      p_step_run_id: waitingStep.id,
    })).error?.message,
  ).toContain("advance automatically");
});

test("rebinds a related condition wait from A to B and ignores later changes to A", async () => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const clientEntity = await createEntity(admin, run, "Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "approved", name: "Approved", type: "boolean" },
  ]);
  const taskEntity = await createEntity(admin, run, "Task", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "client", name: "Client", type: "relation", relatedEntityTypeId: clientEntity.id },
  ]);
  const clientA = await createEntityRecord({ entity: clientEntity, valuesBySlug: { name: "A", approved: false } });
  const clientB = await createEntityRecord({ entity: clientEntity, valuesBySlug: { name: "B", approved: false } });
  const taskRecordId = await createEntityRecord({ entity: taskEntity, valuesBySlug: { name: "Task" }, relationsBySlug: { client: clientA } });
  const template = await createConditionTemplate({
    entity: taskEntity,
    run,
    config: {
      condition_wait_rule: {
        target: {
          kind: "related",
          relation_field_definition_id: taskEntity.fields.client.id,
          target_entity_type_id: clientEntity.id,
        },
        conditions: [{ sourceFieldDefinitionId: clientEntity.fields.approved.id, operator: "equals", value: true }],
      },
    },
  });
  const client = await authenticatedClient();
  const runId = await startRun(client, taskEntity, taskRecordId, template.templateId);
  const conditionStep = (await stepsForRun(runId)).find((step) => step.source_node_id === template.conditionNodeId)!;
  expect((await dependenciesForStep(conditionStep.id)).some((dependency) => dependency.watched_record_id === clientA)).toBeTruthy();

  await updateValues(
    client,
    taskEntity,
    taskRecordId,
    { [taskEntity.fields.name.key]: "Task" },
    [{ field_definition_id: taskEntity.fields.client.id, target_entity_type_id: clientEntity.id, target_record_id: clientB }],
    [taskEntity.fields.client.id],
  );
  await dispatchWakeups();
  const reboundDependencies = await dependenciesForStep(conditionStep.id);
  expect(reboundDependencies.some((dependency) => dependency.watched_record_id === clientA)).toBeFalsy();
  expect(reboundDependencies.some((dependency) => dependency.watched_record_id === clientB)).toBeTruthy();

  await updateValues(client, clientEntity, clientA, {
    [clientEntity.fields.name.key]: "A",
    [clientEntity.fields.approved.key]: true,
  });
  await dispatchWakeups();
  expect((await stepsForRun(runId)).find((step) => step.id === conditionStep.id)?.status).toBe("active");

  await updateValues(client, clientEntity, clientB, {
    [clientEntity.fields.name.key]: "B",
    [clientEntity.fields.approved.key]: true,
  });
  await dispatchWakeups();
  expect((await stepsForRun(runId)).find((step) => step.id === conditionStep.id)?.status).toBe("completed");
  expect(await dependenciesForStep(conditionStep.id)).toHaveLength(0);
});

test("resumes a condition wait after a workflow-originated record update", async ({ page }) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Workflow case", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "trigger", name: "Trigger", type: "text" },
    { slug: "ready", name: "Ready", type: "boolean" },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: "Workflow waiting", trigger: "", ready: false },
  });
  const template = await createConditionTemplate({
    entity,
    run,
    config: {
      condition_wait_rule: {
        target: { kind: "origin" },
        conditions: [
          {
            sourceFieldDefinitionId: entity.fields.ready.id,
            operator: "equals",
            value: true,
          },
        ],
      },
    },
  });
  const { error: workflowError } = await admin.from("workflows").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Set ready`,
    enabled: true,
    trigger_type: "record_updated",
    trigger_entity_type_id: entity.id,
    action_config: {
      triggerConfig: { watchedFieldDefinitionIds: [entity.fields.trigger.id] },
      conditions: [],
    },
    actions: [
      {
        actionType: "update_record",
        fieldMappings: [
          {
            targetFieldDefinitionId: entity.fields.ready.id,
            source: { type: "constant", value: true },
          },
        ],
      },
    ],
  });
  expect(workflowError).toBeNull();

  const client = await authenticatedClient();
  const processRunId = await startRun(client, entity, recordId, template.templateId);
  const conditionStep = (await stepsForRun(processRunId)).find(
    (step) => step.source_node_id === template.conditionNodeId,
  )!;
  expect(conditionStep.status).toBe("active");

  await page.goto(`/entities/${entity.id}/records/${recordId}/edit`);
  await page.locator(`[name="${entity.fields.trigger.key}"]`).fill("go");
  await page.getByRole("button", { name: "Save Changes" }).click();
  // Post-submit: record-edit's Server Action redirects back to the entity
  // page, which re-fetches and re-renders -- occasionally exceeds the
  // default 5s timeout under full-suite load (documented flake history).
  await expectAfterMutation(page.getByRole("heading", { name: entity.name, exact: true }));

  await dispatchWakeups();
  expect((await stepsForRun(processRunId)).find((step) => step.id === conditionStep.id)?.status).toBe("completed");
  expect(await dependenciesForStep(conditionStep.id)).toHaveLength(0);
});

test("keeps dispatcher execution service-only", async () => {
  const client = await authenticatedClient();
  expect((await client.rpc("dispatch_process_condition_wait_wakeups_system", { p_limit: 1 })).error?.message).toContain("permission denied");
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const anonymousClient = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  expect((await anonymousClient.rpc("dispatch_process_condition_wait_wakeups_system", { p_limit: 1 })).error?.message).toContain("permission denied");
  await expect(dispatchWakeups()).resolves.toBeTruthy();
});
