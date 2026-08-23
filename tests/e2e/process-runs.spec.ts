import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, type Locator, type Page, test } from "@playwright/test";
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

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];

// Matches the fixed E2E runner credentials created in global-setup.ts. This
// spec needs a *real* authenticated (membership-satisfying) client, not the
// service-role admin client the other fixture helpers use, because every
// process RPC is a membership-checked SECURITY DEFINER function with no raw
// unauthenticated twin (by design — see the process migration).
const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const E2E_RUNNER_PASSWORD = "E2E-runner-password-2026";

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
    throw new Error(`Unable to sign in as the E2E runner: ${error.message}`);
  }

  return client;
}

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

async function createProcessTemplateFixture(
  run: TestRun,
  entity: TestEntity,
  stepNames: string[],
) {
  const supabase = createSupabaseTestClient();
  const templateId = randomUUID();
  const templateName = `${run.label} ${entity.name} Playbook`;

  const { error: templateError } = await supabase.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: templateName,
    applies_to_entity_type_id: entity.id,
  });

  if (templateError) {
    throw new Error(`Unable to create process template fixture: ${templateError.message}`);
  }

  const nodeIds = stepNames.map(() => randomUUID());
  const { error: nodeError } = await supabase.from("process_nodes").insert(
    stepNames.map((name, index) => ({
      id: nodeIds[index],
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name,
    })),
  );

  if (nodeError) {
    throw new Error(`Unable to create process node fixtures: ${nodeError.message}`);
  }

  const edges = nodeIds.slice(0, -1).map((sourceNodeId, index) => ({
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    source_node_id: sourceNodeId,
    target_node_id: nodeIds[index + 1],
  }));

  if (edges.length > 0) {
    const { error: edgeError } = await supabase.from("process_edges").insert(edges);

    if (edgeError) {
      throw new Error(`Unable to create process edge fixtures: ${edgeError.message}`);
    }
  }

  return { id: templateId, name: templateName, nodeIds, stepNames };
}

async function createScenario(stepNames: string[]) {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const template = await createProcessTemplateFixture(run, entity, stepNames);

  return { run, entity, template };
}

function processCard(page: Page, templateName: string): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: templateName, level: 3 }) })
    .last();
}

function stepRow(page: Page, stepName: string): Locator {
  return page.locator("li").filter({ hasText: stepName });
}

test.describe("process runs", () => {
  test("starting a process activates the first step and leaves the rest pending", async ({
    page,
  }) => {
    const { entity, template } = await createScenario([
      "Prepare Data",
      "Draft Report",
      "Review",
    ]);
    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: "First Run Record" },
    });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await expect(processCard(page, template.name)).toContainText("Not started");
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    // "Start process" redirects straight to the new run's detail page, so
    // wait for that navigation rather than expecting the record-detail DOM
    // to update in place.
    await page.waitForURL(/\/process-runs\//);
    await expect(page.getByRole("heading", { name: template.name })).toBeVisible();
    await expect(stepRow(page, "Prepare Data")).toContainText("active");
    await expect(stepRow(page, "Prepare Data").getByRole("button", { name: "Complete" })).toBeVisible();
    await expect(stepRow(page, "Draft Report")).toContainText("pending");
    await expect(stepRow(page, "Draft Report").getByRole("button", { name: "Complete" })).toHaveCount(0);
    await expect(stepRow(page, "Review")).toContainText("pending");

    // Record detail should independently summarize the now-active run.
    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await expect(processCard(page, template.name).getByRole("link", { name: "Open process" })).toBeVisible();
    await expect(processCard(page, template.name)).toContainText("0 of 3 steps complete");
    await expect(processCard(page, template.name)).toContainText("Current: Prepare Data");
  });

  test("completing steps in sequence cascades activation and completes the run on the final step", async ({
    page,
  }) => {
    const { entity, template } = await createScenario(["Step One", "Step Two", "Step Three"]);
    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: "Cascade Record" },
    });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);

    await stepRow(page, "Step One").getByRole("button", { name: "Complete" }).click();
    await expect(stepRow(page, "Step One")).toContainText("completed");
    await expect(stepRow(page, "Step Two")).toContainText("active");
    await expect(stepRow(page, "Step Two").getByRole("button", { name: "Complete" })).toBeVisible();

    await stepRow(page, "Step Two").getByRole("button", { name: "Complete" }).click();
    await expect(stepRow(page, "Step Two")).toContainText("completed");
    await expect(stepRow(page, "Step Three")).toContainText("active");

    await stepRow(page, "Step Three").getByRole("button", { name: "Complete" }).click();
    await expect(stepRow(page, "Step Three")).toContainText("completed");
    await expect(page.getByText("Complete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Complete" })).toHaveCount(0);

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await expect(processCard(page, template.name)).toContainText("Completed");
    await expect(processCard(page, template.name)).toContainText("3 of 3 steps");
    await expect(
      processCard(page, template.name).getByRole("button", { name: "Start another run" }),
    ).toBeVisible();
  });

  test("a completed run allows starting another run for the same template and record", async ({
    page,
  }) => {
    const { entity, template } = await createScenario(["Only Step"]);
    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: "Recurring Record" },
    });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);
    await stepRow(page, "Only Step").getByRole("button", { name: "Complete" }).click();
    await expect(page.getByText("Complete", { exact: true })).toBeVisible();
    const firstRunUrl = page.url();

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await expect(processCard(page, template.name)).toContainText("Completed");
    await processCard(page, template.name)
      .getByRole("button", { name: "Start another run" })
      .click();
    await page.waitForURL(/\/process-runs\//);

    expect(page.url()).not.toBe(firstRunUrl);
    await expect(stepRow(page, "Only Step")).toContainText("active");
    await expect(stepRow(page, "Only Step").getByRole("button", { name: "Complete" })).toBeVisible();
  });

  test("starting a duplicate active run for the same template and record is rejected", async ({
    page,
  }) => {
    const { entity, template } = await createScenario(["Solo Step"]);
    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: "Duplicate Guard Record" },
    });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);

    const authenticatedClient = await createAuthenticatedTestClient();
    const { error } = await authenticatedClient.rpc("start_process_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: template.id,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
    });

    expect(error?.message).toContain("This process is already running for this record");
  });

  test("completing a step that is not currently active is rejected", async ({ page }) => {
    const { entity, template } = await createScenario(["Alpha", "Beta"]);
    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: "Non-active Guard Record" },
    });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    // Wait for the run to actually exist before querying it directly, since
    // the click only waits for dispatch, not for the action's DB write.
    await page.waitForURL(/\/process-runs\//);

    const supabase = createSupabaseTestClient();
    const { data: run } = await supabase
      .from("process_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", template.id)
      .eq("origin_record_id", recordId)
      .single();
    const { data: pendingStep } = await supabase
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", run!.id as string)
      .eq("status", "pending")
      .single();

    const authenticatedClient = await createAuthenticatedTestClient();
    const { error } = await authenticatedClient.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: run!.id as string,
      p_step_run_id: pendingStep!.id as string,
    });

    expect(error?.message).toContain("This step is not active");
  });

  test("cross-workspace and foreign step-run IDs are rejected", async ({ page }) => {
    const first = await createScenario(["Only Step"]);
    const second = await createScenario(["Different Step"]);
    const firstRecordId = await createEntityRecord({
      entity: first.entity,
      valuesBySlug: { name: "Cross Guard Record A" },
    });
    const secondRecordId = await createEntityRecord({
      entity: second.entity,
      valuesBySlug: { name: "Cross Guard Record B" },
    });

    await page.goto(`/entities/${first.entity.id}/records/${firstRecordId}`);
    await processCard(page, first.template.name)
      .getByRole("button", { name: "Start process" })
      .click();
    await page.waitForURL(/\/process-runs\//);

    await page.goto(`/entities/${second.entity.id}/records/${secondRecordId}`);
    await processCard(page, second.template.name)
      .getByRole("button", { name: "Start process" })
      .click();
    await page.waitForURL(/\/process-runs\//);

    const supabase = createSupabaseTestClient();
    const { data: firstRun } = await supabase
      .from("process_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", first.template.id)
      .eq("origin_record_id", firstRecordId)
      .single();
    const { data: secondRun } = await supabase
      .from("process_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", second.template.id)
      .eq("origin_record_id", secondRecordId)
      .single();
    const { data: secondActiveStep } = await supabase
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", secondRun!.id as string)
      .eq("status", "active")
      .single();

    const authenticatedClient = await createAuthenticatedTestClient();
    const { error: foreignStepError } = await authenticatedClient.rpc(
      "complete_process_step_run_authorized",
      {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_run_id: firstRun!.id as string,
        p_step_run_id: secondActiveStep!.id as string,
      },
    );

    expect(foreignStepError?.message).toContain("Step not found");

    const { error: wrongEntityTypeError } = await authenticatedClient.rpc(
      "start_process_run_authorized",
      {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_template_id: first.template.id,
        p_origin_entity_type_id: second.entity.id,
        p_origin_record_id: secondRecordId,
      },
    );

    expect(wrongEntityTypeError?.message).toContain(
      "does not apply to this record's entity type",
    );
  });

  test("renaming a template after a run has started does not change the run's historical name", async ({
    page,
  }) => {
    const { entity, template } = await createScenario(["Only Step"]);
    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: "Snapshot Guard Record" },
    });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);
    const runUrl = page.url();
    await expect(page.getByRole("heading", { name: template.name })).toBeVisible();

    const renamedTemplateName = `${template.name} (Renamed)`;
    await page.goto(`/processes/${template.id}/edit`);
    await page.locator("#process-template-name").fill(renamedTemplateName);
    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: renamedTemplateName })).toBeVisible();

    await page.goto(runUrl);
    await expect(page.getByRole("heading", { name: template.name })).toBeVisible();
    await expect(page.getByRole("heading", { name: renamedTemplateName })).toHaveCount(0);
  });

  test("a record with a process run cannot be hard-deleted", async ({ page }) => {
    const { entity, template } = await createScenario(["Only Step"]);
    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: "Undeletable Record" },
    });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    // "Start process" redirects to the new run's detail page; wait for that
    // navigation to finish before returning to record detail, otherwise the
    // redirect can land after the delete attempt and clobber the assertion.
    await page.waitForURL(/\/process-runs\//);

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await page.getByText("Record actions", { exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByText(new RegExp(`Cannot delete this .* because 1 process run`)),
    ).toBeVisible();
  });

  test("an archived template rejects new runs, and restoring it re-enables starting", async () => {
    const { entity, template } = await createScenario(["Solo Step"]);
    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: "Archive Guard Record" },
    });
    const authenticatedClient = await createAuthenticatedTestClient();

    const { error: archiveError } = await authenticatedClient.rpc(
      "archive_process_template_authorized",
      { p_workspace_id: DEMO_WORKSPACE_ID, p_process_template_id: template.id },
    );
    expect(archiveError).toBeNull();

    const { error: startWhileArchivedError } = await authenticatedClient.rpc(
      "start_process_run_authorized",
      {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_template_id: template.id,
        p_origin_entity_type_id: entity.id,
        p_origin_record_id: recordId,
      },
    );
    expect(startWhileArchivedError?.message).toContain("Process template not found or archived");

    const { error: restoreError } = await authenticatedClient.rpc(
      "restore_process_template_authorized",
      { p_workspace_id: DEMO_WORKSPACE_ID, p_process_template_id: template.id },
    );
    expect(restoreError).toBeNull();

    const { data: runId, error: startAfterRestoreError } = await authenticatedClient.rpc(
      "start_process_run_authorized",
      {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_template_id: template.id,
        p_origin_entity_type_id: entity.id,
        p_origin_record_id: recordId,
      },
    );
    expect(startAfterRestoreError).toBeNull();
    expect(typeof runId).toBe("string");
  });

  test("updating a template rejects a node ID from another template or a forged ID, leaving both templates unchanged", async () => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entityA = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateA = await createProcessTemplateFixture(run, entityA, [
      "A Step One",
      "A Step Two",
    ]);
    const entityB = await createEntity(supabase, run, "Ticket", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateB = await createProcessTemplateFixture(run, entityB, ["B Step One"]);

    const authenticatedClient = await createAuthenticatedTestClient();

    const { error: foreignNodeError } = await authenticatedClient.rpc(
      "save_process_template_authorized",
      {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_template_id: templateA.id,
        p_name: "Should not persist (foreign node)",
        p_description: null,
        p_applies_to_entity_type_id: entityA.id,
        p_steps: [{ node_id: templateB.nodeIds[0], name: "Hijacked Step" }],
      },
    );
    expect(foreignNodeError?.message).toContain("Submitted step does not belong to this template");

    const { error: forgedNodeError } = await authenticatedClient.rpc(
      "save_process_template_authorized",
      {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_template_id: templateA.id,
        p_name: "Should not persist (forged node)",
        p_description: null,
        p_applies_to_entity_type_id: entityA.id,
        p_steps: [{ node_id: randomUUID(), name: "Forged Step" }],
      },
    );
    expect(forgedNodeError?.message).toContain("Submitted step does not belong to this template");

    const { data: templateARow } = await supabase
      .from("process_templates")
      .select("name")
      .eq("id", templateA.id)
      .single();
    const { data: nodesA } = await supabase
      .from("process_nodes")
      .select("id, name")
      .eq("process_template_id", templateA.id);
    const { data: nodesB } = await supabase
      .from("process_nodes")
      .select("id, name")
      .eq("process_template_id", templateB.id);

    expect(templateARow?.name).toBe(templateA.name);
    expect(new Set((nodesA ?? []).map((node) => node.id))).toEqual(new Set(templateA.nodeIds));
    expect((nodesA ?? []).map((node) => node.name).sort()).toEqual(["A Step One", "A Step Two"]);
    expect(new Set((nodesB ?? []).map((node) => node.id))).toEqual(new Set(templateB.nodeIds));
    expect((nodesB ?? []).map((node) => node.name)).toEqual(["B Step One"]);
  });

  test("the applies-to entity type cannot be changed by a direct RPC call", async () => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entityA = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const entityB = await createEntity(supabase, run, "Ticket", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const template = await createProcessTemplateFixture(run, entityA, ["Only Step"]);

    const authenticatedClient = await createAuthenticatedTestClient();
    const { error } = await authenticatedClient.rpc("save_process_template_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: template.id,
      p_name: template.name,
      p_description: null,
      p_applies_to_entity_type_id: entityB.id,
      p_steps: [{ node_id: template.nodeIds[0], name: "Only Step" }],
    });
    expect(error?.message).toContain("Applies-to entity type cannot be changed after creation");

    const { data: templateRow } = await supabase
      .from("process_templates")
      .select("applies_to_entity_type_id")
      .eq("id", template.id)
      .single();
    expect(templateRow?.applies_to_entity_type_id).toBe(entityA.id);
  });

  test("process tables stay select-only for authenticated members, and every mutation RPC is denied to anon", async () => {
    const { template } = await createScenario(["Solo Step"]);
    const authenticatedClient = await createAuthenticatedTestClient();

    const { data: selectData, error: selectError } = await authenticatedClient
      .from("process_templates")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", template.id);
    expect(selectError).toBeNull();
    expect(selectData).toHaveLength(1);

    const processTables = [
      "process_templates",
      "process_nodes",
      "process_edges",
      "process_runs",
      "process_step_runs",
    ] as const;

    for (const table of processTables) {
      const { error } = await authenticatedClient
        .from(table)
        .insert({ workspace_id: DEMO_WORKSPACE_ID });
      expect(error, `INSERT on ${table} should be denied to an authenticated member`).not.toBeNull();
    }

    const { error: updateError } = await authenticatedClient
      .from("process_templates")
      .update({ name: "Should not persist" })
      .eq("id", template.id);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await authenticatedClient
      .from("process_templates")
      .delete()
      .eq("id", template.id);
    expect(deleteError).not.toBeNull();

    const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
    const anonClient = createClient(supabaseUrl, supabasePublishableKey, {
      auth: { persistSession: false },
    });
    const dummyId = randomUUID();
    const rpcCalls: Array<[string, Record<string, unknown>]> = [
      [
        "save_process_template_authorized",
        {
          p_workspace_id: dummyId,
          p_process_template_id: null,
          p_name: "x",
          p_description: null,
          p_applies_to_entity_type_id: dummyId,
          p_steps: [{ node_id: null, name: "x" }],
        },
      ],
      [
        "archive_process_template_authorized",
        { p_workspace_id: dummyId, p_process_template_id: dummyId },
      ],
      [
        "restore_process_template_authorized",
        { p_workspace_id: dummyId, p_process_template_id: dummyId },
      ],
      [
        "delete_process_template_if_safe_authorized",
        { p_workspace_id: dummyId, p_process_template_id: dummyId },
      ],
      [
        "start_process_run_authorized",
        {
          p_workspace_id: dummyId,
          p_process_template_id: dummyId,
          p_origin_entity_type_id: dummyId,
          p_origin_record_id: dummyId,
        },
      ],
      [
        "complete_process_step_run_authorized",
        { p_workspace_id: dummyId, p_process_run_id: dummyId, p_step_run_id: dummyId },
      ],
    ];

    for (const [fn, params] of rpcCalls) {
      const { error } = await anonClient.rpc(fn, params);
      expect(error, `${fn} should be denied to an anonymous caller`).not.toBeNull();
    }
  });
});
