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

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const disposableUserIds: string[] = [];
const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const E2E_RUNNER_PASSWORD = "E2E-runner-password-2026";

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function authenticatedClient(email = E2E_RUNNER_EMAIL, password = E2E_RUNNER_PASSWORD) {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });

  if (error) {
    throw new Error(`Unable to sign in as an E2E member: ${error.message}`);
  }

  return client;
}

async function createSecondMember(run: TestRun) {
  const admin = createSupabaseTestClient();
  const email = `e2e-second-approval-${run.id}@ops-project.test`;
  const password = "E2E-second-approval-password-2026";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Unable to create second approval member: ${error?.message ?? "unknown error"}`);
  }
  disposableUserIds.push(data.user.id);

  const { error: membershipError } = await admin.from("workspace_memberships").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    user_id: data.user.id,
  });
  if (membershipError) {
    throw new Error(`Unable to add second approval member: ${membershipError.message}`);
  }

  return { userId: data.user.id, client: authenticatedClient(email, password) };
}

type ApprovalFixture = {
  entity: TestEntity;
  recordId: string;
  templateId: string;
  nodeIds: { approval: string; approveTarget: string; rejectTarget: string };
  outcomes: { approve: string; reject: string };
};

async function createApprovalFixture({
  run,
  assigneeUserId = null,
  dueRule = null,
  sharedTarget = false,
  entitySuffix = "Deliverable",
}: {
  run: TestRun;
  assigneeUserId?: string | null;
  dueRule?: { amount: number; unit: "hours" | "days" } | null;
  sharedTarget?: boolean;
  entitySuffix?: string;
}): Promise<ApprovalFixture> {
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, entitySuffix, [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Approval record` },
  });
  const templateId = randomUUID();
  const nodeIds = {
    approval: randomUUID(),
    approveTarget: randomUUID(),
    rejectTarget: randomUUID(),
  };
  const outcomes = { approve: randomUUID(), reject: randomUUID() };

  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Approval route`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await admin.from("process_nodes").insert([
    {
      id: nodeIds.approval,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "approval",
      name: "Approve delivery",
      position: 1,
      assignee_user_id: assigneeUserId,
      config: dueRule ? { due_rule: dueRule } : {},
    },
    {
      id: nodeIds.approveTarget,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name: "Publish delivery",
      position: 2,
      config: {},
    },
    {
      id: nodeIds.rejectTarget,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name: "Revise delivery",
      position: 3,
      config: {},
    },
  ]);
  if (nodeError) throw new Error(nodeError.message);

  const { error: edgeError } = await admin.from("process_edges").insert([
    {
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      source_node_id: nodeIds.approval,
      target_node_id: nodeIds.approveTarget,
      priority: 0,
      condition_config: null,
      is_default: false,
      is_parallel: false,
      approval_outcome_id: outcomes.approve,
      approval_outcome_label: "Approve",
    },
    {
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      source_node_id: nodeIds.approval,
      target_node_id: sharedTarget ? nodeIds.approveTarget : nodeIds.rejectTarget,
      priority: 1,
      condition_config: null,
      is_default: false,
      is_parallel: false,
      approval_outcome_id: outcomes.reject,
      approval_outcome_label: "Reject",
    },
  ]);
  if (edgeError) throw new Error(edgeError.message);

  return { entity, recordId, templateId, nodeIds, outcomes };
}

async function startRun(client: Awaited<ReturnType<typeof authenticatedClient>>, fixture: ApprovalFixture) {
  const { data, error } = await client.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: fixture.templateId,
    p_origin_entity_type_id: fixture.entity.id,
    p_origin_record_id: fixture.recordId,
  });
  if (error || typeof data !== "string") throw new Error(error?.message ?? "Unable to start approval run");
  return data;
}

async function getRun(runId: string) {
  const admin = createSupabaseTestClient();
  const [{ data: steps, error: stepError }, { data: routes, error: routeError }] = await Promise.all([
    admin
      .from("process_step_runs")
      .select("*")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId),
    admin
      .from("process_step_run_routes")
      .select("*")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId),
  ]);
  if (stepError || routeError) throw new Error(stepError?.message ?? routeError?.message);
  return { steps: steps ?? [], routes: routes ?? [] };
}

test.beforeAll(async () => cleanupStaleE2eData());
test.afterAll(async () => {
  for (const run of runs) await cleanupE2eRun(run);
  const admin = createSupabaseTestClient();
  for (const userId of disposableUserIds) await admin.auth.admin.deleteUser(userId);
});

test("saves stable approval outcomes, permits shared targets, and rejects malformed approval config atomically", async () => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Case", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const client = await authenticatedClient();
  const approveId = randomUUID();
  const rejectId = randomUUID();
  const steps = [
    {
      client_key: "approval",
      node_id: null,
      node_type: "approval",
      parallel_group_id: null,
      name: "Decision",
      assignee_user_id: null,
      due_rule: null,
      routes: [
        { target_client_key: "followup", is_default: false, is_parallel: false, approval_outcome_id: approveId, approval_outcome_label: "Approve", conditions: [] },
        { target_client_key: "followup", is_default: false, is_parallel: false, approval_outcome_id: rejectId, approval_outcome_label: "Reject", conditions: [] },
      ],
    },
    {
      client_key: "followup",
      node_id: null,
      node_type: "human_task",
      parallel_group_id: null,
      name: "Follow up",
      assignee_user_id: null,
      due_rule: null,
      routes: [],
    },
  ];
  const save = await client.rpc("save_process_template_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: null,
    p_name: `${run.label} Shared outcome target`,
    p_description: null,
    p_applies_to_entity_type_id: entity.id,
    p_steps: steps,
  });
  expect(save.error).toBeNull();
  expect(typeof save.data).toBe("string");

  const { data: initialEdges } = await admin
    .from("process_edges")
    .select("approval_outcome_id, approval_outcome_label, target_node_id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_template_id", save.data!);
  expect(initialEdges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ approval_outcome_id: approveId, approval_outcome_label: "Approve" }),
      expect.objectContaining({ approval_outcome_id: rejectId, approval_outcome_label: "Reject" }),
    ]),
  );
  expect(new Set(initialEdges?.map((edge) => edge.target_node_id)).size).toBe(1);

  const beforeInvalid = await admin
    .from("process_templates")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .ilike("name", `${run.label} Invalid%`);
  const invalid = structuredClone(steps);
  invalid[0].routes[1].approval_outcome_label = " approve ";
  const invalidSave = await client.rpc("save_process_template_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: null,
    p_name: `${run.label} Invalid approval`,
    p_description: null,
    p_applies_to_entity_type_id: entity.id,
    p_steps: invalid,
  });
  expect(invalidSave.error?.message).toContain("Approval outcome labels must be unique");
  const afterInvalid = await admin
    .from("process_templates")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .ilike("name", `${run.label} Invalid%`);
  expect(afterInvalid.count).toBe(beforeInvalid.count);
});

test("snapshots approval choices, exposes decisions instead of Complete, and persists a durable decision", async ({ page }) => {
  const client = await authenticatedClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  expect(user).toBeTruthy();
  const fixture = await createApprovalFixture({
    run: createScenarioRun(),
    assigneeUserId: user!.id,
    dueRule: { amount: 2, unit: "hours" },
  });
  const runId = await startRun(client, fixture);
  const initial = await getRun(runId);
  const approval = initial.steps.find((step) => step.source_node_id === fixture.nodeIds.approval)!;
  expect(approval.status).toBe("active");
  expect(approval.due_at).toBeTruthy();
  expect(initial.routes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ approval_outcome_id: fixture.outcomes.approve, approval_outcome_label: "Approve" }),
      expect.objectContaining({ approval_outcome_id: fixture.outcomes.reject, approval_outcome_label: "Reject" }),
    ]),
  );

  await page.goto("/my-work");
  await expect(page.getByText("Approve delivery", { exact: true })).toBeVisible();
  await page.goto(`/process-runs/${runId}`);
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete" })).toHaveCount(0);

  const forged = await client.rpc("decide_process_approval_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: approval.id,
    p_outcome_id: randomUUID(),
  });
  expect(forged.error?.message).toContain("Approval outcome is not available");
  expect((await getRun(runId)).steps.find((step) => step.id === approval.id)).toMatchObject({
    status: "active",
    approval_outcome_id: null,
  });

  const generic = await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: approval.id,
  });
  expect(generic.error).not.toBeNull();

  const admin = createSupabaseTestClient();
  await admin
    .from("process_edges")
    .update({
      approval_outcome_label: "Changed after start",
      target_node_id: fixture.nodeIds.rejectTarget,
    })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_template_id", fixture.templateId)
    .eq("approval_outcome_id", fixture.outcomes.approve);

  const decision = await client.rpc("decide_process_approval_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: approval.id,
    p_outcome_id: fixture.outcomes.approve,
  });
  expect(decision.error).toBeNull();
  const decided = await getRun(runId);
  const completedApproval = decided.steps.find((step) => step.id === approval.id)!;
  expect(completedApproval).toMatchObject({
    status: "completed",
    approval_outcome_id: fixture.outcomes.approve,
    approval_outcome_label: "Approve",
    routing_result: expect.objectContaining({
      outcome: "approval_outcome",
      approvalOutcomeId: fixture.outcomes.approve,
      approvalOutcomeLabel: "Approve",
    }),
  });
  expect(completedApproval.decided_at).toBeTruthy();
  expect(completedApproval.decided_by_user_id).toBeTruthy();
  expect(completedApproval.decided_by_label).toBeTruthy();
  expect(decided.steps.find((step) => step.source_node_id === fixture.nodeIds.approveTarget)?.status).toBe("active");
  expect(decided.steps.find((step) => step.source_node_id === fixture.nodeIds.rejectTarget)?.status).toBe("skipped");

  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const anon = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const anonymousAttempt = await anon.rpc("decide_process_approval_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: approval.id,
    p_outcome_id: fixture.outcomes.reject,
  });
  expect(anonymousAttempt.error?.message).toMatch(/permission denied|not authorized/i);
});

test("enforces assignee-only decisions while unassigned approvals remain member-operable", async () => {
  const run = createScenarioRun();
  const secondMember = await createSecondMember(run);
  const fixture = await createApprovalFixture({ run, assigneeUserId: secondMember.userId });
  const runner = await authenticatedClient();
  const runId = await startRun(runner, fixture);
  const approval = (await getRun(runId)).steps.find((step) => step.source_node_id === fixture.nodeIds.approval)!;

  const blocked = await runner.rpc("decide_process_approval_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: approval.id,
    p_outcome_id: fixture.outcomes.approve,
  });
  expect(blocked.error?.message).toContain("assigned to another member");
  expect((await getRun(runId)).steps.find((step) => step.id === approval.id)?.status).toBe("active");

  const assignee = await secondMember.client;
  const allowed = await assignee.rpc("decide_process_approval_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: approval.id,
    p_outcome_id: fixture.outcomes.reject,
  });
  expect(allowed.error).toBeNull();
  expect((await getRun(runId)).steps.find((step) => step.id === approval.id)?.status).toBe("completed");

  const unassigned = await createApprovalFixture({ run, entitySuffix: "Unassigned Deliverable" });
  const unassignedRunId = await startRun(runner, unassigned);
  const unassignedStep = (await getRun(unassignedRunId)).steps.find(
    (step) => step.source_node_id === unassigned.nodeIds.approval,
  )!;
  const memberDecision = await assignee.rpc("decide_process_approval_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: unassignedRunId,
    p_step_run_id: unassignedStep.id,
    p_outcome_id: unassigned.outcomes.approve,
  });
  expect(memberDecision.error).toBeNull();
});

test("an approval in one parallel branch preserves its token and leaves its sibling branch active", async () => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Parallel Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Parallel approval" } });
  const templateId = randomUUID();
  const groupId = randomUUID();
  const nodeIds = Object.fromEntries(
    ["start", "split", "approval", "sibling", "join", "finish"].map((key) => [key, randomUUID()]),
  ) as Record<string, string>;
  const outcomeId = randomUUID();

  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Parallel approval`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);
  const { error: nodeError } = await admin.from("process_nodes").insert([
    { id: nodeIds.start, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "human_task", name: "Start", position: 1, config: {} },
    { id: nodeIds.split, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "parallel_split", parallel_group_id: groupId, name: "Split", position: 2, config: {} },
    { id: nodeIds.approval, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "approval", name: "Approve", position: 3, config: {} },
    { id: nodeIds.sibling, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "human_task", name: "Sibling", position: 4, config: {} },
    { id: nodeIds.join, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "parallel_join", parallel_group_id: groupId, name: "Join", position: 5, config: {} },
    { id: nodeIds.finish, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "human_task", name: "Finish", position: 6, config: {} },
  ]);
  if (nodeError) throw new Error(nodeError.message);
  const { error: edgeError } = await admin.from("process_edges").insert([
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: nodeIds.start, target_node_id: nodeIds.split, priority: 0, condition_config: null, is_default: true, is_parallel: false },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: nodeIds.split, target_node_id: nodeIds.approval, priority: 0, condition_config: null, is_default: false, is_parallel: true },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: nodeIds.split, target_node_id: nodeIds.sibling, priority: 1, condition_config: null, is_default: false, is_parallel: true },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: nodeIds.approval, target_node_id: nodeIds.join, priority: 0, condition_config: null, is_default: false, is_parallel: false, approval_outcome_id: outcomeId, approval_outcome_label: "Approve" },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: nodeIds.approval, target_node_id: nodeIds.join, priority: 1, condition_config: null, is_default: false, is_parallel: false, approval_outcome_id: randomUUID(), approval_outcome_label: "Reject" },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: nodeIds.sibling, target_node_id: nodeIds.join, priority: 0, condition_config: null, is_default: true, is_parallel: false },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: nodeIds.join, target_node_id: nodeIds.finish, priority: 0, condition_config: null, is_default: true, is_parallel: false },
  ]);
  if (edgeError) throw new Error(edgeError.message);

  const client = await authenticatedClient();
  const { data: runId, error: startError } = await client.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: templateId,
    p_origin_entity_type_id: entity.id,
    p_origin_record_id: recordId,
  });
  expect(startError).toBeNull();
  expect(typeof runId).toBe("string");
  let current = await getRun(runId!);
  const start = current.steps.find((step) => step.source_node_id === nodeIds.start)!;
  expect(
    (await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: start.id,
    })).error,
  ).toBeNull();

  current = await getRun(runId!);
  const approval = current.steps.find((step) => step.source_node_id === nodeIds.approval)!;
  const sibling = current.steps.find((step) => step.source_node_id === nodeIds.sibling)!;
  const join = current.steps.find((step) => step.source_node_id === nodeIds.join)!;
  expect(approval).toMatchObject({ status: "active" });
  expect(sibling).toMatchObject({ status: "active" });
  expect(approval.parallel_branch_token).toBeTruthy();
  expect(approval.parallel_branch_token).not.toBe(sibling.parallel_branch_token);

  const decision = await client.rpc("decide_process_approval_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: approval.id,
    p_outcome_id: outcomeId,
  });
  expect(decision.error).toBeNull();
  current = await getRun(runId!);
  expect(current.steps.find((step) => step.id === approval.id)?.status).toBe("completed");
  expect(current.steps.find((step) => step.id === sibling.id)?.status).toBe("active");
  expect(current.steps.find((step) => step.id === join.id)?.status).toBe("pending");
  const { data: obligations, error: obligationError } = await admin
    .from("process_parallel_join_obligations")
    .select("branch_token, arrived_at")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", runId);
  expect(obligationError).toBeNull();
  expect(obligations?.filter((obligation) => obligation.arrived_at)).toHaveLength(1);
  expect(obligations?.find((obligation) => obligation.arrived_at)?.branch_token).toBe(
    approval.parallel_branch_token,
  );
});
