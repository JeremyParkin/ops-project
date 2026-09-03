// DB/RPC-level verification for Phase 10.3 process step-run Comments.
// Requires migration 0088 applied. Covers: eligible step/status behavior,
// process capability authorization, workspace isolation, impersonation
// attribution, tombstones, mentions/notifications, atomic rollback, and the
// closed raw-table write posture.
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
  completedApproval: string;
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
  worker: User;
  secondWorker: User;
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
  return `e2e-step-comments-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `StepComments-${randomUUID()}!`;
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
    process_template_name: "Step discussion template",
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

async function createStepComment(
  client: SupabaseClient,
  workspaceId: string,
  processRunId: string,
  processStepRunId: string,
  body: string,
  mentionedUserIds: string[] = [],
) {
  const { data, error } = await client.rpc("create_process_step_run_comment_with_mentions_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_process_step_run_id: processStepRunId,
    p_body: body,
    p_mentioned_user_ids: mentionedUserIds,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

async function listStepComments(
  client: SupabaseClient,
  workspaceId: string,
  processRunId: string,
  processStepRunId: string,
) {
  const { data, error } = await client.rpc("list_process_step_run_comments_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_process_step_run_id: processStepRunId,
    p_limit: 100,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    body: string | null;
    author_user_id: string;
    author_label: string;
    real_actor_user_id: string | null;
    real_actor_label: string | null;
    created_at: string;
    tombstoned_at: string | null;
    tombstoned_by_user_id: string | null;
    tombstoned_by_label: string | null;
    tombstoned_by_real_actor_user_id: string | null;
    tombstoned_by_real_actor_label: string | null;
  }>;
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = await createWorkspace("E2E Step Comments");
  const otherWorkspaceId = await createWorkspace("E2E Step Comments Other");

  const administratorRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members",
    "workspace.manage_roles",
    "records.operate",
    "processes.operate",
    "workspace.impersonate_users",
  ]);
  const processOperatorRoleId = await createRole(workspaceId, "Process operator", ["processes.operate"]);
  const recordOperatorRoleId = await createRole(workspaceId, "Record operator", ["records.operate"]);
  const readOnlyRoleId = await createRole(workspaceId, "Read only", []);
  const otherProcessOperatorRoleId = await createRole(otherWorkspaceId, "Other process operator", ["processes.operate"]);

  const worker = await createUser("worker");
  const secondWorker = await createUser("second-worker");
  const administrator = await createUser("administrator");
  const readOnly = await createUser("read-only");
  const recordOnly = await createUser("record-only");
  const otherWorker = await createUser("other-worker");
  const deactivatedMember = await createUser("deactivated");

  await addMembership(workspaceId, worker.id, processOperatorRoleId);
  await addMembership(workspaceId, secondWorker.id, processOperatorRoleId);
  await addMembership(workspaceId, administrator.id, administratorRoleId);
  await addMembership(workspaceId, readOnly.id, readOnlyRoleId);
  await addMembership(workspaceId, recordOnly.id, recordOperatorRoleId);
  await addMembership(workspaceId, deactivatedMember.id, processOperatorRoleId);
  await addMembership(otherWorkspaceId, otherWorker.id, otherProcessOperatorRoleId);

  const { error: deactivateError } = await admin
    .from("workspace_memberships")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("user_id", deactivatedMember.id);
  if (deactivateError) throw new Error(deactivateError.message);

  const entityTypeId = await createEntityType(workspaceId, `Step Comment Object ${workspaceId.slice(0, 6)}`);
  const otherEntityTypeId = await createEntityType(otherWorkspaceId, `Step Comment Other Object ${otherWorkspaceId.slice(0, 6)}`);
  const recordId = await createRecord(workspaceId, entityTypeId, "Primary record");
  const otherRecordId = await createRecord(otherWorkspaceId, otherEntityTypeId, "Other record");
  const templateId = await createTemplate(workspaceId, entityTypeId, "Step discussion template");
  const otherTemplateId = await createTemplate(otherWorkspaceId, otherEntityTypeId, "Other step discussion template");
  const activeRunId = await createRun({ workspaceId, entityTypeId, recordId, templateId });
  const completedRunId = await createRun({ workspaceId, entityTypeId, recordId, templateId, status: "completed" });
  const otherRunId = await createRun({
    workspaceId: otherWorkspaceId,
    entityTypeId: otherEntityTypeId,
    recordId: otherRecordId,
    templateId: otherTemplateId,
  });

  const steps = {
    activeHumanTask: await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 1, nodeType: "human_task", status: "active", name: "Review request" }),
    activeApproval: await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 2, nodeType: "approval", status: "active", name: "Approve request" }),
    completedHumanTask: await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 3, nodeType: "human_task", status: "completed", name: "Completed handoff" }),
    completedApproval: await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 4, nodeType: "approval", status: "completed", name: "Completed approval" }),
    activeWait: await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 5, nodeType: "wait", status: "active", name: "Wait internally" }),
    pendingHumanTask: await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 6, nodeType: "human_task", status: "pending", name: "Future task" }),
  };
  const completedRunStepId = await createStep({
    workspaceId,
    processRunId: completedRunId,
    stepIndex: 1,
    nodeType: "human_task",
    status: "completed",
    name: "Completed run task",
  });
  await createStep({
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
    worker,
    secondWorker,
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
      "process_step_run_comments",
      "record_comments",
      "process_runs",
      "process_templates",
      "field_definitions",
      "entity_records",
      "entity_types",
      "workspaces",
    ]) {
      const { error } = await admin.from(table).delete().in(table === "workspaces" ? "id" : "workspace_id", createdWorkspaceIds);
      if (error) failures.push(`${table}: ${error.message}`);
    }
  }

  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) {
    throw new Error(`process-step-run-comments-commit afterAll cleanup: ${failures.length} failure(s):\n${failures.join("\n")}`);
  }
}, 45_000);

describe("process step-run comment DB/RPC gate", () => {
  it("enforces eligibility, status, body, ordering, workspace, and capability boundaries", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const readOnlyClient = await authenticatedClient(fixture.readOnly);
    const recordOnlyClient = await authenticatedClient(fixture.recordOnly);
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const admin = createSupabaseTestClient();

    const humanCommentId = await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.activeRunId,
      fixture.steps.activeHumanTask,
      "  Human task body  ",
    );
    const approvalCommentId = await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.activeRunId,
      fixture.steps.activeApproval,
      "Approval body",
    );
    expect(humanCommentId).toMatch(/[0-9a-f-]{36}/);
    expect(approvalCommentId).toMatch(/[0-9a-f-]{36}/);

    const stored = await admin
      .from("process_step_run_comments")
      .select("body, author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", humanCommentId)
      .single();
    expect(stored.error).toBeNull();
    expect(stored.data).toEqual({
      body: "Human task body",
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
      real_actor_user_id: null,
      real_actor_label: null,
    });

    const spacesOnly = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_body: "   ",
      p_mentioned_user_ids: [],
    });
    expect(spacesOnly.error?.message).toContain("Comment body is required");

    const tabsOnly = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_body: "\n\t\n",
      p_mentioned_user_ids: [],
    });
    expect(tabsOnly.error?.message).toContain("Comment body is required");

    const multilineCommentId = await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.activeRunId,
      fixture.steps.activeHumanTask,
      " \n\tFirst line\n\n\t  Second line\t\n ",
    );
    const multilineStored = await admin
      .from("process_step_run_comments")
      .select("body")
      .eq("id", multilineCommentId)
      .single();
    expect(multilineStored.error).toBeNull();
    expect(multilineStored.data?.body).toBe("First line\n\n\t  Second line");

    const tooLong = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_body: "x".repeat(4001),
      p_mentioned_user_ids: [],
    });
    expect(tooLong.error?.message).toContain("4000 characters or fewer");

    await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.activeRunId,
      fixture.steps.completedHumanTask,
      "Completed step is still commentable",
    );
    await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.completedRunId,
      fixture.completedRunStepId,
      "Completed run is still commentable",
    );

    const waitCreate = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeWait,
      p_body: "Internal machinery should reject this",
      p_mentioned_user_ids: [],
    });
    expect(waitCreate.error?.message).toContain("Step not found or not open for discussion");

    const waitList = await workerClient.rpc("list_process_step_run_comments_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeWait,
      p_limit: 100,
    });
    expect(waitList.error?.message).toContain("Step not found");

    const pendingCreate = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.pendingHumanTask,
      p_body: "Future task should reject this",
      p_mentioned_user_ids: [],
    });
    expect(pendingCreate.error?.message).toContain("Step not found or not open for discussion");

    const wrongRun = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.completedRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_body: "Wrong run",
      p_mentioned_user_ids: [],
    });
    expect(wrongRun.error?.message).toContain("Step not found");

    const missingStep = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: randomUUID(),
      p_body: "Missing",
      p_mentioned_user_ids: [],
    });
    expect(missingStep.error?.message).toContain("Step not found");

    const readOnlyList = await listStepComments(
      readOnlyClient,
      fixture.workspaceId,
      fixture.activeRunId,
      fixture.steps.activeHumanTask,
    );
    expect(readOnlyList.map((comment) => comment.id)).toContain(humanCommentId);

    const readOnlyCreate = await readOnlyClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_body: "No process capability",
      p_mentioned_user_ids: [],
    });
    expect(readOnlyCreate.error?.message).toContain("processes.operate");

    const recordOnlyCreate = await recordOnlyClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_body: "Records operate is not enough",
      p_mentioned_user_ids: [],
    });
    expect(recordOnlyCreate.error?.message).toContain("processes.operate");

    const isolatedRead = await otherWorkerClient.rpc("list_process_step_run_comments_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_limit: 100,
    });
    expect(isolatedRead.error?.message).toContain("Workspace access denied");

    const isolatedCreate = await otherWorkerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.activeHumanTask,
      p_body: "Foreign workspace",
      p_mentioned_user_ids: [],
    });
    expect(isolatedCreate.error).not.toBeNull();

    const sameTimestamp = "2026-01-01T00:00:00.000Z";
    const tieIds = [randomUUID(), randomUUID()].sort();
    const { error: tieInsertError } = await admin.from("process_step_run_comments").insert([
      {
        id: tieIds[1],
        workspace_id: fixture.workspaceId,
        process_run_id: fixture.activeRunId,
        process_step_run_id: fixture.steps.activeHumanTask,
        body: "Tie B",
        author_user_id: fixture.worker.id,
        author_label: fixture.worker.email,
        created_at: sameTimestamp,
      },
      {
        id: tieIds[0],
        workspace_id: fixture.workspaceId,
        process_run_id: fixture.activeRunId,
        process_step_run_id: fixture.steps.activeHumanTask,
        body: "Tie A",
        author_user_id: fixture.worker.id,
        author_label: fixture.worker.email,
        created_at: sameTimestamp,
      },
    ]);
    expect(tieInsertError).toBeNull();

    const comments = await listStepComments(workerClient, fixture.workspaceId, fixture.activeRunId, fixture.steps.activeHumanTask);
    expect(comments.slice(0, 2).map((comment) => comment.id)).toEqual(tieIds);
    expect(comments.map((comment) => comment.id)).toContain(humanCommentId);
  });

  it("keeps archived-origin discussion readable, denies new comments, and allows authorized tombstoning", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const commentId = await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.activeRunId,
      fixture.steps.completedApproval,
      "Archive-sensitive comment",
    );
    const admin = createSupabaseTestClient();
    const { error: archiveError } = await admin
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", fixture.recordId);
    expect(archiveError).toBeNull();

    const readable = await listStepComments(workerClient, fixture.workspaceId, fixture.activeRunId, fixture.steps.completedApproval);
    expect(readable.map((comment) => comment.id)).toContain(commentId);

    const createAfterArchive = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.activeRunId,
      p_process_step_run_id: fixture.steps.completedApproval,
      p_body: "Should be read only now",
      p_mentioned_user_ids: [],
    });
    expect(createAfterArchive.error?.message).toContain("Origin record not found or archived");

    const tombstoneAfterArchive = await workerClient.rpc("tombstone_process_step_run_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: commentId,
    });
    expect(tombstoneAfterArchive.error).toBeNull();

    const tombstoned = await listStepComments(workerClient, fixture.workspaceId, fixture.activeRunId, fixture.steps.completedApproval);
    const row = tombstoned.find((comment) => comment.id === commentId);
    expect(row?.body).toBeNull();
    expect(row?.tombstoned_at).toBeTruthy();

    const { error: restoreError } = await admin
      .from("entity_records")
      .update({ archived_at: null })
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", fixture.recordId);
    expect(restoreError).toBeNull();
  });

  it("records effective and real actors, enforces tombstone authority, and keeps raw writes closed", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const secondWorkerClient = await authenticatedClient(fixture.secondWorker);
    const adminClient = await administratorClient();
    const admin = createSupabaseTestClient();

    const commentId = await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.completedRunId,
      fixture.completedRunStepId,
      "Tombstone candidate",
    );
    const storedBefore = await admin
      .from("process_step_run_comments")
      .select("body, author_user_id, author_label, created_at")
      .eq("id", commentId)
      .single();
    expect(storedBefore.error).toBeNull();

    const ordinaryOtherTombstone = await secondWorkerClient.rpc("tombstone_process_step_run_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: commentId,
    });
    expect(ordinaryOtherTombstone.error?.message).toContain("You can only remove your own comments");

    const ownTombstone = await workerClient.rpc("tombstone_process_step_run_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: commentId,
    });
    expect(ownTombstone.error).toBeNull();

    const secondTombstone = await workerClient.rpc("tombstone_process_step_run_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: commentId,
    });
    expect(secondTombstone.error).toBeNull();

    const storedAfter = await admin
      .from("process_step_run_comments")
      .select("body, author_user_id, author_label, created_at, tombstoned_at, tombstoned_by_user_id, tombstoned_by_label")
      .eq("id", commentId)
      .single();
    expect(storedAfter.error).toBeNull();
    expect(storedAfter.data?.body).toBe(storedBefore.data?.body);
    expect(storedAfter.data?.author_user_id).toBe(storedBefore.data?.author_user_id);
    expect(storedAfter.data?.author_label).toBe(storedBefore.data?.author_label);
    expect(storedAfter.data?.created_at).toBe(storedBefore.data?.created_at);
    expect(storedAfter.data?.tombstoned_by_user_id).toBe(fixture.worker.id);
    expect(storedAfter.data?.tombstoned_by_label).toBe(fixture.worker.email);

    const projected = await listStepComments(workerClient, fixture.workspaceId, fixture.completedRunId, fixture.completedRunStepId);
    const projectedTombstone = projected.find((comment) => comment.id === commentId);
    expect(projectedTombstone?.body).toBeNull();
    expect(projectedTombstone?.tombstoned_at).toBe(storedAfter.data?.tombstoned_at);

    const adminTargetCommentId = await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.completedRunId,
      fixture.completedRunStepId,
      "Administrator can remove this",
    );
    const adminTombstone = await adminClient.rpc("tombstone_process_step_run_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: adminTargetCommentId,
    });
    expect(adminTombstone.error).toBeNull();

    const session = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.secondWorker.id,
    });
    expect(session.error).toBeNull();
    const impersonatedCommentId = await createStepComment(
      adminClient,
      fixture.workspaceId,
      fixture.completedRunId,
      fixture.completedRunStepId,
      "Impersonated author",
    );
    const impersonatedStored = await admin
      .from("process_step_run_comments")
      .select("author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", impersonatedCommentId)
      .single();
    expect(impersonatedStored.error).toBeNull();
    expect(impersonatedStored.data).toEqual({
      author_user_id: fixture.secondWorker.id,
      author_label: fixture.secondWorker.email,
      real_actor_user_id: fixture.administrator.id,
      real_actor_label: fixture.administrator.email,
    });
    await endAnyActiveSession(adminClient);

    const rawInsert = await workerClient.from("process_step_run_comments").insert({
      workspace_id: fixture.workspaceId,
      process_run_id: fixture.completedRunId,
      process_step_run_id: fixture.completedRunStepId,
      body: "Raw insert",
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
    });
    expect(rawInsert.error).not.toBeNull();

    const rawUpdate = await workerClient
      .from("process_step_run_comments")
      .update({ body: "Raw update" })
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", impersonatedCommentId);
    expect(rawUpdate.error).not.toBeNull();

    const rawDeleteMention = await workerClient
      .from("process_step_run_comment_mentions")
      .delete()
      .eq("workspace_id", fixture.workspaceId);
    expect(rawDeleteMention.error).not.toBeNull();
  });

  it("creates stable mentions and notifications atomically", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const secondWorkerClient = await authenticatedClient(fixture.secondWorker);
    const adminClient = await administratorClient();
    const admin = createSupabaseTestClient();

    const plainCommentId = await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.completedRunId,
      fixture.completedRunStepId,
      "Plain process step comment",
      [],
    );
    const plainMentions = await admin
      .from("process_step_run_comment_mentions")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_comment_id", plainCommentId);
    expect(plainMentions.error).toBeNull();
    expect(plainMentions.data).toEqual([]);

    const commentId = await createStepComment(
      workerClient,
      fixture.workspaceId,
      fixture.completedRunId,
      fixture.completedRunStepId,
      `Heads up @${fixture.secondWorker.email} and @${fixture.administrator.email}`,
      [fixture.secondWorker.id, fixture.secondWorker.id, fixture.worker.id, fixture.administrator.id],
    );
    const mentions = await admin
      .from("process_step_run_comment_mentions")
      .select("process_step_run_comment_id, mentioned_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_comment_id", commentId)
      .order("mentioned_user_id", { ascending: true });
    expect(mentions.error).toBeNull();
    expect(mentions.data).toEqual([
      { process_step_run_comment_id: commentId, mentioned_user_id: fixture.administrator.id },
      { process_step_run_comment_id: commentId, mentioned_user_id: fixture.secondWorker.id },
      { process_step_run_comment_id: commentId, mentioned_user_id: fixture.worker.id },
    ].sort((a, b) => a.mentioned_user_id.localeCompare(b.mentioned_user_id)));

    const notifications = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, process_step_run_comment_id, record_comment_id, process_run_id, process_step_run_id, entity_type_id, entity_record_id, title, destination_href, dedup_key, read_at")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_comment_id", commentId)
      .order("recipient_user_id", { ascending: true });
    expect(notifications.error).toBeNull();
    expect(notifications.data).toEqual([
      {
        recipient_user_id: fixture.administrator.id,
        event_type: "process_step_run_comment_mentioned",
        process_step_run_comment_id: commentId,
        record_comment_id: null,
        process_run_id: fixture.completedRunId,
        process_step_run_id: fixture.completedRunStepId,
        entity_type_id: fixture.entityTypeId,
        entity_record_id: fixture.recordId,
        title: `${fixture.worker.email} mentioned you in a process step`,
        destination_href: `/process-runs/${fixture.completedRunId}#step-comment-${commentId}`,
        dedup_key: `process_step_run_comment_mention:${commentId}:${fixture.administrator.id}`,
        read_at: null,
      },
      {
        recipient_user_id: fixture.secondWorker.id,
        event_type: "process_step_run_comment_mentioned",
        process_step_run_comment_id: commentId,
        record_comment_id: null,
        process_run_id: fixture.completedRunId,
        process_step_run_id: fixture.completedRunStepId,
        entity_type_id: fixture.entityTypeId,
        entity_record_id: fixture.recordId,
        title: `${fixture.worker.email} mentioned you in a process step`,
        destination_href: `/process-runs/${fixture.completedRunId}#step-comment-${commentId}`,
        dedup_key: `process_step_run_comment_mention:${commentId}:${fixture.secondWorker.id}`,
        read_at: null,
      },
    ].sort((a, b) => a.recipient_user_id.localeCompare(b.recipient_user_id)));

    const recipientVisible = await secondWorkerClient
      .from("notifications")
      .select("recipient_user_id, process_step_run_comment_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_comment_id", commentId);
    expect(recipientVisible.error).toBeNull();
    expect(recipientVisible.data).toEqual([
      { recipient_user_id: fixture.secondWorker.id, process_step_run_comment_id: commentId },
    ]);

    const authorVisible = await workerClient
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_comment_id", commentId);
    expect(authorVisible.error).toBeNull();
    expect(authorVisible.data).toEqual([]);

    const markRead = await secondWorkerClient.rpc("mark_notification_read_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_notification_id: (await secondWorkerClient
        .from("notifications")
        .select("id")
        .eq("workspace_id", fixture.workspaceId)
        .eq("process_step_run_comment_id", commentId)
        .single()).data!.id,
    });
    expect(markRead.error).toBeNull();

    const invalidMentionBefore = await admin
      .from("process_step_run_comments")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("body", "Invalid mention should roll back");
    expect(invalidMentionBefore.error).toBeNull();
    expect(invalidMentionBefore.data).toEqual([]);

    const invalidMention = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.completedRunId,
      p_process_step_run_id: fixture.completedRunStepId,
      p_body: "Invalid mention should roll back",
      p_mentioned_user_ids: [fixture.otherWorker.id],
    });
    expect(invalidMention.error?.message).toContain("Mention recipients must be active workspace members");
    const invalidMentionAfter = await admin
      .from("process_step_run_comments")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("body", "Invalid mention should roll back");
    expect(invalidMentionAfter.error).toBeNull();
    expect(invalidMentionAfter.data).toEqual([]);

    const deactivatedMention = await workerClient.rpc("create_process_step_run_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_process_run_id: fixture.completedRunId,
      p_process_step_run_id: fixture.completedRunStepId,
      p_body: "Deactivated mention should roll back",
      p_mentioned_user_ids: [fixture.deactivatedMember.id],
    });
    expect(deactivatedMention.error?.message).toContain("Mention recipients must be active workspace members");

    const invalidBothTargets = await admin.from("notifications").insert({
      id: randomUUID(),
      workspace_id: fixture.workspaceId,
      recipient_user_id: fixture.secondWorker.id,
      event_type: "process_step_run_comment_mentioned",
      record_comment_id: randomUUID(),
      process_step_run_comment_id: commentId,
      process_run_id: fixture.completedRunId,
      process_step_run_id: fixture.completedRunStepId,
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      title: "Invalid both targets",
      destination_href: `/process-runs/${fixture.completedRunId}#step-comment-${commentId}`,
      dedup_key: `invalid-both:${randomUUID()}`,
    });
    expect(invalidBothTargets.error).not.toBeNull();

    const session = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.secondWorker.id,
    });
    expect(session.error).toBeNull();
    const impersonatedMentionId = await createStepComment(
      adminClient,
      fixture.workspaceId,
      fixture.completedRunId,
      fixture.completedRunStepId,
      `Via admin @${fixture.administrator.email} @${fixture.secondWorker.email}`,
      [fixture.administrator.id, fixture.secondWorker.id],
    );
    await endAnyActiveSession(adminClient);

    const impersonatedStored = await admin
      .from("process_step_run_comments")
      .select("author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", impersonatedMentionId)
      .single();
    expect(impersonatedStored.error).toBeNull();
    expect(impersonatedStored.data).toEqual({
      author_user_id: fixture.secondWorker.id,
      author_label: fixture.secondWorker.email,
      real_actor_user_id: fixture.administrator.id,
      real_actor_label: fixture.administrator.email,
    });

    const impersonatedNotifications = await admin
      .from("notifications")
      .select("recipient_user_id, title, destination_href")
      .eq("workspace_id", fixture.workspaceId)
      .eq("process_step_run_comment_id", impersonatedMentionId);
    expect(impersonatedNotifications.error).toBeNull();
    expect(impersonatedNotifications.data).toEqual([
      {
        recipient_user_id: fixture.administrator.id,
        title: `${fixture.secondWorker.email} mentioned you in a process step`,
        destination_href: `/process-runs/${fixture.completedRunId}#step-comment-${impersonatedMentionId}`,
      },
    ]);
  });
});
