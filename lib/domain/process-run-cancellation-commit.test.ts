// DB/RPC-level verification for Phase 11.1 Cancel Process Run
// (cancel_process_run_authorized, migrations 0092/0093). Covers: cancelling
// each human-operable and system node type while active, pending siblings,
// parallel branches with an unarrived join obligation, completed/skipped
// history preservation, post-cancel rejection of every advancement RPC,
// immediate new-run start on the freed origin, processes.operate/cross-
// workspace authorization, blank-reason rejection, impersonation
// attribution, and the process_cancelled Activity event.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient, deleteE2eUsers } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  entityTypeId: string;
  templateId: string;
  worker: User;
  readOnly: User;
  administrator: User;
  otherWorker: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
let administratorClientPromise: Promise<SupabaseClient> | undefined;

function uniqueEmail(label: string) {
  return `e2e-process-run-cancellation-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `ProcessRunCancel-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: uniqueEmail(label),
    password,
    email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email: data.user.email, password };
}

async function authenticatedClient(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

function administratorClient() {
  administratorClientPromise ??= authenticatedClient(fixture.administrator);
  return administratorClientPromise;
}

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: `${name} ${workspaceId.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({
    id: roleId,
    workspace_id: workspaceId,
    name,
  });
  if (roleError) throw new Error(roleError.message);

  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }

  return roleId;
}

async function addMembership(workspaceId: string, userId: string, roleId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({
    workspace_id: workspaceId,
    user_id: userId,
    role_id: roleId,
  });
  if (error) throw new Error(error.message);
}

async function createEntityType(workspaceId: string, name: string) {
  const admin = createSupabaseTestClient();
  const entityTypeId = randomUUID();
  const fieldId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityTypeId,
    workspace_id: workspaceId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${entityTypeId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);

  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: fieldId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    key: "name",
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);

  return entityTypeId;
}

async function createRecord(workspaceId: string, entityTypeId: string, name: string) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin.from("entity_records").insert({
    id: recordId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    values: { name },
  });
  if (error) throw new Error(error.message);
  return recordId;
}

async function createTemplate(workspaceId: string, entityTypeId: string, name: string) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const { error } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: workspaceId,
    applies_to_entity_type_id: entityTypeId,
    name,
  });
  if (error) throw new Error(error.message);
  return templateId;
}

async function createRun({
  workspaceId,
  entityTypeId,
  recordId,
  templateId,
  status = "active",
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  templateId: string;
  status?: "active" | "completed";
}) {
  const admin = createSupabaseTestClient();
  const runId = randomUUID();
  const { error } = await admin.from("process_runs").insert({
    id: runId,
    workspace_id: workspaceId,
    process_template_id: templateId,
    process_template_name: "Cancellation template",
    origin_entity_type_id: entityTypeId,
    origin_record_id: recordId,
    status,
    completed_at: status === "completed" ? new Date().toISOString() : null,
  });
  if (error) throw new Error(error.message);
  return runId;
}

type StepNodeType = "human_task" | "approval" | "wait" | "condition_wait" | "action" | "parallel_join";

async function createStep({
  workspaceId,
  processRunId,
  stepIndex,
  nodeType,
  status,
  name,
  assigneeUserId,
  parallelGroupId,
  parallelBranchToken,
}: {
  workspaceId: string;
  processRunId: string;
  stepIndex: number;
  nodeType: StepNodeType;
  status: "pending" | "active" | "completed" | "skipped";
  name: string;
  assigneeUserId?: string;
  parallelGroupId?: string;
  parallelBranchToken?: string;
}) {
  const admin = createSupabaseTestClient();
  const stepId = randomUUID();
  const isReached = status !== "pending" && status !== "skipped";
  const startedAt = isReached ? new Date().toISOString() : null;
  const completedAt = status === "completed" ? new Date().toISOString() : null;
  const config =
    nodeType === "wait" ? { wait_rule: { kind: "duration", amount: 1, unit: "hours" } } : {};
  const resumeAt = nodeType === "wait" && isReached ? new Date(Date.now() + 60_000).toISOString() : null;

  const { error } = await admin.from("process_step_runs").insert({
    id: stepId,
    workspace_id: workspaceId,
    process_run_id: processRunId,
    step_index: stepIndex,
    node_type: nodeType,
    parallel_group_id: parallelGroupId ?? null,
    parallel_branch_token: parallelBranchToken ?? null,
    name,
    config,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    resume_at: resumeAt,
    assignee_user_id: nodeType === "human_task" || nodeType === "approval" ? (assigneeUserId ?? null) : null,
  });
  if (error) throw new Error(error.message);
  return stepId;
}

async function createNode({
  workspaceId,
  templateId,
  position,
  name,
}: {
  workspaceId: string;
  templateId: string;
  position: number;
  name: string;
}) {
  const admin = createSupabaseTestClient();
  const nodeId = randomUUID();
  const { error } = await admin.from("process_nodes").insert({
    id: nodeId,
    workspace_id: workspaceId,
    process_template_id: templateId,
    node_type: "human_task",
    name,
    position,
    config: {},
  });
  if (error) throw new Error(error.message);
  return nodeId;
}

// branch_token is a genuine FK to process_step_run_routes(id) -- a parallel
// branch's token IS the id of the route that fanned it out, not an
// arbitrary generated value. Creates a minimal parallel-split route (source
// -> target) and returns its id for use as both the route's own id and the
// branch step's parallel_branch_token.
async function createParallelRoute({
  workspaceId,
  processRunId,
  sourceStepRunId,
  targetStepRunId,
}: {
  workspaceId: string;
  processRunId: string;
  sourceStepRunId: string;
  targetStepRunId: string;
}) {
  const admin = createSupabaseTestClient();
  const routeId = randomUUID();
  const { error } = await admin.from("process_step_run_routes").insert({
    id: routeId,
    workspace_id: workspaceId,
    process_run_id: processRunId,
    source_step_run_id: sourceStepRunId,
    target_step_run_id: targetStepRunId,
    priority: 0,
    is_default: false,
    is_parallel: true,
    condition_config: null,
  });
  if (error) throw new Error(error.message);
  return routeId;
}

async function createJoinObligation({
  workspaceId,
  processRunId,
  joinStepRunId,
  parallelGroupId,
  branchToken,
}: {
  workspaceId: string;
  processRunId: string;
  joinStepRunId: string;
  parallelGroupId: string;
  branchToken: string;
}) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("process_parallel_join_obligations").insert({
    id: randomUUID(),
    workspace_id: workspaceId,
    process_run_id: processRunId,
    join_step_run_id: joinStepRunId,
    parallel_group_id: parallelGroupId,
    branch_token: branchToken,
    arrived_at: null,
  });
  if (error) throw new Error(error.message);
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function cancelRun(
  client: SupabaseClient,
  processRunId: string,
  reason: string | null,
  workspaceId = fixture.workspaceId,
) {
  return client.rpc("cancel_process_run_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_reason: reason,
  });
}

async function createFixture(): Promise<Fixture> {
  const workspaceId = await createWorkspace("E2E Process Run Cancellation");
  const otherWorkspaceId = await createWorkspace("E2E Process Run Cancellation Other");

  const operatorRoleId = await createRole(workspaceId, "Process operator", ["processes.operate"]);
  const readOnlyRoleId = await createRole(workspaceId, "Read only", []);
  const administratorRoleId = await createRole(workspaceId, "Administrator", [
    "processes.operate",
    "workspace.impersonate_users",
  ]);
  const otherOperatorRoleId = await createRole(otherWorkspaceId, "Other process operator", ["processes.operate"]);

  const worker = await createUser("worker");
  const readOnly = await createUser("read-only");
  const administrator = await createUser("administrator");
  const otherWorker = await createUser("other-worker");

  await addMembership(workspaceId, worker.id, operatorRoleId);
  await addMembership(workspaceId, readOnly.id, readOnlyRoleId);
  await addMembership(workspaceId, administrator.id, administratorRoleId);
  await addMembership(otherWorkspaceId, otherWorker.id, otherOperatorRoleId);

  const entityTypeId = await createEntityType(
    workspaceId,
    `Process Run Cancellation Object ${workspaceId.slice(0, 6)}`,
  );
  const templateId = await createTemplate(workspaceId, entityTypeId, "Cancellation template");
  // start_process_run_authorized requires a template to have at least one
  // node -- only exercised by the "start a new run after cancellation" test,
  // but harmless to have on the shared template otherwise.
  await createNode({ workspaceId, templateId, position: 1, name: "Review it" });

  return { workspaceId, otherWorkspaceId, entityTypeId, templateId, worker, readOnly, administrator, otherWorker };
}

beforeAll(async () => {
  fixture = await createFixture();
}, 45_000);

beforeEach(async () => {
  await endAnyActiveSession(await administratorClient());
});

afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];

  if (createdWorkspaceIds.length > 0) {
    for (const table of [
      "process_parallel_join_obligations",
      "workspace_events",
      "process_step_runs",
      "process_runs",
      "process_templates",
      "field_definitions",
      "entity_records",
      "entity_types",
      "workspaces",
    ]) {
      const { error } = await admin
        .from(table)
        .delete()
        .in(table === "workspaces" ? "id" : "workspace_id", createdWorkspaceIds);
      if (error) failures.push(`${table}: ${error.message}`);
    }
  }

  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) {
    throw new Error(`process-run-cancellation-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 45_000);

describe("cancel_process_run_authorized: node-type coverage", () => {
  it.each([
    ["human_task" as const, "Review it"],
    ["approval" as const, "Approve it"],
    ["wait" as const, "Wait internally"],
    ["condition_wait" as const, "Wait for a condition"],
    ["action" as const, "Run an action"],
  ])("cancels a run with an active %s step", async (nodeType, name) => {
    const admin = createSupabaseTestClient();
    const workerClient = await authenticatedClient(fixture.worker);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, `Record for ${nodeType}`);
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    const stepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType,
      status: "active",
      name,
      assigneeUserId: nodeType === "human_task" || nodeType === "approval" ? fixture.worker.id : undefined,
    });

    const result = await cancelRun(workerClient, runId, "No longer needed.");
    expect(result.error).toBeNull();

    const run = await admin.from("process_runs").select("*").eq("id", runId).single();
    expect(run.error).toBeNull();
    expect(run.data).toMatchObject({
      status: "cancelled",
      completed_at: null,
      cancellation_reason: "No longer needed.",
      cancelled_by_user_id: fixture.worker.id,
      cancelled_by_real_actor_user_id: null,
    });
    expect(run.data?.cancelled_at).not.toBeNull();
    expect(run.data?.cancelled_by_label).toBe(fixture.worker.email);

    const step = await admin.from("process_step_runs").select("*").eq("id", stepId).single();
    expect(step.error).toBeNull();
    expect(step.data?.status).toBe("cancelled");
    expect(step.data?.due_at).toBeNull();
    expect(step.data?.completed_at).toBeNull();
  });
});

describe("cancel_process_run_authorized: unfinished-work transitions", () => {
  it("cancels active and pending siblings while preserving completed/skipped history exactly", async () => {
    const admin = createSupabaseTestClient();
    const workerClient = await authenticatedClient(fixture.worker);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for siblings");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });

    const completedStepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "completed",
      name: "Already done",
    });
    const skippedStepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 2,
      nodeType: "human_task",
      status: "skipped",
      name: "Routed around",
    });
    const activeStepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 3,
      nodeType: "human_task",
      status: "active",
      name: "In progress",
      assigneeUserId: fixture.worker.id,
    });
    const pendingStepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 4,
      nodeType: "human_task",
      status: "pending",
      name: "Never reached",
    });

    const before = await admin
      .from("process_step_runs")
      .select("*")
      .in("id", [completedStepId, skippedStepId]);
    expect(before.error).toBeNull();

    const result = await cancelRun(workerClient, runId, "Abandoning this run.");
    expect(result.error).toBeNull();

    const after = await admin
      .from("process_step_runs")
      .select("*")
      .in("id", [completedStepId, skippedStepId, activeStepId, pendingStepId]);
    expect(after.error).toBeNull();
    const byId = new Map((after.data ?? []).map((row) => [row.id, row]));

    expect(byId.get(completedStepId)).toEqual(before.data?.find((row) => row.id === completedStepId));
    expect(byId.get(skippedStepId)).toEqual(before.data?.find((row) => row.id === skippedStepId));
    expect(byId.get(activeStepId)?.status).toBe("cancelled");
    expect(byId.get(pendingStepId)?.status).toBe("cancelled");
  });

  it("cancels an unarrived parallel branch without disturbing its join obligation", async () => {
    const admin = createSupabaseTestClient();
    const workerClient = await authenticatedClient(fixture.worker);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for parallel");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    const parallelGroupId = randomUUID();

    const splitStepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "completed",
      name: "Split (stand-in)",
    });
    const joinStepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 2,
      nodeType: "parallel_join",
      status: "pending",
      name: "Join",
      parallelGroupId,
    });
    const branchStepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 3,
      nodeType: "human_task",
      status: "active",
      name: "Branch A",
      assigneeUserId: fixture.worker.id,
      parallelGroupId,
    });
    // branch_token is a genuine FK to process_step_run_routes(id) -- create
    // the fan-out route first, then stamp the branch step with it.
    const branchToken = await createParallelRoute({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      sourceStepRunId: splitStepId,
      targetStepRunId: branchStepId,
    });
    const tokenUpdate = await createSupabaseTestClient()
      .from("process_step_runs")
      .update({ parallel_branch_token: branchToken })
      .eq("id", branchStepId);
    if (tokenUpdate.error) throw new Error(tokenUpdate.error.message);
    await createJoinObligation({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      joinStepRunId: joinStepId,
      parallelGroupId,
      branchToken,
    });

    const result = await cancelRun(workerClient, runId, "Abandoning mid-branch.");
    expect(result.error).toBeNull();

    const branchStep = await admin.from("process_step_runs").select("status").eq("id", branchStepId).single();
    expect(branchStep.data?.status).toBe("cancelled");

    const obligation = await admin
      .from("process_parallel_join_obligations")
      .select("arrived_at, arrival_source_step_run_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("join_step_run_id", joinStepId)
      .single();
    expect(obligation.error).toBeNull();
    expect(obligation.data).toEqual({ arrived_at: null, arrival_source_step_run_id: null });
  });
});

describe("cancel_process_run_authorized: post-cancel effects", () => {
  it("rejects further advancement on a cancelled run and frees the origin for a new run", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for reuse");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    const stepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "In progress",
      assigneeUserId: fixture.worker.id,
    });

    const cancelResult = await cancelRun(workerClient, runId, "Stopping this run.");
    expect(cancelResult.error).toBeNull();

    const completeResult = await workerClient.rpc("complete_process_step_run_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: runId,
      p_step_run_id: stepId,
    });
    expect(completeResult.error).not.toBeNull();
    expect(completeResult.error?.message ?? "").toMatch(/not active/i);

    const secondCancel = await cancelRun(workerClient, runId, "Second attempt.");
    expect(secondCancel.error).not.toBeNull();
    expect(secondCancel.error?.message ?? "").toMatch(/not active/i);

    const newRun = await workerClient.rpc("start_process_run_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_template_id: fixture.templateId,
      p_origin_entity_type_id: fixture.entityTypeId,
      p_origin_record_id: recordId,
    });
    expect(newRun.error).toBeNull();
    expect(typeof newRun.data).toBe("string");
  });

  it("records a process_cancelled Activity event with the reason and surfaces it via list_record_activity_authorized", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for activity");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "In progress",
      assigneeUserId: fixture.worker.id,
    });

    const result = await cancelRun(workerClient, runId, "Recorded in Activity.");
    expect(result.error).toBeNull();

    const activity = await workerClient.rpc("list_record_activity_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: recordId,
      p_limit: 20,
    });
    expect(activity.error).toBeNull();
    const row = (activity.data as Array<Record<string, unknown>>)?.find(
      (event) => event.event_type === "process_cancelled",
    );
    expect(row).toMatchObject({
      process_run_id: runId,
      cancellation_reason: "Recorded in Activity.",
      actor_label: fixture.worker.email,
    });
  });
});

describe("cancel_process_run_authorized: authorization and validation", () => {
  it("rejects a blank or missing reason", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for blank reason");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "In progress",
    });

    const blank = await cancelRun(workerClient, runId, "   ");
    expect(blank.error).not.toBeNull();
    expect(blank.error?.message ?? "").toMatch(/reason/i);

    const missing = await cancelRun(workerClient, runId, null);
    expect(missing.error).not.toBeNull();
    expect(missing.error?.message ?? "").toMatch(/reason/i);
  });

  it("rejects a caller without processes.operate", async () => {
    const readOnlyClient = await authenticatedClient(fixture.readOnly);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for read-only");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "In progress",
    });

    const result = await cancelRun(readOnlyClient, runId, "Should not be allowed.");
    expect(result.error).not.toBeNull();
  });

  it("rejects a run id from another workspace", async () => {
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for cross-workspace");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "In progress",
    });

    const result = await cancelRun(otherWorkerClient, runId, "Cross-workspace attempt.", fixture.otherWorkspaceId);
    expect(result.error).not.toBeNull();
  });

  it("stores effective and real actor for an impersonated cancellation", async () => {
    const admin = createSupabaseTestClient();
    const adminClient = await administratorClient();
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for impersonation");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "In progress",
    });

    const startImpersonating = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.worker.id,
    });
    expect(startImpersonating.error).toBeNull();

    const result = await cancelRun(adminClient, runId, "Impersonated cancellation.");
    expect(result.error).toBeNull();

    const run = await admin
      .from("process_runs")
      .select("cancelled_by_user_id, cancelled_by_real_actor_user_id, cancelled_by_label")
      .eq("id", runId)
      .single();
    expect(run.error).toBeNull();
    expect(run.data).toEqual({
      cancelled_by_user_id: fixture.worker.id,
      cancelled_by_real_actor_user_id: fixture.administrator.id,
      cancelled_by_label: fixture.worker.email,
    });
  });
});
