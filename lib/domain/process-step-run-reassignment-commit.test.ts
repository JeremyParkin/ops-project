// DB/RPC-level verification for Phase 11.2 Reassign Active Human Work
// (reassign_process_step_run_authorized, migration 0094). Covers:
// self-reassignment of human_task/approval, target validation, rejection
// matrix (wrong node type, wrong status, wrong caller, wrong capability,
// cross-workspace, deactivated/nonexistent target, same-assignee),
// due_at preservation, assignment_generation increments including a real
// A -> B -> A sequence, My Work ownership movement, legacy vs. suffixed
// notification dedup-key behavior across generations, scheduler/
// reassignment serialization (sequential-order proof), step_reassigned
// Activity metadata and actor/effective-actor attribution, and
// notification/Activity linkage.
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
  workerA: User;
  workerB: User;
  workerC: User;
  readOnly: User;
  administrator: User;
  otherWorker: User;
  deactivated: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
let administratorClientPromise: Promise<SupabaseClient> | undefined;

function uniqueEmail(label: string) {
  return `e2e-step-reassignment-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `StepReassign-${randomUUID()}!`;
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
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  templateId: string;
}) {
  const admin = createSupabaseTestClient();
  const runId = randomUUID();
  const { error } = await admin.from("process_runs").insert({
    id: runId,
    workspace_id: workspaceId,
    process_template_id: templateId,
    process_template_name: "Reassignment template",
    origin_entity_type_id: entityTypeId,
    origin_record_id: recordId,
    status: "active",
  });
  if (error) throw new Error(error.message);
  return runId;
}

type StepNodeType =
  | "human_task"
  | "approval"
  | "wait"
  | "condition_wait"
  | "action"
  | "external_event_wait"
  | "parallel_join";

async function createStep({
  workspaceId,
  processRunId,
  stepIndex,
  nodeType,
  status,
  name,
  assigneeUserId,
  assigneeLabel,
  dueAt,
}: {
  workspaceId: string;
  processRunId: string;
  stepIndex: number;
  nodeType: StepNodeType;
  status: "pending" | "active" | "completed" | "skipped" | "cancelled";
  name: string;
  assigneeUserId?: string;
  assigneeLabel?: string;
  dueAt?: string | null;
}) {
  const admin = createSupabaseTestClient();
  const stepId = randomUUID();
  const isReached = status === "active" || status === "completed" || status === "cancelled";
  const startedAt = isReached ? new Date().toISOString() : null;
  const completedAt = status === "completed" ? new Date().toISOString() : null;
  const config = nodeType === "wait" ? { wait_rule: { kind: "duration", amount: 1, unit: "hours" } } : {};
  const resumeAt = nodeType === "wait" && isReached ? new Date(Date.now() + 60_000).toISOString() : null;
  const canHaveAssignee = nodeType === "human_task" || nodeType === "approval";
  const canHaveDueAt = canHaveAssignee;
  const externalWaitId = nodeType === "external_event_wait" && isReached ? randomUUID() : null;

  const { error } = await admin.from("process_step_runs").insert({
    id: stepId,
    workspace_id: workspaceId,
    process_run_id: processRunId,
    step_index: stepIndex,
    node_type: nodeType,
    name,
    config,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    resume_at: resumeAt,
    external_wait_id: externalWaitId,
    due_at: canHaveDueAt ? (dueAt ?? null) : null,
    assignee_user_id: canHaveAssignee ? (assigneeUserId ?? null) : null,
    assignee_label: canHaveAssignee ? (assigneeLabel ?? null) : null,
  });
  if (error) throw new Error(error.message);
  return stepId;
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function reassign(
  client: SupabaseClient,
  args: { processRunId: string; stepRunId: string; newAssigneeUserId: string; reason?: string | null },
  workspaceId = fixture.workspaceId,
) {
  return client.rpc("reassign_process_step_run_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: args.processRunId,
    p_step_run_id: args.stepRunId,
    p_new_assignee_user_id: args.newAssigneeUserId,
    p_reason: args.reason ?? null,
  });
}

async function createFixture(): Promise<Fixture> {
  const workspaceId = await createWorkspace("E2E Step Reassignment");
  const otherWorkspaceId = await createWorkspace("E2E Step Reassignment Other");

  const operatorRoleId = await createRole(workspaceId, "Process operator", ["processes.operate"]);
  const readOnlyRoleId = await createRole(workspaceId, "Read only", []);
  const administratorRoleId = await createRole(workspaceId, "Administrator", [
    "processes.operate",
    "workspace.impersonate_users",
  ]);
  const otherOperatorRoleId = await createRole(otherWorkspaceId, "Other process operator", ["processes.operate"]);

  const workerA = await createUser("worker-a");
  const workerB = await createUser("worker-b");
  const workerC = await createUser("worker-c");
  const readOnly = await createUser("read-only");
  const administrator = await createUser("administrator");
  const otherWorker = await createUser("other-worker");
  const deactivated = await createUser("deactivated");

  await addMembership(workspaceId, workerA.id, operatorRoleId);
  await addMembership(workspaceId, workerB.id, operatorRoleId);
  await addMembership(workspaceId, workerC.id, operatorRoleId);
  await addMembership(workspaceId, readOnly.id, readOnlyRoleId);
  await addMembership(workspaceId, administrator.id, administratorRoleId);
  await addMembership(workspaceId, deactivated.id, operatorRoleId);
  await addMembership(otherWorkspaceId, otherWorker.id, otherOperatorRoleId);

  const admin = createSupabaseTestClient();
  const { error: deactivateError } = await admin
    .from("workspace_memberships")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("user_id", deactivated.id);
  if (deactivateError) throw new Error(deactivateError.message);

  const entityTypeId = await createEntityType(workspaceId, `Step Reassignment Object ${workspaceId.slice(0, 6)}`);
  const templateId = await createTemplate(workspaceId, entityTypeId, "Reassignment template");

  return {
    workspaceId,
    otherWorkspaceId,
    entityTypeId,
    templateId,
    workerA,
    workerB,
    workerC,
    readOnly,
    administrator,
    otherWorker,
    deactivated,
  };
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
      "notifications",
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
    throw new Error(`process-step-run-reassignment-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 45_000);

describe("reassign_process_step_run_authorized: node-type coverage", () => {
  it.each([
    ["human_task" as const, "Review it"],
    ["approval" as const, "Approve it"],
  ])("self-reassigns an active %s to another current member", async (nodeType, name) => {
    const admin = createSupabaseTestClient();
    const workerAClient = await authenticatedClient(fixture.workerA);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, `Record for ${nodeType}`);
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    const dueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const stepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType,
      status: "active",
      name,
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
      dueAt,
    });

    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Out of office.",
    });
    expect(result.error).toBeNull();

    const step = await admin.from("process_step_runs").select("*").eq("id", stepId).single();
    expect(step.error).toBeNull();
    expect(step.data).toMatchObject({
      assignee_user_id: fixture.workerB.id,
      assignee_label: fixture.workerB.email,
      assignment_generation: 2,
      status: "active",
    });
    expect(new Date(step.data!.due_at).getTime()).toBe(new Date(dueAt).getTime());
  });

  it.each([
    ["wait" as const, "Wait"],
    ["condition_wait" as const, "Wait for condition"],
    ["action" as const, "Run action"],
    ["external_event_wait" as const, "Wait for event"],
    ["parallel_join" as const, "Join"],
  ])("rejects reassignment of an active %s node", async (nodeType, name) => {
    const workerAClient = await authenticatedClient(fixture.workerA);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, `Record for ${nodeType} reject`);
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
    });

    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/cannot be reassigned/i);
  });
});

describe("reassign_process_step_run_authorized: status and target validation", () => {
  it.each([
    ["pending" as const],
    ["completed" as const],
    ["skipped" as const],
    ["cancelled" as const],
  ])("rejects reassignment of a %s human_task", async (status) => {
    const workerAClient = await authenticatedClient(fixture.workerA);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, `Record for ${status}`);
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
      status,
      name: "Not active",
      assigneeUserId: status === "pending" ? undefined : fixture.workerA.id,
      assigneeLabel: status === "pending" ? undefined : fixture.workerA.email,
    });

    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
    });
    expect(result.error).not.toBeNull();
  });

  async function activeAssignedStep(assignee = fixture.workerA) {
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for target checks");
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
      name: "Target checks",
      assigneeUserId: assignee.id,
      assigneeLabel: assignee.email,
    });
    return { runId, stepId };
  }

  it("rejects reassignment to the current assignee (same-assignee)", async () => {
    const workerAClient = await authenticatedClient(fixture.workerA);
    const { runId, stepId } = await activeAssignedStep();
    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerA.id,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/already assigned/i);
  });

  it("rejects a deactivated target member", async () => {
    const workerAClient = await authenticatedClient(fixture.workerA);
    const { runId, stepId } = await activeAssignedStep();
    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.deactivated.id,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a current member/i);
  });

  it("rejects a nonexistent target user id", async () => {
    const workerAClient = await authenticatedClient(fixture.workerA);
    const { runId, stepId } = await activeAssignedStep();
    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: randomUUID(),
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a current member/i);
  });

  it("rejects a foreign-workspace target user id", async () => {
    const workerAClient = await authenticatedClient(fixture.workerA);
    const { runId, stepId } = await activeAssignedStep();
    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.otherWorker.id,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a current member/i);
  });

  it("rejects a caller without processes.operate", async () => {
    const readOnlyClient = await authenticatedClient(fixture.readOnly);
    const { runId, stepId } = await activeAssignedStep();
    const result = await reassign(readOnlyClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
    });
    expect(result.error).not.toBeNull();
  });

  it("rejects a caller who is not the current effective assignee", async () => {
    const workerBClient = await authenticatedClient(fixture.workerB);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);
    const result = await reassign(workerBClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerC.id,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/only the current assignee/i);
  });

  it("rejects any caller on an unassigned active step, including a processes.operate holder", async () => {
    const workerAClient = await authenticatedClient(fixture.workerA);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for unassigned");
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
      name: "Unassigned",
    });
    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/only the current assignee/i);
  });

  it("rejects a run id from another workspace", async () => {
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const { runId, stepId } = await activeAssignedStep();
    const result = await reassign(
      otherWorkerClient,
      { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.otherWorker.id },
      fixture.otherWorkspaceId,
    );
    expect(result.error).not.toBeNull();
  });
});

describe("reassign_process_step_run_authorized: A -> B -> A generations", () => {
  it("increments assignment_generation once per handoff and preserves due_at throughout", async () => {
    const admin = createSupabaseTestClient();
    const workerAClient = await authenticatedClient(fixture.workerA);
    const workerBClient = await authenticatedClient(fixture.workerB);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for A-B-A");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    const dueAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const stepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "A to B to A",
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
      dueAt,
    });

    const dueAtMillis = new Date(dueAt).getTime();
    const initial = await admin.from("process_step_runs").select("assignment_generation, due_at").eq("id", stepId).single();
    expect(initial.data?.assignment_generation).toBe(1);
    expect(new Date(initial.data!.due_at).getTime()).toBe(dueAtMillis);

    const aToB = await reassign(workerAClient, { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.workerB.id });
    expect(aToB.error).toBeNull();
    const afterAToB = await admin.from("process_step_runs").select("assignee_user_id, assignment_generation, due_at").eq("id", stepId).single();
    expect(afterAToB.data).toMatchObject({ assignee_user_id: fixture.workerB.id, assignment_generation: 2 });
    expect(new Date(afterAToB.data!.due_at).getTime()).toBe(dueAtMillis);

    const bToA = await reassign(workerBClient, { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.workerA.id });
    expect(bToA.error).toBeNull();
    const afterBToA = await admin.from("process_step_runs").select("assignee_user_id, assignment_generation, due_at").eq("id", stepId).single();
    expect(afterBToA.data).toMatchObject({ assignee_user_id: fixture.workerA.id, assignment_generation: 3 });
    expect(new Date(afterBToA.data!.due_at).getTime()).toBe(dueAtMillis);
  });

  it("gives My Work ownership to the new assignee immediately and removes it from the old one", async () => {
    const workerAClient = await authenticatedClient(fixture.workerA);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for My Work movement");
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
      name: "My Work movement",
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
    });

    const result = await reassign(workerAClient, { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.workerB.id });
    expect(result.error).toBeNull();

    // My Work / Team Work are live-derived from process_step_runs.assignee_user_id +
    // status = 'active' (no snapshot layer) -- confirmed directly rather than via
    // the app's own listAssignedWorkItems, which requires a full page-render fixture.
    const admin = createSupabaseTestClient();
    const stepRow = await admin.from("process_step_runs").select("assignee_user_id, status").eq("id", stepId).single();
    expect(stepRow.data).toEqual({ assignee_user_id: fixture.workerB.id, status: "active" });
  });
});

describe("reassign_process_step_run_authorized: notification dedup keys across generations", () => {
  it("generation 1 keeps the legacy unsuffixed due-soon/overdue keys and does not duplicate an existing generation-1 notification", async () => {
    const admin = createSupabaseTestClient();
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for legacy keys");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    const dueSoonAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const stepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "Legacy key",
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
      dueAt: dueSoonAt,
    });

    const firstPass = await admin.rpc("generate_step_due_soon_notifications_system", { p_limit: 100 });
    expect(firstPass.error).toBeNull();

    const legacyKeyRow = await admin
      .from("notifications")
      .select("id, dedup_key, recipient_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("dedup_key", `due_soon:${stepId}`)
      .maybeSingle();
    expect(legacyKeyRow.error).toBeNull();
    expect(legacyKeyRow.data).toMatchObject({ recipient_user_id: fixture.workerA.id, dedup_key: `due_soon:${stepId}` });

    const secondPass = await admin.rpc("generate_step_due_soon_notifications_system", { p_limit: 100 });
    expect(secondPass.error).toBeNull();

    const allDueSoonForStep = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_id", stepId)
      .eq("event_type", "step_due_soon");
    expect(allDueSoonForStep.data).toHaveLength(1);
  });

  it("generation 2+ uses a fresh suffixed due-soon key and does not touch the generation-1 notification", async () => {
    const admin = createSupabaseTestClient();
    const workerAClient = await authenticatedClient(fixture.workerA);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for suffixed keys");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    const dueSoonAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const stepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "Suffixed key",
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
      dueAt: dueSoonAt,
    });

    await admin.rpc("generate_step_due_soon_notifications_system", { p_limit: 100 });
    const genOneRow = await admin
      .from("notifications")
      .select("id, dedup_key, created_at")
      .eq("workspace_id", fixture.workspaceId)
      .eq("dedup_key", `due_soon:${stepId}`)
      .single();
    expect(genOneRow.error).toBeNull();

    const reassignResult = await reassign(workerAClient, { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.workerB.id });
    expect(reassignResult.error).toBeNull();

    await admin.rpc("generate_step_due_soon_notifications_system", { p_limit: 100 });

    const genTwoRow = await admin
      .from("notifications")
      .select("id, dedup_key, recipient_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("dedup_key", `due_soon:${stepId}:2`)
      .maybeSingle();
    expect(genTwoRow.error).toBeNull();
    expect(genTwoRow.data).toMatchObject({ recipient_user_id: fixture.workerB.id });

    // The generation-1 row is untouched -- same id, same content.
    const genOneRowAfter = await admin
      .from("notifications")
      .select("id, dedup_key, recipient_user_id")
      .eq("id", genOneRow.data!.id)
      .single();
    expect(genOneRowAfter.data).toEqual({
      id: genOneRow.data!.id,
      dedup_key: `due_soon:${stepId}`,
      recipient_user_id: fixture.workerA.id,
    });
  });

  it("proves scheduler/reassignment serialization by sequential ordering: a due-soon pass after reassignment never uses stale pre-reassignment values", async () => {
    const admin = createSupabaseTestClient();
    const workerAClient = await authenticatedClient(fixture.workerA);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for serialization proof");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId,
      templateId: fixture.templateId,
    });
    const overdueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "Serialization proof",
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
      dueAt: overdueAt,
    });

    // Pass 1 (generation 1, A): legacy key, A recipient.
    await admin.rpc("generate_step_overdue_notifications_system", { p_limit: 100 });
    // Reassign A -> B (generation 2) in between passes.
    const reassignResult = await reassign(workerAClient, { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.workerB.id });
    expect(reassignResult.error).toBeNull();
    // Pass 2 (generation 2, B): must use the post-commit row image -- B, key :2.
    await admin.rpc("generate_step_overdue_notifications_system", { p_limit: 100 });

    const rows = await admin
      .from("notifications")
      .select("dedup_key, recipient_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_id", stepId)
      .eq("event_type", "step_overdue")
      .order("dedup_key");
    expect(rows.data).toEqual([
      { dedup_key: `overdue:${stepId}`, recipient_user_id: fixture.workerA.id },
      { dedup_key: `overdue:${stepId}:2`, recipient_user_id: fixture.workerB.id },
    ]);
  });
});

describe("reassign_process_step_run_authorized: step_assigned notification per episode", () => {
  it("creates a fresh step_assigned notification for the new assignee, and A -> B -> A gives A a fresh notification on the later episode", async () => {
    const admin = createSupabaseTestClient();
    const workerAClient = await authenticatedClient(fixture.workerA);
    const workerBClient = await authenticatedClient(fixture.workerB);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for assignment notifications");
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
      name: "Assignment notifications",
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
    });

    const aToB = await reassign(workerAClient, { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.workerB.id });
    expect(aToB.error).toBeNull();
    const bNotification = await admin
      .from("notifications")
      .select("recipient_user_id, dedup_key, event_type")
      .eq("workspace_id", fixture.workspaceId)
      .eq("dedup_key", `assignment:${stepId}:2`)
      .single();
    expect(bNotification.data).toMatchObject({ recipient_user_id: fixture.workerB.id, event_type: "step_assigned" });

    const bToA = await reassign(workerBClient, { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.workerA.id });
    expect(bToA.error).toBeNull();
    const aSecondNotification = await admin
      .from("notifications")
      .select("recipient_user_id, dedup_key, event_type")
      .eq("workspace_id", fixture.workspaceId)
      .eq("dedup_key", `assignment:${stepId}:3`)
      .single();
    expect(aSecondNotification.data).toMatchObject({ recipient_user_id: fixture.workerA.id, event_type: "step_assigned" });

    const allAssignmentNotifications = await admin
      .from("notifications")
      .select("dedup_key")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_id", stepId)
      .eq("event_type", "step_assigned")
      .order("dedup_key");
    expect(allAssignmentNotifications.data?.map((row) => row.dedup_key)).toEqual([
      `assignment:${stepId}:2`,
      `assignment:${stepId}:3`,
    ]);
  });
});

describe("reassign_process_step_run_authorized: step_reassigned Activity", () => {
  it("records frozen from/to labels, generation, reason, and actor attribution, linked to the notification", async () => {
    const admin = createSupabaseTestClient();
    const workerAClient = await authenticatedClient(fixture.workerA);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for Activity");
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
      name: "Handoff",
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
    });

    const result = await reassign(workerAClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Handing off before PTO.",
    });
    expect(result.error).toBeNull();

    const event = await admin
      .from("workspace_events")
      .select("actor_user_id, real_actor_user_id, metadata")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_id", stepId)
      .eq("event_type", "step_reassigned")
      .single();
    expect(event.error).toBeNull();
    expect(event.data?.actor_user_id).toBe(fixture.workerA.id);
    expect(event.data?.real_actor_user_id).toBeNull();
    expect(event.data?.metadata).toMatchObject({
      from_assignee_user_id: fixture.workerA.id,
      from_assignee_label: fixture.workerA.email,
      to_assignee_user_id: fixture.workerB.id,
      to_assignee_label: fixture.workerB.email,
      assignment_generation: 2,
      reason: "Handing off before PTO.",
    });

    // Notification/Activity linkage: the step_assigned notification's
    // workspace_event_id points at this exact step_reassigned event.
    const notification = await admin
      .from("notifications")
      .select("workspace_event_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("dedup_key", `assignment:${stepId}:2`)
      .single();
    expect(notification.data?.workspace_event_id).toBe(
      (await admin.from("workspace_events").select("id").eq("workspace_id", fixture.workspaceId).eq("process_step_run_id", stepId).eq("event_type", "step_reassigned").single()).data?.id,
    );

    const activity = await workerAClient.rpc("list_record_activity_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: recordId,
      p_limit: 20,
    });
    expect(activity.error).toBeNull();
    const row = (activity.data as Array<Record<string, unknown>>)?.find((e) => e.event_type === "step_reassigned");
    expect(row).toMatchObject({
      from_assignee_label: fixture.workerA.email,
      to_assignee_label: fixture.workerB.email,
    });
  });

  it("stores effective and real actor for an impersonated reassignment", async () => {
    const admin = createSupabaseTestClient();
    const adminClient = await administratorClient();
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for impersonated reassignment");
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
      name: "Impersonated handoff",
      assigneeUserId: fixture.workerA.id,
      assigneeLabel: fixture.workerA.email,
    });

    const startImpersonating = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.workerA.id,
    });
    expect(startImpersonating.error).toBeNull();

    const result = await reassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
    });
    expect(result.error).toBeNull();

    const event = await admin
      .from("workspace_events")
      .select("actor_user_id, real_actor_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_id", stepId)
      .eq("event_type", "step_reassigned")
      .single();
    expect(event.data).toEqual({
      actor_user_id: fixture.workerA.id,
      real_actor_user_id: fixture.administrator.id,
    });
  });
});

describe("reassign_process_step_run_authorized: no regression to ordinary initial assignment", () => {
  it("leaves a never-reassigned step's initial assignment_generation at 1 with its original assignee_label", async () => {
    const admin = createSupabaseTestClient();
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for initial assignment");
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
      name: "Untouched",
      assigneeUserId: fixture.workerC.id,
      assigneeLabel: fixture.workerC.email,
    });

    const step = await admin.from("process_step_runs").select("assignee_user_id, assignee_label, assignment_generation").eq("id", stepId).single();
    expect(step.data).toEqual({
      assignee_user_id: fixture.workerC.id,
      assignee_label: fixture.workerC.email,
      assignment_generation: 1,
    });
  });
});
