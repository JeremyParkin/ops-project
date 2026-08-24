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
  type TestRun,
} from "./helpers/supabase-test-data";
import { requireE2eEnv } from "./helpers/env";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const E2E_RUNNER_PASSWORD = "E2E-runner-password-2026";

async function authenticatedClient() {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: E2E_RUNNER_EMAIL,
    password: E2E_RUNNER_PASSWORD,
  });

  if (error) {
    throw new Error(`Unable to authenticate E2E runner: ${error.message}`);
  }

  return client;
}

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function createBranchFixture({
  run,
  needsRevisions,
}: {
  run: TestRun;
  needsRevisions?: boolean;
}) {
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "needsRevisions", name: "Needs revisions", type: "boolean" },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: {
      name: `${run.label} Monthly report`,
      ...(needsRevisions === undefined ? {} : { needsRevisions }),
    },
  });
  const templateId = randomUUID();
  const reviewNodeId = randomUUID();
  const revisionsNodeId = randomUUID();
  const sendNodeId = randomUUID();

  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Report route`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await admin.from("process_nodes").insert([
    { id: reviewNodeId, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "human_task", name: "Review Report", position: 1, config: {} },
    { id: revisionsNodeId, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "human_task", name: "Make Revisions", position: 2, config: {} },
    { id: sendNodeId, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "human_task", name: "Send to Client", position: 3, config: {} },
  ]);
  if (nodeError) throw new Error(nodeError.message);

  const condition = {
    sourceFieldDefinitionId: entity.fields.needsRevisions.id,
    operator: "equals",
    value: true,
  };
  const { error: edgeError } = await admin.from("process_edges").insert([
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: reviewNodeId, target_node_id: revisionsNodeId, priority: 0, condition_config: [condition], is_default: false },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: reviewNodeId, target_node_id: sendNodeId, priority: 1, is_default: true },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: revisionsNodeId, target_node_id: sendNodeId, priority: 0, is_default: true },
  ]);
  if (edgeError) throw new Error(edgeError.message);

  return { admin, entity, recordId, templateId, reviewNodeId, revisionsNodeId, sendNodeId };
}

async function startRun(
  client: Awaited<ReturnType<typeof authenticatedClient>>,
  fixture: Awaited<ReturnType<typeof createBranchFixture>>,
) {
  const { data, error } = await client.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: fixture.templateId,
    p_origin_entity_type_id: fixture.entity.id,
    p_origin_record_id: fixture.recordId,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

async function getRunSteps(runId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("process_step_runs")
    .select("id, source_node_id, status, routing_result")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", runId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

test.beforeAll(async () => cleanupStaleE2eData());
test.afterAll(async () => {
  for (const run of runs) await cleanupE2eRun(run);
});

test.describe("process conditional branching", () => {
  test("uses snapshotted edges rather than position + 1 and skips only unreachable nodes", async () => {
    const fixture = await createBranchFixture({ run: createScenarioRun(), needsRevisions: false });
    const client = await authenticatedClient();
    const runId = await startRun(client, fixture);
    const initialRoutes = await fixture.admin
      .from("process_step_run_routes")
      .select("id, source_node_id, target_node_id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId);
    expect(initialRoutes.data).toHaveLength(3);

    // Editing live template routing after start cannot alter this run's snapshot.
    await fixture.admin
      .from("process_edges")
      .update({ condition_config: [{ sourceFieldDefinitionId: fixture.entity.fields.needsRevisions.id, operator: "equals", value: false }] })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", fixture.templateId)
      .eq("source_node_id", fixture.reviewNodeId)
      .eq("is_default", false);

    const review = (await getRunSteps(runId)).find((step) => step.source_node_id === fixture.reviewNodeId)!;
    const { error } = await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: review.id,
    });
    expect(error).toBeNull();

    const steps = await getRunSteps(runId);
    expect(steps.find((step) => step.source_node_id === fixture.revisionsNodeId)?.status).toBe("skipped");
    expect(steps.find((step) => step.source_node_id === fixture.sendNodeId)?.status).toBe("active");
    expect(steps.find((step) => step.source_node_id === fixture.reviewNodeId)?.routing_result).toMatchObject({
      outcome: "default_fallback",
    });
  });

  test("evaluates current origin values at completion and preserves a live archived-field failure", async () => {
    const fixture = await createBranchFixture({ run: createScenarioRun(), needsRevisions: false });
    const client = await authenticatedClient();
    const runId = await startRun(client, fixture);

    await fixture.admin
      .from("entity_records")
      .update({ values: { [fixture.entity.fields.name.key]: "Changed report", [fixture.entity.fields.needsRevisions.key]: true } })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", fixture.recordId);
    await fixture.admin
      .from("field_definitions")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", fixture.entity.fields.needsRevisions.id);

    const review = (await getRunSteps(runId)).find((step) => step.source_node_id === fixture.reviewNodeId)!;
    const failed = await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: review.id,
    });
    expect(failed.error?.message).toContain("missing or archived field");
    expect((await getRunSteps(runId)).find((step) => step.id === review.id)?.status).toBe("active");

    await fixture.admin
      .from("field_definitions")
      .update({ archived_at: null })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", fixture.entity.fields.needsRevisions.id);
    const retried = await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: review.id,
    });
    expect(retried.error).toBeNull();
    const routedSteps = await getRunSteps(runId);
    const routedReview = routedSteps.find((step) => step.source_node_id === fixture.reviewNodeId)!;
    const revisions = routedSteps.find((step) => step.source_node_id === fixture.revisionsNodeId)!;
    expect(revisions.status).toBe("active");
    expect(routedSteps.find((step) => step.source_node_id === fixture.sendNodeId)?.status).toBe("pending");
    expect(routedReview.routing_result).toMatchObject({
      outcome: "matched_condition",
      targetStepRunId: revisions.id,
      evaluatedConditions: [
        expect.objectContaining({ fieldName: "Needs revisions", actualValue: true, matched: true }),
      ],
    });

    // The shared Send node is reachable through Revisions, so it must not be
    // skipped merely because it also belongs to the default branch.
    const completeRevisions = await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: revisions.id,
    });
    expect(completeRevisions.error).toBeNull();
    expect((await getRunSteps(runId)).find((step) => step.source_node_id === fixture.sendNodeId)?.status).toBe("active");

    const archivedBeforeStart = await createBranchFixture({
      run: createScenarioRun(),
      needsRevisions: true,
    });
    await archivedBeforeStart.admin
      .from("field_definitions")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", archivedBeforeStart.entity.fields.needsRevisions.id);
    const deniedStart = await client.rpc("start_process_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: archivedBeforeStart.templateId,
      p_origin_entity_type_id: archivedBeforeStart.entity.id,
      p_origin_record_id: archivedBeforeStart.recordId,
    });
    expect(deniedStart.error?.message).toContain("missing or archived field");
  });

  test("blocks field deletion for unresolved route snapshots, then releases it after routing", async () => {
    const fixture = await createBranchFixture({ run: createScenarioRun() });
    const client = await authenticatedClient();
    const runId = await startRun(client, fixture);

    // Remove the live template reference. The pending run snapshot alone must
    // still keep the optional, currently-unset field safe from hard deletion.
    await fixture.admin
      .from("process_edges")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", fixture.templateId)
      .eq("source_node_id", fixture.reviewNodeId)
      .eq("is_default", false);
    const blocked = await client.rpc("delete_field_definition_if_safe_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_entity_type_id: fixture.entity.id,
      p_field_definition_id: fixture.entity.fields.needsRevisions.id,
    });
    expect(blocked.error).toBeNull();
    expect(blocked.data?.[0]).toMatchObject({ deleted: false, process_branch_reference_count: 1 });

    const review = (await getRunSteps(runId)).find((step) => step.source_node_id === fixture.reviewNodeId)!;
    await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: review.id,
    });
    const released = await client.rpc("delete_field_definition_if_safe_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_entity_type_id: fixture.entity.id,
      p_field_definition_id: fixture.entity.fields.needsRevisions.id,
    });
    expect(released.error).toBeNull();
    expect(released.data?.[0]?.deleted).toBe(true);
  });

  test("keeps mutually exclusive branch work out of My Work until routing resolves", async ({ page }) => {
    const fixture = await createBranchFixture({ run: createScenarioRun(), needsRevisions: false });
    const client = await authenticatedClient();
    const { data: userData } = await client.auth.getUser();
    const runnerUserId = userData.user?.id;
    expect(runnerUserId).toBeTruthy();
    await fixture.admin
      .from("process_nodes")
      .update({ assignee_user_id: runnerUserId })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", fixture.templateId);

    const runId = await startRun(client, fixture);
    await page.goto("/my-work");
    await expect(page.getByText("Review Report", { exact: true })).toBeVisible();
    await expect(page.getByText("Make Revisions", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Send to Client", { exact: true })).toHaveCount(0);

    const review = (await getRunSteps(runId)).find((step) => step.source_node_id === fixture.reviewNodeId)!;
    const { error } = await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: review.id,
    });
    expect(error).toBeNull();

    await page.reload();
    await expect(page.getByText("Send to Client", { exact: true })).toBeVisible();
    await expect(page.getByText("Make Revisions", { exact: true })).toHaveCount(0);
  });

  test("rejects a backward route edit atomically instead of silently rewriting it", async () => {
    const fixture = await createBranchFixture({ run: createScenarioRun(), needsRevisions: false });
    const client = await authenticatedClient();
    const { data: templateBefore } = await fixture.admin
      .from("process_templates")
      .select("name")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", fixture.templateId)
      .single();

    const { error } = await client.rpc("save_process_template_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: fixture.templateId,
      p_name: "Should not persist",
      p_description: null,
      p_applies_to_entity_type_id: fixture.entity.id,
      p_steps: [
        { client_key: "review", node_id: fixture.reviewNodeId, name: "Review Report", assignee_user_id: null, due_rule: null, routes: [{ target_client_key: "revisions", is_default: false, conditions: [{ sourceFieldDefinitionId: fixture.entity.fields.needsRevisions.id, operator: "equals", value: true }] }, { target_client_key: "send", is_default: true, conditions: [] }] },
        { client_key: "send", node_id: fixture.sendNodeId, name: "Send to Client", assignee_user_id: null, due_rule: null, routes: [] },
        { client_key: "revisions", node_id: fixture.revisionsNodeId, name: "Make Revisions", assignee_user_id: null, due_rule: null, routes: [{ target_client_key: "send", is_default: true, conditions: [] }] },
      ],
    });
    expect(error?.message).toContain("Routes must point to a later step");

    const { data: templateAfter } = await fixture.admin
      .from("process_templates")
      .select("name")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", fixture.templateId)
      .single();
    expect(templateAfter).toEqual(templateBefore);
  });
});
