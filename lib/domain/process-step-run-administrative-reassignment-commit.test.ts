// DB/RPC-level verification for Phase 11.3 Administrative Reassignment
// Authority (reassign_process_step_run_administrative_authorized, migration
// 0095). Covers: the workspace.manage_members + workspace.manage_roles +
// processes.operate authorization conjunction (built-in Workspace
// administrator and an equivalent custom role), every rejection path
// (operate-only, governance-only, manager visibility alone, unrelated
// custom role, cross-workspace, mandatory reason, same-assignee, target
// validation, node-type/status guards), the shared mutation core's
// unchanged-from-0094 behavior (due_at preservation, single generation
// increment, generation-aware step_assigned notification, untouched
// notification/event history, step_reassigned Activity attribution), the
// ownership-only guarantee (an administrator who reassigns someone else's
// step still cannot complete it themselves), and the impersonation
// boundary (rejected while an impersonation session is open, not blocked
// by a since-ended one).
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  deactivated: User;
  otherWorker: User;
  builtInAdministrator: User;
  customAdmin: User;
  operatorOnly: User;
  governanceOnly: User;
  manager: User;
  unrelated: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;

function uniqueEmail(label: string) {
  return `e2e-admin-reassignment-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `AdminReassign-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: uniqueEmail(label),
    password,
    email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email: data.user.email, password };
}

// Memoized per user id -- this file's authorization matrix reuses a small
// fixed cast (builtInAdministrator, workerA, ...) across many independent
// `it` cases, and each fresh signInWithPassword call counts against
// Supabase Auth's sign-in rate limit. Caching one session per user avoids
// manufacturing that known environmental flake through this file's own
// test design, the same way the Phase 11.2 suite already memoizes its one
// administrator client.
const clientCache = new Map<string, Promise<SupabaseClient>>();

async function authenticatedClient(user: User): Promise<SupabaseClient> {
  let cached = clientCache.get(user.id);
  if (!cached) {
    cached = (async () => {
      const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
      const client = createClient(supabaseUrl, supabasePublishableKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
      if (error) throw new Error(error.message);
      return client;
    })();
    clientCache.set(user.id, cached);
  }
  return cached;
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

async function createRole(
  workspaceId: string,
  name: string,
  capabilities: string[],
  { isBuiltin = false }: { isBuiltin?: boolean } = {},
) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin
    .from("workspace_roles")
    .insert({ id: roleId, workspace_id: workspaceId, name, is_builtin: isBuiltin });
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
    process_template_name: "Administrative reassignment template",
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

async function activeAssignedStep(assignee: User, nodeType: StepNodeType = "human_task", dueAt?: string | null) {
  const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for admin reassignment");
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
    name: "Administrative target",
    assigneeUserId: assignee.id,
    assigneeLabel: assignee.email,
    dueAt,
  });
  return { runId, stepId };
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function administrativelyReassign(
  client: SupabaseClient,
  args: { processRunId: string; stepRunId: string; newAssigneeUserId: string; reason?: string | null },
  workspaceId = fixture.workspaceId,
) {
  return client.rpc("reassign_process_step_run_administrative_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: args.processRunId,
    p_step_run_id: args.stepRunId,
    p_new_assignee_user_id: args.newAssigneeUserId,
    p_reason: args.reason ?? null,
  });
}

async function createFixture(): Promise<Fixture> {
  const workspaceId = await createWorkspace("E2E Administrative Reassignment");
  const otherWorkspaceId = await createWorkspace("E2E Administrative Reassignment Other");

  const workerRoleId = await createRole(workspaceId, "Process operator", ["processes.operate"]);
  const otherOperatorRoleId = await createRole(otherWorkspaceId, "Other process operator", ["processes.operate"]);

  // Genuinely is_builtin = true, mirroring the real "Workspace administrator"
  // seed shape (0045/0049) -- proves the RPC authorizes off the capability
  // conjunction, not an is_builtin/role-name special case, while still
  // covering the actual built-in role shape.
  const builtInAdministratorRoleId = await createRole(
    workspaceId,
    "Workspace administrator",
    ["processes.operate", "workspace.manage_members", "workspace.manage_roles", "workspace.impersonate_users"],
    { isBuiltin: true },
  );
  const customAdminRoleId = await createRole(workspaceId, "Process admin (custom)", [
    "processes.operate",
    "workspace.manage_members",
    "workspace.manage_roles",
  ]);
  const operatorOnlyRoleId = await createRole(workspaceId, "Operator only", ["processes.operate"]);
  const governanceOnlyRoleId = await createRole(workspaceId, "Governance only", [
    "workspace.manage_members",
    "workspace.manage_roles",
  ]);
  const managerRoleId = await createRole(workspaceId, "Manager (visibility only)", ["operations.view"]);
  const unrelatedRoleId = await createRole(workspaceId, "Unrelated custom role", [
    "schema.manage",
    "automation.manage",
  ]);

  const workerA = await createUser("worker-a");
  const workerB = await createUser("worker-b");
  const workerC = await createUser("worker-c");
  const deactivated = await createUser("deactivated");
  const otherWorker = await createUser("other-worker");
  const builtInAdministrator = await createUser("builtin-admin");
  const customAdmin = await createUser("custom-admin");
  const operatorOnly = await createUser("operator-only");
  const governanceOnly = await createUser("governance-only");
  const manager = await createUser("manager");
  const unrelated = await createUser("unrelated");

  await addMembership(workspaceId, workerA.id, workerRoleId);
  await addMembership(workspaceId, workerB.id, workerRoleId);
  await addMembership(workspaceId, workerC.id, workerRoleId);
  await addMembership(workspaceId, deactivated.id, workerRoleId);
  await addMembership(workspaceId, builtInAdministrator.id, builtInAdministratorRoleId);
  await addMembership(workspaceId, customAdmin.id, customAdminRoleId);
  await addMembership(workspaceId, operatorOnly.id, operatorOnlyRoleId);
  await addMembership(workspaceId, governanceOnly.id, governanceOnlyRoleId);
  await addMembership(workspaceId, manager.id, managerRoleId);
  await addMembership(workspaceId, unrelated.id, unrelatedRoleId);
  await addMembership(otherWorkspaceId, otherWorker.id, otherOperatorRoleId);

  const admin = createSupabaseTestClient();
  const { error: deactivateError } = await admin
    .from("workspace_memberships")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("user_id", deactivated.id);
  if (deactivateError) throw new Error(deactivateError.message);

  // Manager visibility fixture: workerA reports to `manager` -- proves
  // private.managed_user_ids visibility never substitutes for the
  // administrative capability conjunction (scenario 6).
  const { error: reportingError } = await admin.from("workspace_reporting_relationships").insert({
    workspace_id: workspaceId,
    manager_user_id: manager.id,
    report_user_id: workerA.id,
  });
  if (reportingError) throw new Error(reportingError.message);

  const entityTypeId = await createEntityType(
    workspaceId,
    `Admin Reassignment Object ${workspaceId.slice(0, 6)}`,
  );
  const templateId = await createTemplate(workspaceId, entityTypeId, "Administrative reassignment template");

  return {
    workspaceId,
    otherWorkspaceId,
    entityTypeId,
    templateId,
    workerA,
    workerB,
    workerC,
    deactivated,
    otherWorker,
    builtInAdministrator,
    customAdmin,
    operatorOnly,
    governanceOnly,
    manager,
    unrelated,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
}, 45_000);

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
      "workspace_reporting_relationships",
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
    throw new Error(`process-step-run-administrative-reassignment-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 45_000);

describe("reassign_process_step_run_administrative_authorized: authorization matrix", () => {
  it.each([
    ["human_task" as const],
    ["approval" as const],
  ])("built-in Workspace administrator can administratively reassign an active %s", async (nodeType) => {
    const admin = createSupabaseTestClient();
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA, nodeType);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Worker A is out sick.",
    });
    expect(result.error).toBeNull();

    const step = await admin.from("process_step_runs").select("assignee_user_id, assignee_label, assignment_generation").eq("id", stepId).single();
    expect(step.data).toMatchObject({
      assignee_user_id: fixture.workerB.id,
      assignee_label: fixture.workerB.email,
      assignment_generation: 2,
    });
  });

  it("a custom role with exactly processes.operate + workspace.manage_members + workspace.manage_roles can administratively reassign", async () => {
    const customAdminClient = await authenticatedClient(fixture.customAdmin);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(customAdminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Reassigning during on-call handoff.",
    });
    expect(result.error).toBeNull();
  });

  it("rejects a processes.operate-only caller", async () => {
    const operatorClient = await authenticatedClient(fixture.operatorOnly);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(operatorClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/permission denied/i);
  });

  it("rejects workspace.manage_members + workspace.manage_roles without processes.operate", async () => {
    const governanceClient = await authenticatedClient(fixture.governanceOnly);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(governanceClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/permission denied: processes\.operate/i);
  });

  it("rejects a manager with operations.view / managed_user_ids visibility over the assignee but without the administrative conjunction", async () => {
    const managerClient = await authenticatedClient(fixture.manager);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(managerClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Should be rejected despite being workerA's manager.",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/permission denied/i);
  });

  it("rejects an unrelated custom role (schema.manage + automation.manage)", async () => {
    const unrelatedClient = await authenticatedClient(fixture.unrelated);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(unrelatedClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
  });

  it("rejects a run id from another workspace", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(
      adminClient,
      { processRunId: runId, stepRunId: stepId, newAssigneeUserId: fixture.workerB.id, reason: "Cross-workspace." },
      fixture.otherWorkspaceId,
    );
    expect(result.error).not.toBeNull();
  });

  it.each([[""], ["   "], [null]])("rejects a blank/whitespace/absent reason (%j)", async (reason) => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/reason is required/i);
  });

  it("rejects reassignment to the current assignee (same-assignee)", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerA.id,
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/already assigned/i);
  });

  it("rejects a deactivated target member", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.deactivated.id,
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a current member/i);
  });

  it("rejects a nonexistent target user id", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: randomUUID(),
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a current member/i);
  });

  it("rejects a foreign-workspace target user id", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.otherWorker.id,
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a current member/i);
  });

  it.each([
    ["pending" as const],
    ["completed" as const],
    ["skipped" as const],
    ["cancelled" as const],
  ])("rejects administrative reassignment of a %s human_task", async (status) => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, `Record for admin ${status}`);
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

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
  });

  it("rejects administrative reassignment of an active wait node", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Record for admin wait node");
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
      nodeType: "wait",
      status: "active",
      name: "Wait",
    });

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Should be rejected.",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/cannot be reassigned/i);
  });
});

describe("reassign_process_step_run_administrative_authorized: mutation correctness (shared core)", () => {
  it("preserves due_at byte-identically and increments assignment_generation exactly once", async () => {
    const admin = createSupabaseTestClient();
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const dueAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
    const { runId, stepId } = await activeAssignedStep(fixture.workerA, "human_task", dueAt);

    const before = await admin.from("process_step_runs").select("assignment_generation, due_at").eq("id", stepId).single();
    expect(before.data?.assignment_generation).toBe(1);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Preserve due_at check.",
    });
    expect(result.error).toBeNull();

    const after = await admin.from("process_step_runs").select("assignment_generation, due_at").eq("id", stepId).single();
    expect(after.data?.assignment_generation).toBe(2);
    expect(new Date(after.data!.due_at).getTime()).toBe(new Date(dueAt).getTime());
  });

  it("gives the new assignee exactly one fresh generation-aware step_assigned notification and no notification to the outgoing assignee", async () => {
    const admin = createSupabaseTestClient();
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Notification check.",
    });
    expect(result.error).toBeNull();

    const newAssigneeNotification = await admin
      .from("notifications")
      .select("recipient_user_id, dedup_key, event_type")
      .eq("workspace_id", fixture.workspaceId)
      .eq("dedup_key", `assignment:${stepId}:2`)
      .single();
    expect(newAssigneeNotification.data).toMatchObject({
      recipient_user_id: fixture.workerB.id,
      event_type: "step_assigned",
    });

    const outgoingAssigneeNotifications = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_id", stepId)
      .eq("recipient_user_id", fixture.workerA.id);
    expect(outgoingAssigneeNotifications.data).toEqual([]);

    const allNotificationsForStep = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_id", stepId);
    expect(allNotificationsForStep.data).toHaveLength(1);
  });

  it("leaves prior notification/event history for the step completely untouched", async () => {
    const admin = createSupabaseTestClient();
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const workerAClient = await authenticatedClient(fixture.workerA);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    // Generation 1 -> 2 via ordinary self-reassignment first, establishing
    // history that the subsequent administrative reassignment must not
    // touch.
    const selfReassign = await workerAClient.rpc("reassign_process_step_run_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: runId,
      p_step_run_id: stepId,
      p_new_assignee_user_id: fixture.workerB.id,
      p_reason: null,
    });
    expect(selfReassign.error).toBeNull();

    const historicalNotification = await admin
      .from("notifications")
      .select("id, dedup_key, recipient_user_id, created_at")
      .eq("workspace_id", fixture.workspaceId)
      .eq("dedup_key", `assignment:${stepId}:2`)
      .single();
    const historicalEvent = await admin
      .from("workspace_events")
      .select("id, actor_user_id, metadata, created_at")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_id", stepId)
      .eq("event_type", "step_reassigned")
      .single();

    // Generation 2 -> 3, administratively, moving the step from workerB to
    // workerC.
    const adminReassign = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerC.id,
      reason: "History-preservation check.",
    });
    expect(adminReassign.error).toBeNull();

    const historicalNotificationAfter = await admin
      .from("notifications")
      .select("id, dedup_key, recipient_user_id, created_at")
      .eq("id", historicalNotification.data!.id)
      .single();
    expect(historicalNotificationAfter.data).toEqual(historicalNotification.data);

    const historicalEventAfter = await admin
      .from("workspace_events")
      .select("id, actor_user_id, metadata, created_at")
      .eq("id", historicalEvent.data!.id)
      .single();
    expect(historicalEventAfter.data).toEqual(historicalEvent.data);
  });

  it("records the administrator as actor_user_id with frozen from/to labels, reason, and generation on step_reassigned", async () => {
    const admin = createSupabaseTestClient();
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Coverage gap on the on-call rotation.",
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
    expect(event.data?.actor_user_id).toBe(fixture.builtInAdministrator.id);
    expect(event.data?.real_actor_user_id).toBeNull();
    expect(event.data?.metadata).toMatchObject({
      from_assignee_user_id: fixture.workerA.id,
      from_assignee_label: fixture.workerA.email,
      to_assignee_user_id: fixture.workerB.id,
      to_assignee_label: fixture.workerB.email,
      assignment_generation: 2,
      reason: "Coverage gap on the on-call rotation.",
    });
  });
});

describe("reassign_process_step_run_administrative_authorized: ownership-only guarantee", () => {
  it("does not let the administrator complete the step themselves after reassigning it away from workerA", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const workerBClient = await authenticatedClient(fixture.workerB);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const reassignResult = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Ownership-only check.",
    });
    expect(reassignResult.error).toBeNull();

    const adminCompleteAttempt = await adminClient.rpc("complete_process_step_run_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: runId,
      p_step_run_id: stepId,
    });
    expect(adminCompleteAttempt.error).not.toBeNull();
    expect(adminCompleteAttempt.error?.message ?? "").toMatch(/assigned to another member/i);

    const newAssigneeCompleteAttempt = await workerBClient.rpc("complete_process_step_run_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: runId,
      p_step_run_id: stepId,
    });
    expect(newAssigneeCompleteAttempt.error).toBeNull();
  });
});

describe("reassign_process_step_run_administrative_authorized: impersonation boundary", () => {
  it("rejects administrative reassignment while an impersonation session is currently active", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const start = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.workerC.id,
    });
    expect(start.error).toBeNull();

    try {
      const result = await administrativelyReassign(adminClient, {
        processRunId: runId,
        stepRunId: stepId,
        newAssigneeUserId: fixture.workerB.id,
        reason: "Should be rejected while impersonating.",
      });
      expect(result.error).not.toBeNull();
      expect(result.error?.message ?? "").toMatch(/not available while impersonating/i);
    } finally {
      await endAnyActiveSession(adminClient);
    }
  });

  it("does not treat a since-ended impersonation session as active -- the same real actor succeeds immediately after ending it", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const start = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.workerC.id,
    });
    expect(start.error).toBeNull();
    await endAnyActiveSession(adminClient);

    const result = await administrativelyReassign(adminClient, {
      processRunId: runId,
      stepRunId: stepId,
      newAssigneeUserId: fixture.workerB.id,
      reason: "Should succeed -- the impersonation session has ended.",
    });
    expect(result.error).toBeNull();
  });

  it("rejects administrative reassignment even when the real actor is impersonating the step's own current assignee", async () => {
    const adminClient = await authenticatedClient(fixture.builtInAdministrator);
    const { runId, stepId } = await activeAssignedStep(fixture.workerA);

    const start = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.workerA.id,
    });
    expect(start.error).toBeNull();

    try {
      const result = await administrativelyReassign(adminClient, {
        processRunId: runId,
        stepRunId: stepId,
        newAssigneeUserId: fixture.workerB.id,
        reason: "Should still be rejected -- administrative authority is real-actor only.",
      });
      expect(result.error).not.toBeNull();
      expect(result.error?.message ?? "").toMatch(/not available while impersonating/i);
    } finally {
      await endAnyActiveSession(adminClient);
    }
  });
});
