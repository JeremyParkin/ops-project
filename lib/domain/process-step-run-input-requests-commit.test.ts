// DB/RPC-level verification for Phase 10.5 Process Step Run Request for
// Input. Requires migration 0090 applied. Covers: eligible step/status
// behavior, processes.operate requester/recipient authority (distinct from
// mere workspace-member visibility), atomic create/respond/cancel,
// notification shape, archived-origin behavior, completed-step/run
// behavior, impersonation attribution, and the closed raw-table write
// posture. Mirrors record-input-requests-commit.test.ts's structure
// (Phase 10.4) and process-step-run-comments-commit.test.ts's fixture
// shape (Phase 10.3).
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient, deleteE2eUsers } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

type StepIds = {
  activeHumanTask: string;
  activeApproval: string;
  completedHumanTask: string;
  activeWait: string;
  pendingHumanTask: string;
};

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  entityTypeId: string;
  otherEntityTypeId: string;
  recordId: string;
  otherRecordId: string;
  activeRunId: string;
  completedRunId: string;
  otherRunId: string;
  steps: StepIds;
  completedRunStepId: string;
  otherStepId: string;
  worker: User;
  secondWorker: User;
  thirdWorker: User;
  administrator: User;
  readOnly: User;
  recordOnly: User;
  otherWorker: User;
  deactivatedMember: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
let administratorClientPromise: Promise<SupabaseClient> | undefined;

function uniqueEmail(label: string) {
  return `e2e-step-input-request-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `StepInputRequest-${randomUUID()}!`;
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

async function createRecord(workspaceId: string, entityTypeId: string, name: string, archived = false) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin.from("entity_records").insert({
    id: recordId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    values: { name },
    archived_at: archived ? new Date().toISOString() : null,
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
    process_template_name: "Step input request template",
    origin_entity_type_id: entityTypeId,
    origin_record_id: recordId,
    status,
    completed_at: status === "completed" ? new Date().toISOString() : null,
  });
  if (error) throw new Error(error.message);
  return runId;
}

async function createStep({
  workspaceId,
  processRunId,
  stepIndex,
  nodeType,
  status,
  name,
}: {
  workspaceId: string;
  processRunId: string;
  stepIndex: number;
  nodeType: "human_task" | "approval" | "wait";
  status: "pending" | "active" | "completed";
  name: string;
}) {
  const admin = createSupabaseTestClient();
  const stepId = randomUUID();
  const startedAt = status === "pending" ? null : new Date().toISOString();
  const completedAt = status === "completed" ? new Date().toISOString() : null;
  const { error } = await admin.from("process_step_runs").insert({
    id: stepId,
    workspace_id: workspaceId,
    process_run_id: processRunId,
    step_index: stepIndex,
    node_type: nodeType,
    name,
    config: nodeType === "wait" ? { wait_rule: { kind: "duration", amount: 1, unit: "hours" } } : {},
    status,
    started_at: startedAt,
    completed_at: completedAt,
    resume_at: nodeType === "wait" && status !== "pending" ? new Date(Date.now() + 60_000).toISOString() : null,
  });
  if (error) throw new Error(error.message);
  return stepId;
}

async function createRequest(
  client: SupabaseClient,
  recipientUserId: string,
  body = "Please confirm the budget line before I sign off.",
  processRunId = fixture.activeRunId,
  processStepRunId = fixture.steps.activeHumanTask,
) {
  const { data, error } = await client.rpc("create_process_step_run_input_request_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_process_run_id: processRunId,
    p_process_step_run_id: processStepRunId,
    p_recipient_user_id: recipientUserId,
    p_body: body,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

async function respondRequest(client: SupabaseClient, requestId: string, body = "Confirmed, go ahead.") {
  const { data, error } = await client.rpc("respond_process_step_run_input_request_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_request_id: requestId,
    p_body: body,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

async function cancelRequest(client: SupabaseClient, requestId: string) {
  const { error } = await client.rpc("cancel_process_step_run_input_request_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
}

async function listRequests(
  client: SupabaseClient,
  processRunId = fixture.activeRunId,
  processStepRunId = fixture.steps.activeHumanTask,
) {
  const { data, error } = await client.rpc("list_process_step_run_input_requests_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_process_run_id: processRunId,
    p_process_step_run_id: processStepRunId,
    p_limit: 100,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    origin_process_step_run_comment_id: string;
    recipient_user_id: string;
    recipient_label: string;
    response_process_step_run_comment_id: string | null;
    cancelled_at: string | null;
    cancelled_by_user_id: string | null;
    cancelled_by_real_actor_user_id: string | null;
    origin_author_user_id: string;
    origin_author_label: string;
    origin_real_actor_user_id: string | null;
    origin_real_actor_label: string | null;
    origin_created_at: string;
    response_author_user_id: string | null;
    response_author_label: string | null;
    response_real_actor_user_id: string | null;
    response_real_actor_label: string | null;
    response_created_at: string | null;
  }>;
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = await createWorkspace("E2E Step Input Request");
  const otherWorkspaceId = await createWorkspace("E2E Step Input Request Other");

  const administratorRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members",
    "workspace.manage_roles",
    "records.operate",
    "processes.operate",
    "workspace.impersonate_users",
  ]);
  const processOperatorRoleId = await createRole(workspaceId, "Process operator", ["processes.operate"]);
  const readOnlyRoleId = await createRole(workspaceId, "Read only", []);
  const recordOnlyRoleId = await createRole(workspaceId, "Record only", ["records.operate"]);
  const otherProcessOperatorRoleId = await createRole(otherWorkspaceId, "Other process operator", ["processes.operate"]);

  const worker = await createUser("worker");
  const secondWorker = await createUser("second-worker");
  const thirdWorker = await createUser("third-worker");
  const administrator = await createUser("administrator");
  const readOnly = await createUser("read-only");
  const recordOnly = await createUser("record-only");
  const otherWorker = await createUser("other-worker");
  const deactivatedMember = await createUser("deactivated");

  await addMembership(workspaceId, worker.id, processOperatorRoleId);
  await addMembership(workspaceId, secondWorker.id, processOperatorRoleId);
  await addMembership(workspaceId, thirdWorker.id, processOperatorRoleId);
  await addMembership(workspaceId, administrator.id, administratorRoleId);
  await addMembership(workspaceId, readOnly.id, readOnlyRoleId);
  await addMembership(workspaceId, recordOnly.id, recordOnlyRoleId);
  await addMembership(workspaceId, deactivatedMember.id, processOperatorRoleId);
  await addMembership(otherWorkspaceId, otherWorker.id, otherProcessOperatorRoleId);

  const { error: deactivateError } = await admin
    .from("workspace_memberships")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("user_id", deactivatedMember.id);
  if (deactivateError) throw new Error(deactivateError.message);

  const entityTypeId = await createEntityType(workspaceId, `Step Input Request Object ${workspaceId.slice(0, 6)}`);
  const otherEntityTypeId = await createEntityType(
    otherWorkspaceId,
    `Step Input Request Other Object ${otherWorkspaceId.slice(0, 6)}`,
  );
  const recordId = await createRecord(workspaceId, entityTypeId, "Primary record");
  const otherRecordId = await createRecord(otherWorkspaceId, otherEntityTypeId, "Other record");
  const templateId = await createTemplate(workspaceId, entityTypeId, "Step input request template");
  const otherTemplateId = await createTemplate(otherWorkspaceId, otherEntityTypeId, "Other step input request template");
  const activeRunId = await createRun({ workspaceId, entityTypeId, recordId, templateId });
  const completedRunId = await createRun({ workspaceId, entityTypeId, recordId, templateId, status: "completed" });
  const otherRunId = await createRun({
    workspaceId: otherWorkspaceId,
    entityTypeId: otherEntityTypeId,
    recordId: otherRecordId,
    templateId: otherTemplateId,
  });

  const steps: StepIds = {
    activeHumanTask: await createStep({
      workspaceId,
      processRunId: activeRunId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "Review request",
    }),
    activeApproval: await createStep({
      workspaceId,
      processRunId: activeRunId,
      stepIndex: 2,
      nodeType: "approval",
      status: "active",
      name: "Approve request",
    }),
    completedHumanTask: await createStep({
      workspaceId,
      processRunId: activeRunId,
      stepIndex: 3,
      nodeType: "human_task",
      status: "completed",
      name: "Completed handoff",
    }),
    activeWait: await createStep({
      workspaceId,
      processRunId: activeRunId,
      stepIndex: 4,
      nodeType: "wait",
      status: "active",
      name: "Wait internally",
    }),
    pendingHumanTask: await createStep({
      workspaceId,
      processRunId: activeRunId,
      stepIndex: 5,
      nodeType: "human_task",
      status: "pending",
      name: "Future task",
    }),
  };
  const completedRunStepId = await createStep({
    workspaceId,
    processRunId: completedRunId,
    stepIndex: 1,
    nodeType: "human_task",
    status: "completed",
    name: "Completed run task",
  });
  const otherStepId = await createStep({
    workspaceId: otherWorkspaceId,
    processRunId: otherRunId,
    stepIndex: 1,
    nodeType: "human_task",
    status: "active",
    name: "Other task",
  });

  return {
    workspaceId,
    otherWorkspaceId,
    entityTypeId,
    otherEntityTypeId,
    recordId,
    otherRecordId,
    activeRunId,
    completedRunId,
    otherRunId,
    steps,
    completedRunStepId,
    otherStepId,
    worker,
    secondWorker,
    thirdWorker,
    administrator,
    readOnly,
    recordOnly,
    otherWorker,
    deactivatedMember,
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
      "process_step_run_input_requests",
      "process_step_run_comments",
      "record_comments",
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
    throw new Error(`process-step-run-input-requests-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 45_000);

describe("process step run input request creation and eligibility", () => {
  it("atomically creates the origin step comment, lean request row, and recipient notification without copying body into request storage", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const admin = createSupabaseTestClient();
    const body = "Please confirm:\n\n  budget line and approver.";

    const requestId = await createRequest(workerClient, fixture.secondWorker.id, ` \t${body}\n `);

    const request = await admin
      .from("process_step_run_input_requests")
      .select("*")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", requestId)
      .single();
    expect(request.error).toBeNull();
    expect(request.data).toMatchObject({
      workspace_id: fixture.workspaceId,
      process_run_id: fixture.activeRunId,
      process_step_run_id: fixture.steps.activeHumanTask,
      recipient_user_id: fixture.secondWorker.id,
      response_process_step_run_comment_id: null,
      cancelled_at: null,
      cancelled_by_user_id: null,
      cancelled_by_real_actor_user_id: null,
    });
    expect(JSON.stringify(request.data)).not.toContain("budget line");

    const origin = await admin
      .from("process_step_run_comments")
      .select("body, author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", request.data!.origin_process_step_run_comment_id)
      .single();
    expect(origin.error).toBeNull();
    expect(origin.data).toEqual({
      body,
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
      real_actor_user_id: null,
      real_actor_label: null,
    });

    const notification = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, process_step_run_input_request_id, process_run_id, process_step_run_id, destination_href, title")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_input_request_id", requestId)
      .eq("event_type", "process_step_run_input_request_created")
      .single();
    expect(notification.error).toBeNull();
    expect(notification.data).toEqual({
      recipient_user_id: fixture.secondWorker.id,
      event_type: "process_step_run_input_request_created",
      process_step_run_input_request_id: requestId,
      process_run_id: fixture.activeRunId,
      process_step_run_id: fixture.steps.activeHumanTask,
      destination_href: `/process-runs/${fixture.activeRunId}#step-input-request-${requestId}`,
      title: `${fixture.worker.email} requested your input on a process step`,
    });
    expect(notification.data?.title).not.toContain("budget line");
  });

  it("succeeds for both human_task and approval steps, and rejects wait/pending steps", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const admin = createSupabaseTestClient();

    const humanRequestId = await createRequest(
      workerClient,
      fixture.secondWorker.id,
      "Human task request",
      fixture.activeRunId,
      fixture.steps.activeHumanTask,
    );
    const approvalRequestId = await createRequest(
      workerClient,
      fixture.secondWorker.id,
      "Approval request",
      fixture.activeRunId,
      fixture.steps.activeApproval,
    );
    expect(humanRequestId).toMatch(/[0-9a-f-]{36}/);
    expect(approvalRequestId).toMatch(/[0-9a-f-]{36}/);

    const waitRequest = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeWait,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Wait step should reject",
    });
    expect(waitRequest.error?.message).toContain("Step not found or not open for discussion");

    const pendingRequest = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.pendingHumanTask,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Pending step should reject",
    });
    expect(pendingRequest.error?.message).toContain("Step not found or not open for discussion");

    const noOrphanComments = await admin
      .from("process_step_run_comments")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .in("body", ["Wait step should reject", "Pending step should reject"]);
    expect(noOrphanComments.error).toBeNull();
    expect(noOrphanComments.data).toEqual([]);
  });

  it("fails cleanly for wrong workspace/run/step combinations, leaving no partial state", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const admin = createSupabaseTestClient();

    const wrongRun = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: randomUUID(),
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Wrong run rollback",
    });
    expect(wrongRun.error).not.toBeNull();

    const wrongStepForRun = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.otherStepId,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Cross-run step rollback",
    });
    expect(wrongStepForRun.error).not.toBeNull();

    const crossWorkspaceStep = await otherWorkerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.otherWorkspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.otherWorker.id,
      p_body: "Cross-workspace run rollback",
    });
    expect(crossWorkspaceStep.error).not.toBeNull();

    const rolledBack = await admin
      .from("process_step_run_comments")
      .select("id")
      .in("body", ["Wrong run rollback", "Cross-run step rollback", "Cross-workspace run rollback"]);
    expect(rolledBack.error).toBeNull();
    expect(rolledBack.data).toEqual([]);
  });

  it("scopes list reads to the target step and rejects a step-run id from a different run", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const requestId = await createRequest(workerClient, fixture.secondWorker.id, "Scoped to this step");

    const wrongRun = await workerClient.rpc("list_process_step_run_input_requests_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.completedRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_limit: 100,
    });
    expect(wrongRun.error?.message).toContain("Step not found");

    const correctScope = await listRequests(workerClient);
    expect(correctScope.map((row) => row.id)).toContain(requestId);
  });
});

describe("process step run input request visibility and capability", () => {
  it("limits recipient candidates to processes.operate members and rejects record-only, read-only, foreign, inactive, self, and unauthorized callers", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const readOnlyClient = await authenticatedClient(fixture.readOnly);
    const recordOnlyClient = await authenticatedClient(fixture.recordOnly);
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const admin = createSupabaseTestClient();

    const candidates = await workerClient.rpc("list_process_step_run_input_request_recipients_authorized", {
      p_workspace_id: fixture.workspaceId,
    });
    expect(candidates.error).toBeNull();
    expect((candidates.data ?? []).map((row: { user_id: string }) => row.user_id).sort()).toEqual(
      [fixture.administrator.id, fixture.secondWorker.id, fixture.thirdWorker.id, fixture.worker.id].sort(),
    );
    // record-only (records.operate but not processes.operate) confirms the
    // candidate pool isn't accidentally reusing the record-level capability.
    expect((candidates.data ?? []).map((row: { user_id: string }) => row.user_id)).not.toContain(fixture.recordOnly.id);

    const recordOnlyRecipient = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.recordOnly.id,
      p_body: "Record-only recipient rollback",
    });
    expect(recordOnlyRecipient.error?.message).toContain("processes.operate workspace member");

    const readOnlyRecipient = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.readOnly.id,
      p_body: "Read-only recipient rollback",
    });
    expect(readOnlyRecipient.error?.message).toContain("processes.operate workspace member");

    const foreignRecipient = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.otherWorker.id,
      p_body: "Foreign recipient rollback",
    });
    expect(foreignRecipient.error?.message).toContain("processes.operate workspace member");

    const inactiveRecipient = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.deactivatedMember.id,
      p_body: "Inactive recipient rollback",
    });
    expect(inactiveRecipient.error?.message).toContain("processes.operate workspace member");

    const selfRecipient = await workerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.worker.id,
      p_body: "Self recipient rollback",
    });
    expect(selfRecipient.error?.message).toContain("cannot request input from yourself");

    const recordOnlyRequester = await recordOnlyClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Record-only requester rollback",
    });
    expect(recordOnlyRequester.error?.message).toContain("processes.operate");

    const readOnlyRequester = await readOnlyClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Read-only requester rollback",
    });
    expect(readOnlyRequester.error?.message).toContain("processes.operate");

    const foreignRequester = await otherWorkerClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Foreign requester rollback",
    });
    expect(foreignRequester.error).not.toBeNull();

    const rolledBack = await admin
      .from("process_step_run_comments")
      .select("body")
      .eq("workspace_id", fixture.workspaceId)
      .in("body", [
        "Record-only recipient rollback",
        "Read-only recipient rollback",
        "Foreign recipient rollback",
        "Inactive recipient rollback",
        "Self recipient rollback",
        "Record-only requester rollback",
        "Read-only requester rollback",
        "Foreign requester rollback",
      ]);
    expect(rolledBack.error).toBeNull();
    expect(rolledBack.data).toEqual([]);
  });

  it("matches the read-visibility boundary of plain Step Discussion (workspace member, not processes.operate)", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const recordOnlyClient = await authenticatedClient(fixture.recordOnly);
    const readOnlyClient = await authenticatedClient(fixture.readOnly);
    const requestId = await createRequest(workerClient, fixture.secondWorker.id, "Visibility parity check");

    // A record-only or read-only member can't create/receive a request, but
    // per the migration's own load-bearing finding, they CAN already read
    // Step Discussion (workspace membership alone) -- listing must not
    // regress that.
    const recordOnlyRead = await listRequests(recordOnlyClient);
    expect(recordOnlyRead.map((row) => row.id)).toContain(requestId);

    const readOnlyRead = await listRequests(readOnlyClient);
    expect(readOnlyRead.map((row) => row.id)).toContain(requestId);
  });

  it("never grants new Process Run or record visibility beyond what workspace membership already allowed", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const readOnlyClient = await authenticatedClient(fixture.readOnly);
    await createRequest(workerClient, fixture.secondWorker.id, "No visibility grant check");

    // A caller in a foreign workspace still can't reach this run's requests
    // at all -- confirms the request mechanism didn't punch a new hole.
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const crossWorkspaceRead = await otherWorkerClient.rpc("list_process_step_run_input_requests_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_limit: 100,
    });
    expect(crossWorkspaceRead.error).not.toBeNull();

    // Same-workspace read-only member's access is exactly what plain Step
    // Discussion already granted (workspace membership), not expanded.
    const readOnlyProcessRun = await readOnlyClient
      .from("process_runs")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", fixture.activeRunId);
    expect(readOnlyProcessRun.error).toBeNull();
    expect(readOnlyProcessRun.data).toEqual([{ id: fixture.activeRunId }]);
  });
});

describe("process step run input request response state", () => {
  it("requires the intended effective recipient, leaves ordinary comments inert, creates response comment, and notifies the requester", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);
    const ordinaryUserClient = await authenticatedClient(fixture.thirdWorker);
    const admin = createSupabaseTestClient();

    const requestId = await createRequest(requesterClient, fixture.secondWorker.id, "Need a decision, not just chatter.");

    const ordinaryComment = await recipientClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_body: "Ordinary recipient comment",
      p_mentioned_user_ids: [],
    });
    expect(ordinaryComment.error).toBeNull();
    let openRequest = await admin
      .from("process_step_run_input_requests")
      .select("response_process_step_run_comment_id, cancelled_at")
      .eq("id", requestId)
      .single();
    expect(openRequest.error).toBeNull();
    expect(openRequest.data).toEqual({ response_process_step_run_comment_id: null, cancelled_at: null });

    const wrongRecipient = await ordinaryUserClient.rpc("respond_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: requestId,
      p_body: "Wrong person should not close it",
    });
    expect(wrongRecipient.error?.message).toContain("Only the request recipient can respond");

    openRequest = await admin
      .from("process_step_run_input_requests")
      .select("response_process_step_run_comment_id, cancelled_at")
      .eq("id", requestId)
      .single();
    expect(openRequest.error).toBeNull();
    expect(openRequest.data).toEqual({ response_process_step_run_comment_id: null, cancelled_at: null });

    const responseCommentId = await respondRequest(recipientClient, requestId, " The budget is approved.\n\nGo ahead. ");

    const responseComment = await admin
      .from("process_step_run_comments")
      .select("body, author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", responseCommentId)
      .single();
    expect(responseComment.error).toBeNull();
    expect(responseComment.data).toEqual({
      body: "The budget is approved.\n\nGo ahead.",
      author_user_id: fixture.secondWorker.id,
      author_label: fixture.secondWorker.email,
      real_actor_user_id: null,
      real_actor_label: null,
    });

    const respondedRequest = await admin
      .from("process_step_run_input_requests")
      .select("response_process_step_run_comment_id, cancelled_at, cancelled_by_user_id")
      .eq("id", requestId)
      .single();
    expect(respondedRequest.error).toBeNull();
    expect(respondedRequest.data).toEqual({
      response_process_step_run_comment_id: responseCommentId,
      cancelled_at: null,
      cancelled_by_user_id: null,
    });

    const listed = await listRequests(requesterClient);
    expect(listed.find((row) => row.id === requestId)).toMatchObject({
      response_process_step_run_comment_id: responseCommentId,
      response_author_user_id: fixture.secondWorker.id,
      response_author_label: fixture.secondWorker.email,
    });

    const notification = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, process_step_run_input_request_id, destination_href, title")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_input_request_id", requestId)
      .eq("event_type", "process_step_run_input_request_responded")
      .single();
    expect(notification.error).toBeNull();
    expect(notification.data).toEqual({
      recipient_user_id: fixture.worker.id,
      event_type: "process_step_run_input_request_responded",
      process_step_run_input_request_id: requestId,
      destination_href: `/process-runs/${fixture.activeRunId}#step-input-request-${requestId}`,
      title: `${fixture.secondWorker.email} responded to your request`,
    });
    expect(notification.data?.title).not.toContain("budget is approved");

    const secondResponse = await recipientClient.rpc("respond_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: requestId,
      p_body: "Second response should fail",
    });
    expect(secondResponse.error?.message).toContain("no longer open");
    const noPartialSecond = await admin
      .from("process_step_run_comments")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("body", "Second response should fail");
    expect(noPartialSecond.error).toBeNull();
    expect(noPartialSecond.data).toEqual([]);
  });
});

describe("process step run input request cancellation state", () => {
  it("allows requester cancellation, rejects ordinary third-party cancellation, allows administrator cancellation, and preserves history", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);
    const ordinaryUserClient = await authenticatedClient(fixture.thirdWorker);
    const adminClient = await administratorClient();
    const admin = createSupabaseTestClient();

    const ownCancelRequestId = await createRequest(requesterClient, fixture.secondWorker.id, "Requester will cancel this.");
    const ownOriginId = (
      await admin
        .from("process_step_run_input_requests")
        .select("origin_process_step_run_comment_id")
        .eq("id", ownCancelRequestId)
        .single()
    ).data!.origin_process_step_run_comment_id;
    await cancelRequest(requesterClient, ownCancelRequestId);

    const ownCancelled = await admin
      .from("process_step_run_input_requests")
      .select(
        "origin_process_step_run_comment_id, response_process_step_run_comment_id, cancelled_at, cancelled_by_user_id, cancelled_by_real_actor_user_id",
      )
      .eq("id", ownCancelRequestId)
      .single();
    expect(ownCancelled.error).toBeNull();
    expect(ownCancelled.data?.origin_process_step_run_comment_id).toBe(ownOriginId);
    expect(ownCancelled.data?.response_process_step_run_comment_id).toBeNull();
    expect(ownCancelled.data?.cancelled_at).not.toBeNull();
    expect(ownCancelled.data?.cancelled_by_user_id).toBe(fixture.worker.id);
    expect(ownCancelled.data?.cancelled_by_real_actor_user_id).toBeNull();

    const originAfterCancel = await admin
      .from("process_step_run_comments")
      .select("id, body")
      .eq("id", ownOriginId)
      .single();
    expect(originAfterCancel.error).toBeNull();
    expect(originAfterCancel.data?.body).toBe("Requester will cancel this.");

    const cancelledNotification = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, process_step_run_input_request_id, destination_href")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_input_request_id", ownCancelRequestId)
      .eq("event_type", "process_step_run_input_request_cancelled")
      .single();
    expect(cancelledNotification.error).toBeNull();
    expect(cancelledNotification.data).toEqual({
      recipient_user_id: fixture.secondWorker.id,
      event_type: "process_step_run_input_request_cancelled",
      process_step_run_input_request_id: ownCancelRequestId,
      destination_href: `/process-runs/${fixture.activeRunId}#step-input-request-${ownCancelRequestId}`,
    });

    const respondCancelled = await recipientClient.rpc("respond_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: ownCancelRequestId,
      p_body: "Cancelled response should fail",
    });
    expect(respondCancelled.error?.message).toContain("no longer open");

    const secondCancel = await requesterClient.rpc("cancel_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: ownCancelRequestId,
    });
    expect(secondCancel.error?.message).toContain("no longer open");

    const adminCancelRequestId = await createRequest(requesterClient, fixture.secondWorker.id, "Administrator can cancel this.");
    const ordinaryCancel = await ordinaryUserClient.rpc("cancel_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: adminCancelRequestId,
    });
    expect(ordinaryCancel.error?.message).toContain("requester or a workspace administrator");

    await cancelRequest(adminClient, adminCancelRequestId);
    const adminCancelled = await admin
      .from("process_step_run_input_requests")
      .select("cancelled_at, cancelled_by_user_id, cancelled_by_real_actor_user_id")
      .eq("id", adminCancelRequestId)
      .single();
    expect(adminCancelled.error).toBeNull();
    expect(adminCancelled.data?.cancelled_at).not.toBeNull();
    expect(adminCancelled.data?.cancelled_by_user_id).toBe(fixture.administrator.id);
    expect(adminCancelled.data?.cancelled_by_real_actor_user_id).toBeNull();
  });

  it("stores effective and real actor for impersonated cancellation", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const adminClient = await administratorClient();
    const admin = createSupabaseTestClient();
    const requestId = await createRequest(requesterClient, fixture.secondWorker.id, "Impersonated requester will cancel.");

    const startImpersonating = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.worker.id,
    });
    expect(startImpersonating.error).toBeNull();

    await cancelRequest(adminClient, requestId);

    const storage = await admin
      .from("process_step_run_input_requests")
      .select("cancelled_by_user_id, cancelled_by_real_actor_user_id")
      .eq("id", requestId)
      .single();
    expect(storage.error).toBeNull();
    expect(storage.data).toEqual({
      cancelled_by_user_id: fixture.worker.id,
      cancelled_by_real_actor_user_id: fixture.administrator.id,
    });
  });
});

describe("process step run input request lifecycle: completed steps/runs and archived origin", () => {
  it("allows request and response on a completed step within an otherwise active run", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);

    const requestId = await createRequest(
      requesterClient,
      fixture.secondWorker.id,
      "Completed step request",
      fixture.activeRunId,
      fixture.steps.completedHumanTask,
    );
    const responseCommentId = await respondRequest(recipientClient, requestId, "Completed step response");
    expect(responseCommentId).toMatch(/[0-9a-f-]{36}/);

    const listed = await listRequests(requesterClient, fixture.activeRunId, fixture.steps.completedHumanTask);
    expect(listed.find((row) => row.id === requestId)?.response_process_step_run_comment_id).toBe(responseCommentId);
  });

  it("allows request and response on a step belonging to a completed Process Run", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);

    const requestId = await createRequest(
      requesterClient,
      fixture.secondWorker.id,
      "Completed run request",
      fixture.completedRunId,
      fixture.completedRunStepId,
    );
    const responseCommentId = await respondRequest(recipientClient, requestId, "Completed run response");
    expect(responseCommentId).toMatch(/[0-9a-f-]{36}/);
  });

  it("keeps archived-origin request history visible, denies new requests and responses, but still allows requester/admin cancellation", async () => {
    const admin = createSupabaseTestClient();
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);

    const archivableRecordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Archive after step request");
    const templateId = await createTemplate(fixture.workspaceId, fixture.entityTypeId, "Archive-after-request template");
    const archivableRunId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId: archivableRecordId,
      templateId,
    });
    const archivableStepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: archivableRunId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "Archive after request task",
    });

    const requestId = await createRequest(
      requesterClient,
      fixture.secondWorker.id,
      "Archive should not auto-cancel.",
      archivableRunId,
      archivableStepId,
    );

    // The requester here only has processes.operate; archiving needs
    // records.operate, which only the administrator fixture user holds.
    const archive = await (await administratorClient()).rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_record_ids: [archivableRecordId],
      p_archived: true,
    });
    expect(archive.error).toBeNull();

    const stillOpen = await admin
      .from("process_step_run_input_requests")
      .select("response_process_step_run_comment_id, cancelled_at")
      .eq("id", requestId)
      .single();
    expect(stillOpen.error).toBeNull();
    expect(stillOpen.data).toEqual({ response_process_step_run_comment_id: null, cancelled_at: null });

    const visibleHistory = await listRequests(requesterClient, archivableRunId, archivableStepId);
    expect(visibleHistory.find((row) => row.id === requestId)).toMatchObject({
      origin_author_user_id: fixture.worker.id,
      response_process_step_run_comment_id: null,
      cancelled_at: null,
    });

    const newArchivedRequest = await requesterClient.rpc("create_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: archivableRunId,
      p_process_step_run_id: archivableStepId,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Archived create denied",
    });
    expect(newArchivedRequest.error?.message).toContain("Origin record not found or archived");

    const archivedResponse = await recipientClient.rpc("respond_process_step_run_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: requestId,
      p_body: "Archived response denied",
    });
    expect(archivedResponse.error?.message).toContain("Origin record not found or archived");

    await cancelRequest(requesterClient, requestId);
    const cancelled = await admin
      .from("process_step_run_input_requests")
      .select("cancelled_at")
      .eq("id", requestId)
      .single();
    expect(cancelled.error).toBeNull();
    expect(cancelled.data?.cancelled_at).not.toBeNull();
  });

  it("never auto-responds or auto-cancels an open request when the step is completed out from under it", async () => {
    const admin = createSupabaseTestClient();
    const requesterClient = await authenticatedClient(fixture.worker);

    const templateId = await createTemplate(fixture.workspaceId, fixture.entityTypeId, "Completion-in-flight template");
    const runId = await createRun({
      workspaceId: fixture.workspaceId,
      entityTypeId: fixture.entityTypeId,
      recordId: fixture.recordId,
      templateId,
    });
    const stepId = await createStep({
      workspaceId: fixture.workspaceId,
      processRunId: runId,
      stepIndex: 1,
      nodeType: "human_task",
      status: "active",
      name: "Completes mid-request",
    });

    const requestId = await createRequest(requesterClient, fixture.secondWorker.id, "Still open when step completes", runId, stepId);

    const { error: completeError } = await admin
      .from("process_step_runs")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", stepId);
    expect(completeError).toBeNull();

    const stillOpen = await admin
      .from("process_step_run_input_requests")
      .select("response_process_step_run_comment_id, cancelled_at")
      .eq("id", requestId)
      .single();
    expect(stillOpen.error).toBeNull();
    expect(stillOpen.data).toEqual({ response_process_step_run_comment_id: null, cancelled_at: null });
  });
});

describe("process step run input request notification integrity and raw-table posture", () => {
  it("enforces the 5-arm notification target shape, auth.uid recipient isolation, mark-read behavior, and closed raw request writes", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);
    const admin = createSupabaseTestClient();
    const requestId = await createRequest(requesterClient, fixture.secondWorker.id, "Notification integrity request.");

    const createdNotification = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_input_request_id", requestId)
      .eq("event_type", "process_step_run_input_request_created")
      .single();
    expect(createdNotification.error).toBeNull();

    const requesterRead = await requesterClient
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", createdNotification.data!.id);
    expect(requesterRead.error).toBeNull();
    expect(requesterRead.data).toEqual([]);

    const recipientRead = await recipientClient
      .from("notifications")
      .select("id, read_at")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", createdNotification.data!.id);
    expect(recipientRead.error).toBeNull();
    expect(recipientRead.data).toEqual([{ id: createdNotification.data!.id, read_at: null }]);

    const requesterMark = await requesterClient.rpc("mark_notification_read_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_notification_id: createdNotification.data!.id,
    });
    expect(requesterMark.error).toBeNull();
    let unread = await admin.from("notifications").select("read_at").eq("id", createdNotification.data!.id).single();
    expect(unread.data?.read_at).toBeNull();

    const recipientMark = await recipientClient.rpc("mark_notification_read_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_notification_id: createdNotification.data!.id,
    });
    expect(recipientMark.error).toBeNull();
    unread = await admin.from("notifications").select("read_at").eq("id", createdNotification.data!.id).single();
    expect(unread.data?.read_at).not.toBeNull();

    const originId = (
      await admin
        .from("process_step_run_input_requests")
        .select("origin_process_step_run_comment_id")
        .eq("id", requestId)
        .single()
    ).data!.origin_process_step_run_comment_id;

    const invalidBothTargets = await admin.from("notifications").insert({
      workspace_id: fixture.workspaceId,
      recipient_user_id: fixture.secondWorker.id,
      event_type: "process_step_run_input_request_created",
      process_step_run_input_request_id: requestId,
      process_step_run_comment_id: originId,
      process_run_id: fixture.activeRunId,
      process_step_run_id: fixture.steps.activeHumanTask,
      title: "Invalid shape",
      destination_href: `/process-runs/${fixture.activeRunId}#step-input-request-${requestId}`,
      dedup_key: `invalid-shape:${randomUUID()}`,
    });
    expect(invalidBothTargets.error).not.toBeNull();

    const invalidMissingRequest = await admin.from("notifications").insert({
      workspace_id: fixture.workspaceId,
      recipient_user_id: fixture.secondWorker.id,
      event_type: "process_step_run_input_request_created",
      process_run_id: fixture.activeRunId,
      process_step_run_id: fixture.steps.activeHumanTask,
      title: "Invalid missing request",
      destination_href: `/process-runs/${fixture.activeRunId}`,
      dedup_key: `invalid-missing:${randomUUID()}`,
    });
    expect(invalidMissingRequest.error).not.toBeNull();

    // Cross-family ambiguity: a process_step_run_input_request_id set
    // alongside a record_input_request_id must also be rejected by the
    // widened 5-arm CHECK, not just the two same-family combinations above.
    const invalidCrossFamily = await admin.from("notifications").insert({
      workspace_id: fixture.workspaceId,
      recipient_user_id: fixture.secondWorker.id,
      event_type: "process_step_run_input_request_created",
      process_step_run_input_request_id: requestId,
      record_input_request_id: randomUUID(),
      title: "Invalid cross-family",
      destination_href: `/process-runs/${fixture.activeRunId}#step-input-request-${requestId}`,
      dedup_key: `invalid-cross-family:${randomUUID()}`,
    });
    expect(invalidCrossFamily.error).not.toBeNull();

    const invalidRespondedCancelled = await admin
      .from("process_step_run_input_requests")
      .update({
        response_process_step_run_comment_id: originId,
        cancelled_at: new Date().toISOString(),
        cancelled_by_user_id: fixture.worker.id,
      })
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", requestId);
    expect(invalidRespondedCancelled.error).not.toBeNull();

    const rawInsert = await recipientClient.from("process_step_run_input_requests").insert({
      workspace_id: fixture.workspaceId,
      process_run_id: fixture.activeRunId,
      process_step_run_id: fixture.steps.activeHumanTask,
      origin_process_step_run_comment_id: randomUUID(),
      recipient_user_id: fixture.secondWorker.id,
    });
    expect(rawInsert.error).not.toBeNull();

    const rawUpdate = await recipientClient
      .from("process_step_run_input_requests")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", requestId);
    expect(rawUpdate.error).not.toBeNull();

    const rawDelete = await recipientClient
      .from("process_step_run_input_requests")
      .delete()
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", requestId);
    expect(rawDelete.error).not.toBeNull();
  });
});

describe("process step run input request impersonated authorship", () => {
  it("derives requester and responder attribution from linked step comments and prevents identity spoofing by construction", async () => {
    const adminClient = await administratorClient();
    const admin = createSupabaseTestClient();

    const startRequesterImpersonation = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.worker.id,
    });
    expect(startRequesterImpersonation.error).toBeNull();

    const requestId = await createRequest(adminClient, fixture.secondWorker.id, "Impersonated request body.");
    await endAnyActiveSession(adminClient);

    const startResponderImpersonation = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.secondWorker.id,
    });
    expect(startResponderImpersonation.error).toBeNull();

    const responseCommentId = await respondRequest(adminClient, requestId, "Impersonated response body.");
    const listed = await listRequests(adminClient);
    const request = listed.find((row) => row.id === requestId);
    expect(request).toMatchObject({
      origin_author_user_id: fixture.worker.id,
      origin_author_label: fixture.worker.email,
      origin_real_actor_user_id: fixture.administrator.id,
      origin_real_actor_label: fixture.administrator.email,
      response_process_step_run_comment_id: responseCommentId,
      response_author_user_id: fixture.secondWorker.id,
      response_author_label: fixture.secondWorker.email,
      response_real_actor_user_id: fixture.administrator.id,
      response_real_actor_label: fixture.administrator.email,
    });

    const storage = await admin
      .from("process_step_run_comments")
      .select("id, author_user_id, real_actor_user_id")
      .in("id", [request!.origin_process_step_run_comment_id, responseCommentId])
      .order("id", { ascending: true });
    expect(storage.error).toBeNull();
    expect(storage.data).toEqual(
      [
        {
          id: request!.origin_process_step_run_comment_id,
          author_user_id: fixture.worker.id,
          real_actor_user_id: fixture.administrator.id,
        },
        {
          id: responseCommentId,
          author_user_id: fixture.secondWorker.id,
          real_actor_user_id: fixture.administrator.id,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
