import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestEntity,
  type TestRun,
} from "./helpers/supabase-test-data";
import { requireE2eEnv } from "./helpers/env";
import {
  validateWorkflowFormData,
  type EntityFieldContext,
} from "@/lib/domain/workflow-validation";
import type { ProcessTemplate } from "@/lib/domain/process-types";
import {
  addRecordSection,
  fillRecordField,
  gotoEntity,
  selectReactOption,
  submitAddRecord,
  waitForWorkflowFormReady,
} from "./helpers/ui";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const E2E_RUNNER_PASSWORD = "E2E-runner-password-2026";

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

async function createAuthenticatedTestClient() {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: E2E_RUNNER_EMAIL,
    password: E2E_RUNNER_PASSWORD,
  });

  if (error) {
    throw new Error(`Unable to sign in as E2E runner: ${error.message}`);
  }

  return client;
}

async function createTemplate({
  run,
  entity,
  suffix,
  archived = false,
  withApproval = false,
}: {
  run: TestRun;
  entity: TestEntity;
  suffix: string;
  archived?: boolean;
  withApproval?: boolean;
}) {
  const supabase = createSupabaseTestClient();
  const id = randomUUID();
  const name = `${run.label} ${suffix}`;
  const firstNodeId = randomUUID();
  const secondNodeId = randomUUID();
  const thirdNodeId = randomUUID();
  const approveOutcomeId = randomUUID();
  const rejectOutcomeId = randomUUID();
  const { error: templateError } = await supabase.from("process_templates").insert({
    id,
    workspace_id: DEMO_WORKSPACE_ID,
    name,
    applies_to_entity_type_id: entity.id,
    archived_at: archived ? new Date().toISOString() : null,
  });

  if (templateError) {
    throw new Error(`Unable to create process template fixture: ${templateError.message}`);
  }

  const nodes = [
    {
      id: firstNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: id,
      node_type: withApproval ? "approval" : "human_task",
      name: withApproval ? "Approve" : "Prepare",
      position: 1,
      config: { due_rule: { amount: 4, unit: "hours" } },
    },
    {
      id: secondNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: id,
      node_type: "human_task",
      name: "Review",
      position: 2,
      config: {},
    },
    ...(withApproval
      ? [
          {
            id: thirdNodeId,
            workspace_id: DEMO_WORKSPACE_ID,
            process_template_id: id,
            node_type: "human_task",
            name: "Revise",
            position: 3,
            config: {},
          },
        ]
      : []),
  ];
  const { error: nodeError } = await supabase.from("process_nodes").insert(nodes);

  if (nodeError) {
    throw new Error(`Unable to create process step fixtures: ${nodeError.message}`);
  }

  const { error: edgeError } = await supabase.from("process_edges").insert(
    withApproval
      ? [
          {
            workspace_id: DEMO_WORKSPACE_ID,
            process_template_id: id,
            source_node_id: firstNodeId,
            target_node_id: secondNodeId,
            priority: 0,
            condition_config: null,
            is_default: false,
            is_parallel: false,
            approval_outcome_id: approveOutcomeId,
            approval_outcome_label: "Approve",
          },
          {
            workspace_id: DEMO_WORKSPACE_ID,
            process_template_id: id,
            source_node_id: firstNodeId,
            target_node_id: thirdNodeId,
            priority: 1,
            condition_config: null,
            is_default: false,
            is_parallel: false,
            approval_outcome_id: rejectOutcomeId,
            approval_outcome_label: "Reject",
          },
        ]
      : {
          workspace_id: DEMO_WORKSPACE_ID,
          process_template_id: id,
          source_node_id: firstNodeId,
          target_node_id: secondNodeId,
          priority: 0,
          is_default: true,
        },
  );

  if (edgeError) {
    throw new Error(`Unable to create process edge fixture: ${edgeError.message}`);
  }

  return {
    id,
    name,
    ...(withApproval
      ? { firstNodeId, outcomes: { approve: approveOutcomeId, reject: rejectOutcomeId } }
      : {}),
  };
}

async function createDeliverable(page: Parameters<typeof gotoEntity>[0], entity: TestEntity, name: string, type: string, status = "Draft") {
  await gotoEntity(page, entity);
  const form = addRecordSection(page, entity);
  await fillRecordField(form, entity.fields.name, name);
  await fillRecordField(form, entity.fields.type, type);
  await fillRecordField(form, entity.fields.status, status);
  await submitAddRecord(page, entity);
  await expect(page.getByText(`${entity.name} created.`)).toBeVisible();

  const supabase = createSupabaseTestClient();
  const { data, error } = await supabase
    .from("entity_records")
    .select("id, values")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`Unable to load created deliverable: ${error?.message ?? "missing"}`);
  }

  return data as { id: string; values: Record<string, string> };
}

async function createStartProcessWorkflow({
  page,
  name,
  entity,
  templateId,
  triggerType = "record_created",
}: {
  page: Parameters<typeof gotoEntity>[0];
  name: string;
  entity: TestEntity;
  templateId: string;
  triggerType?: "record_created" | "record_updated";
}) {
  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Workflow Name").fill(name);
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: entity.id,
  });

  if (triggerType === "record_updated") {
    await selectReactOption(page.getByLabel("Trigger", { exact: true }), {
      value: "record_updated",
    });
    await page
      .locator(`input[name="watchedFieldDefinitionId"][value="${entity.fields.status.id}"]`)
      .check();
  }

  await selectReactOption(page.getByLabel("Action", { exact: true }), {
    value: "start_process",
  });
  await selectReactOption(page.getByLabel("Process Template", { exact: true }), {
    value: templateId,
  });
  await page.getByRole("button", { name: "Create Workflow" }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();
}

async function getProcessRuns(templateId: string) {
  const supabase = createSupabaseTestClient();
  const { data, error } = await supabase
    .from("process_runs")
    .select("id, origin_record_id, status")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_template_id", templateId)
    .order("started_at", { ascending: true });

  if (error) {
    throw new Error(`Unable to read process runs: ${error.message}`);
  }

  return data ?? [];
}

test("Start Process lists compatible templates and starts the canonical snapshotted run", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const deliverable = await createEntity(supabase, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "type", name: "Type", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
  ]);
  const otherEntity = await createEntity(supabase, run, "Other", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const template = await createTemplate({ run, entity: deliverable, suffix: "Production" });
  const incompatibleTemplate = await createTemplate({ run, entity: otherEntity, suffix: "Other" });
  const archivedTemplate = await createTemplate({
    run,
    entity: deliverable,
    suffix: "Archived",
    archived: true,
  });
  const workflowName = `${run.label} Start Monthly Report`;

  await page.goto("/workflows/new");
  await page.waitForLoadState("networkidle");
  await waitForWorkflowFormReady(page);
  await page.getByLabel("Workflow Name").fill(workflowName);
  await selectReactOption(page.getByLabel("Trigger Entity", { exact: true }), {
    value: deliverable.id,
  });
  await selectReactOption(page.getByLabel("Action", { exact: true }), {
    value: "start_process",
  });
  const templateSelect = page.getByLabel("Process Template", { exact: true });
  await expect(templateSelect).toContainText(template.name);
  await expect(templateSelect).not.toContainText(incompatibleTemplate.name);
  await expect(templateSelect).not.toContainText(archivedTemplate.name);
  await selectReactOption(templateSelect, { value: template.id });
  await page.getByRole("button", { name: "Create Workflow" }).click();
  await expect(page.getByRole("link", { name: workflowName })).toBeVisible();

  const record = await createDeliverable(
    page,
    deliverable,
    `${run.label} June Report`,
    "Monthly Report",
  );

  await expect.poll(() => getProcessRuns(template.id)).toHaveLength(1);
  const [processRun] = await getProcessRuns(template.id);
  expect(processRun).toMatchObject({
    origin_record_id: record.id,
    status: "active",
  });

  const { data: stepRuns, error: stepRunError } = await supabase
    .from("process_step_runs")
    .select("name, status, config, started_at, due_at")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", processRun.id)
    .order("step_index", { ascending: true });
  expect(stepRunError).toBeNull();
  expect(stepRuns).toHaveLength(2);
  expect(stepRuns?.[0]).toMatchObject({
    name: "Prepare",
    status: "active",
    config: { due_rule: { amount: 4, unit: "hours" } },
  });
  expect(stepRuns?.[0].started_at).toBeTruthy();
  expect(stepRuns?.[0].due_at).toBeTruthy();
  expect(stepRuns?.[1]).toMatchObject({ name: "Review", status: "pending" });
  expect(stepRuns?.[1].due_at).toBeNull();

  const { data: workflow } = await supabase
    .from("workflows")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("name", workflowName)
    .single();
  const { data: log } = await supabase
    .from("workflow_execution_logs")
    .select("status, action_results")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("workflow_id", workflow?.id ?? "")
    .single();
  expect(log?.status).toBe("succeeded");
  expect(log?.action_results).toEqual([
    expect.objectContaining({
      index: 0,
      actionType: "start_process",
      status: "succeeded",
      processTemplateId: template.id,
      processRunId: processRun.id,
      originEntityTypeId: deliverable.id,
      originRecordId: record.id,
    }),
  ]);
});

test("workflow-triggered starts snapshot approval outcomes through the canonical start path", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const deliverable = await createEntity(supabase, run, "Approval Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "type", name: "Type", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
  ]);
  const template = await createTemplate({
    run,
    entity: deliverable,
    suffix: "Approval workflow",
    withApproval: true,
  });
  await createStartProcessWorkflow({
    page,
    name: `${run.label} Start approval workflow`,
    entity: deliverable,
    templateId: template.id,
  });
  await createDeliverable(page, deliverable, `${run.label} Approval record`, "Monthly Report");
  await expect.poll(() => getProcessRuns(template.id)).toHaveLength(1);
  const [processRun] = await getProcessRuns(template.id);
  const [{ data: steps, error: stepError }, { data: routes, error: routeError }] = await Promise.all([
    supabase
      .from("process_step_runs")
      .select("id, source_node_id, node_type, status, due_at")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", processRun.id),
    supabase
      .from("process_step_run_routes")
      .select("source_node_id, approval_outcome_id, approval_outcome_label")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", processRun.id),
  ]);
  expect(stepError).toBeNull();
  expect(routeError).toBeNull();
  expect(steps?.find((step) => step.source_node_id === template.firstNodeId)).toMatchObject({
    node_type: "approval",
    status: "active",
    due_at: expect.any(String),
  });
  expect(routes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ approval_outcome_id: template.outcomes?.approve, approval_outcome_label: "Approve" }),
      expect.objectContaining({ approval_outcome_id: template.outcomes?.reject, approval_outcome_label: "Reject" }),
    ]),
  );
});

test("Start Process supports record updates and duplicate active runs fail without a second run", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const deliverable = await createEntity(supabase, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "type", name: "Type", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
  ]);
  const template = await createTemplate({ run, entity: deliverable, suffix: "Update Run" });
  const workflowName = `${run.label} Start on Update`;
  await createStartProcessWorkflow({
    page,
    name: workflowName,
    entity: deliverable,
    templateId: template.id,
    triggerType: "record_updated",
  });
  const { error: workflowUpdateError } = await supabase
    .from("workflows")
    .update({
      actions: [
        {
          actionType: "update_record",
          fieldMappings: [
            {
              targetFieldDefinitionId: deliverable.fields.status.id,
              source: { type: "constant", value: "Before process" },
            },
          ],
        },
        {
          actionType: "start_process",
          processTemplateId: template.id,
          fieldMappings: [],
        },
        {
          actionType: "update_record",
          fieldMappings: [
            {
              targetFieldDefinitionId: deliverable.fields.status.id,
              source: { type: "constant", value: "After process" },
            },
          ],
        },
      ],
    })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("name", workflowName);
  expect(workflowUpdateError).toBeNull();
  const record = await createDeliverable(
    page,
    deliverable,
    `${run.label} Updated Report`,
    "Monthly Report",
  );

  async function updateStatus(value: string) {
    await page.goto(`/entities/${deliverable.id}/records/${record.id}/edit`);
    await page.locator(`[name="${deliverable.fields.status.key}"]`).fill(value);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByRole("heading", { name: deliverable.name, exact: true })).toBeVisible();
  }

  await updateStatus("Ready");
  await expect.poll(() => getProcessRuns(template.id)).toHaveLength(1);
  await expect(page.getByText("After process")).toBeVisible();
  await updateStatus("Retry");
  await expect.poll(async () => {
    const { data } = await supabase
      .from("workflow_execution_logs")
      .select("status, error_message, action_results")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .order("started_at", { ascending: false })
      .limit(1)
      .single();
    return data?.status;
  }).toBe("failed");
  expect(await getProcessRuns(template.id)).toHaveLength(1);
  await expect(page.getByText("Before process")).toBeVisible();

  const { data: failedLog } = await supabase
    .from("workflow_execution_logs")
    .select("error_message, action_results")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .order("started_at", { ascending: false })
    .limit(1)
    .single();
  expect(failedLog?.error_message).toContain("Action 2 (start_process) failed");
  expect(failedLog?.action_results).toEqual([
    expect.objectContaining({ index: 0, status: "succeeded" }),
    expect.objectContaining({
      index: 1,
      actionType: "start_process",
      status: "failed",
      processTemplateId: template.id,
      originEntityTypeId: deliverable.id,
      originRecordId: record.id,
      errorMessage: expect.stringContaining(
        "This process is already running for this record",
      ),
    }),
  ]);
});

test("Start Process save validation rejects crafted configuration without a partial workflow", async () => {
  const entityId = randomUUID();
  const templateId = randomUUID();
  const activeEntityContexts = [
    {
      entityType: { id: entityId, name: "Deliverable" },
      fields: [],
    } as unknown as EntityFieldContext,
  ];
  const processTemplates = [
    {
      id: templateId,
      workspaceId: DEMO_WORKSPACE_ID,
      name: "Production",
      appliesToEntityTypeId: entityId,
    } as ProcessTemplate,
  ];
  const buildForm = (actionType: string, extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set("workflowName", "No partial workflow");
    form.set("workflowEnabled", "true");
    form.set("workflowTriggerType", "record_created");
    form.set("triggerEntityTypeId", entityId);
    form.append("actionId", "action-1");
    form.set("actionType:action-1", actionType);
    form.set("processTemplateId:action-1", templateId);

    for (const [key, value] of Object.entries(extra)) {
      form.set(key, value);
    }

    return form;
  };
  const validate = (formData: FormData) =>
    validateWorkflowFormData({
      formData,
      formVersion: 1,
      activeEntityContexts,
      processTemplates,
      validateConstantRelationValue: async () => false,
    });

  const valid = await validate(buildForm("start_process"));
  expect(valid.success).toBe(true);

  const unknownAction = await validate(buildForm("start_everything"));
  expect(unknownAction).toMatchObject({
    success: false,
    state: { errors: { "actionType:action-1": "Choose a valid workflow action." } },
  });

  const extraConfig = await validate(
    buildForm("start_process", {
      "actionTargetEntityTypeId:action-1": randomUUID(),
      "targetFieldDefinitionId:action-1": randomUUID(),
    }),
  );
  expect(extraConfig).toMatchObject({
    success: false,
    state: {
      errors: {
        "action:action-1":
          "Start Process cannot include record targets, relation fields, or field mappings.",
      },
    },
  });

  const foreignTemplate = await validateWorkflowFormData({
    formData: buildForm("start_process"),
    formVersion: 1,
    activeEntityContexts,
    processTemplates: [],
    validateConstantRelationValue: async () => false,
  });
  expect(foreignTemplate).toMatchObject({
    success: false,
    state: { errors: { "processTemplateId:action-1": expect.any(String) } },
  });
});

test("process template safe deletion blocks workflow references and allows deletion after the workflow is removed", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const deliverable = await createEntity(supabase, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "type", name: "Type", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
  ]);
  const template = await createTemplate({ run, entity: deliverable, suffix: "Delete Guard" });
  const workflowName = `${run.label} Template Reference`;
  await createStartProcessWorkflow({
    page,
    name: workflowName,
    entity: deliverable,
    templateId: template.id,
  });
  const authenticated = await createAuthenticatedTestClient();
  const { data: blockedRows, error: blockedError } = await authenticated.rpc(
    "delete_process_template_if_safe_authorized",
    {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: template.id,
    },
  );
  expect(blockedError).toBeNull();
  expect(blockedRows?.[0]).toMatchObject({
    deleted: false,
    run_count: 0,
    workflow_count: 1,
  });

  const { error: workflowDeleteError } = await supabase
    .from("workflows")
    .delete()
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("name", workflowName);
  expect(workflowDeleteError).toBeNull();
  const { data: deletedRows, error: deleteError } = await authenticated.rpc(
    "delete_process_template_if_safe_authorized",
    {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: template.id,
    },
  );
  expect(deleteError).toBeNull();
  expect(deletedRows?.[0]).toMatchObject({
    deleted: true,
    run_count: 0,
    workflow_count: 0,
  });
});

test("an archived referenced template remains configured, fails execution, and can run again after restore", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const deliverable = await createEntity(supabase, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "type", name: "Type", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
  ]);
  const template = await createTemplate({ run, entity: deliverable, suffix: "Archive Recovery" });
  const workflowName = `${run.label} Archived Template`;
  await createStartProcessWorkflow({
    page,
    name: workflowName,
    entity: deliverable,
    templateId: template.id,
  });
  const authenticated = await createAuthenticatedTestClient();
  const { error: archiveError } = await authenticated.rpc(
    "archive_process_template_authorized",
    {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: template.id,
    },
  );
  expect(archiveError).toBeNull();

  const { data: workflow } = await supabase
    .from("workflows")
    .select("id, actions")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("name", workflowName)
    .single();
  expect(workflow?.actions).toEqual([
    expect.objectContaining({ actionType: "start_process", processTemplateId: template.id }),
  ]);
  await page.goto(`/workflows/${workflow?.id}/edit`);
  const processTemplateSelect = page.getByLabel("Process Template", { exact: true });
  await expect(processTemplateSelect).toHaveValue(template.id);
  await expect(processTemplateSelect.locator("option:checked")).toHaveText(
    `${template.name} (Archived)`,
  );
  await expect(page.getByText(/references archived configuration/i)).toBeVisible();

  await createDeliverable(
    page,
    deliverable,
    `${run.label} Archived Attempt`,
    "Monthly Report",
  );
  expect(await getProcessRuns(template.id)).toHaveLength(0);
  const { data: failedLog } = await supabase
    .from("workflow_execution_logs")
    .select("status, error_message")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("workflow_id", workflow?.id ?? "")
    .single();
  expect(failedLog).toMatchObject({
    status: "failed",
    error_message: expect.stringContaining("Process template not found or archived"),
  });

  const { error: restoreError } = await authenticated.rpc(
    "restore_process_template_authorized",
    {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: template.id,
    },
  );
  expect(restoreError).toBeNull();
  await createDeliverable(
    page,
    deliverable,
    `${run.label} Restored Attempt`,
    "Monthly Report",
  );
  await expect.poll(() => getProcessRuns(template.id)).toHaveLength(1);
});
