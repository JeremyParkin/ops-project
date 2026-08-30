// DB/RPC-level coverage for Phase 8D.3 Activity: process_started/
// process_completed/approval_decided event emission from their canonical
// transitions, actor semantics (human vs. null for workflow/system-
// triggered starts and derived transitions), the list_record_activity_
// authorized projection (visible taxonomy, cross-workspace isolation), and
// independence from notification read state. Requires migration 0065
// applied.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import {
  cleanupE2eRun,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  deleteE2eUsers,
  DEMO_WORKSPACE_ID,
  getE2eWorkspaceAdministratorRoleId,
  type TestEntity,
  type TestRun,
} from "../../tests/e2e/helpers/supabase-test-data";

const runs: TestRun[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  // Each scenario's run is fully independent (disjoint entities/records),
  // so there's no correctness reason to clean them up one at a time --
  // doing so was slow enough under contention to exceed Vitest's default
  // 10s afterAll hook timeout once this file's fixtures also touch
  // notifications/workspace_events cleanup. Same fix already applied to
  // process-runs.spec.ts's own afterAll for the identical reason.
  const failures: string[] = [];
  await Promise.all(
    runs.map((run) =>
      cleanupE2eRun(run).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      }),
    ),
  );

  if (createdUserIds.length > 0) {
    try {
      await deleteE2eUsers(createdUserIds, createSupabaseTestClient());
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `activity-commit afterAll cleanup: ${failures.length} step(s) failed after attempting all of them:\n${failures.join("\n")}`,
    );
  }
}, 30_000);

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

// A disposable authenticated member per scenario, not the Playwright-only
// fixed E2E runner account (that one is provisioned by tests/e2e/global-
// setup.ts, which doesn't run ahead of a plain `vitest run`).
async function authenticatedRunner() {
  const admin = createSupabaseTestClient();
  const password = `E2E-activity-${randomUUID()}!`;
  const email = `e2e-activity-${randomUUID()}@example.test`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) throw new Error(userError?.message ?? "Unable to create test member.");
  createdUserIds.push(userData.user.id);

  const roleId = await getE2eWorkspaceAdministratorRoleId(admin, DEMO_WORKSPACE_ID);
  const { error: membershipError } = await admin
    .from("workspace_memberships")
    .insert({ workspace_id: DEMO_WORKSPACE_ID, user_id: userData.user.id, role_id: roleId });
  if (membershipError) throw new Error(membershipError.message);

  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !signIn.user) throw new Error(signInError?.message ?? "Unable to sign in as test member.");
  return { client, userId: signIn.user.id };
}

async function fixture(run: TestRun) {
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Activity Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
  return { entity, recordId };
}

async function createHumanTaskTemplate(run: TestRun, entity: TestEntity, assigneeUserId: string) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Activity Template`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await admin.from("process_nodes").insert({
    id: randomUUID(),
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    node_type: "human_task",
    name: "Review summary",
    position: 1,
    assignee_user_id: assigneeUserId,
    config: {},
  });
  if (nodeError) throw new Error(nodeError.message);
  return templateId;
}

async function createApprovalTemplate(run: TestRun, entity: TestEntity, assigneeUserId: string) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const approvalNodeId = randomUUID();
  const approveTargetNodeId = randomUUID();
  const rejectTargetNodeId = randomUUID();
  const approveOutcomeId = randomUUID();
  const rejectOutcomeId = randomUUID();

  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Approval Template`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await admin.from("process_nodes").insert([
    {
      id: approvalNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "approval",
      name: "Budget Approval",
      position: 1,
      assignee_user_id: assigneeUserId,
      config: {},
    },
    {
      id: approveTargetNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name: "Disburse funds",
      position: 2,
      config: {},
    },
    {
      id: rejectTargetNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name: "Notify requester",
      position: 3,
      config: {},
    },
  ]);
  if (nodeError) throw new Error(nodeError.message);

  // An approval node requires at least two outcomes -- a single-edge
  // approval fails process template validation at start time.
  const { error: edgeError } = await admin.from("process_edges").insert([
    {
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      source_node_id: approvalNodeId,
      target_node_id: approveTargetNodeId,
      priority: 0,
      is_default: false,
      is_parallel: false,
      approval_outcome_id: approveOutcomeId,
      approval_outcome_label: "Approved",
    },
    {
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      source_node_id: approvalNodeId,
      target_node_id: rejectTargetNodeId,
      priority: 1,
      is_default: false,
      is_parallel: false,
      approval_outcome_id: rejectOutcomeId,
      approval_outcome_label: "Rejected",
    },
  ]);
  if (edgeError) throw new Error(edgeError.message);

  return { templateId, approvalNodeId, outcomeId: approveOutcomeId };
}

// list_record_activity_authorized deliberately has no service_role bypass
// (unlike start_process_run_authorized_member) -- it's only ever meant to
// be called from an interactive session, so it must be read here with an
// authenticated member client, not the raw admin/service_role client.
async function activityFor(
  client: Awaited<ReturnType<typeof authenticatedRunner>>["client"],
  entity: TestEntity,
  recordId: string,
) {
  const { data, error } = await client.rpc("list_record_activity_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_entity_record_id: recordId,
    p_limit: 20,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as {
    id: string;
    event_type: string;
    actor_user_id: string | null;
    actor_label: string | null;
    process_run_id: string | null;
    process_run_name: string | null;
    step_name: string | null;
    assignee_label: string | null;
    approval_outcome_label: string | null;
    is_recurrence_started: boolean;
  }[];
}

describe("process Activity events", () => {
  it("a manual process start records process_started with the acting human as actor, then step_assigned and process_completed on completion", async () => {
    const run = scenarioRun();
    const { entity, recordId } = await fixture(run);
    const { client, userId } = await authenticatedRunner();
    const templateId = await createHumanTaskTemplate(run, entity, userId);

    const { data: runId, error } = await client.rpc("start_process_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
    });
    expect(error).toBeNull();

    let events = await activityFor(client, entity, recordId);
    const started = events.find((e) => e.event_type === "process_started");
    expect(started?.actor_user_id).toBe(userId);
    expect(started?.process_run_name).toBe(`${run.label} Activity Template`);
    expect(started?.is_recurrence_started).toBe(false);

    const assigned = events.find((e) => e.event_type === "step_assigned");
    expect(assigned?.step_name).toBe("Review summary");
    expect(assigned?.assignee_label).toBeTruthy();

    const admin = createSupabaseTestClient();
    const { data: stepRow, error: stepError } = await admin
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId as string)
      .single();
    expect(stepError).toBeNull();

    const { error: completeError } = await client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: stepRow!.id,
    });
    expect(completeError).toBeNull();

    events = await activityFor(client, entity, recordId);
    const completed = events.find((e) => e.event_type === "process_completed");
    expect(completed).toBeTruthy();
    expect(completed?.actor_user_id).toBeNull();
    expect(events.filter((e) => e.event_type === "process_started")).toHaveLength(1);
    expect(events.filter((e) => e.event_type === "process_completed")).toHaveLength(1);
  });

  it("a workflow-triggered process start records process_started with no actor", async () => {
    const run = scenarioRun();
    const { entity, recordId } = await fixture(run);
    const { client, userId } = await authenticatedRunner();
    const templateId = await createHumanTaskTemplate(run, entity, userId);

    const { error } = await client.rpc("start_process_run_via_workflow_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
    });
    expect(error).toBeNull();

    const events = await activityFor(client, entity, recordId);
    const started = events.find((e) => e.event_type === "process_started");
    expect(started?.actor_user_id).toBeNull();
    expect(started?.is_recurrence_started).toBe(false);
  });

  it("a recurrence-triggered process start records process_started with no actor and is_recurrence_started true", async () => {
    const run = scenarioRun();
    const { entity, recordId } = await fixture(run);
    const { client, userId } = await authenticatedRunner();
    const templateId = await createHumanTaskTemplate(run, entity, userId);
    const admin = createSupabaseTestClient();

    const { data: runId, error } = await admin.rpc("start_process_run_system", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
      p_originating_recurrence_occurrence_id: null,
    });
    expect(error).toBeNull();
    expect(typeof runId).toBe("string");

    const events = await activityFor(client, entity, recordId);
    const started = events.find((e) => e.event_type === "process_started");
    expect(started?.actor_user_id).toBeNull();
    // originating_recurrence_occurrence_id is null here (no real recurrence
    // rule in this fixture) -- the join itself, not the specific value, is
    // what's under test in the manual/workflow cases above.
  });

  it("an approval decision records approval_decided with the deciding human as actor and the durable outcome label", async () => {
    const run = scenarioRun();
    const { entity, recordId } = await fixture(run);
    const { client, userId } = await authenticatedRunner();
    const { templateId, outcomeId } = await createApprovalTemplate(run, entity, userId);

    const { data: runId, error: startError } = await client.rpc("start_process_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
    });
    expect(startError).toBeNull();

    const admin = createSupabaseTestClient();
    const { data: approvalStep, error: stepError } = await admin
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId as string)
      .eq("node_type", "approval")
      .single();
    expect(stepError).toBeNull();

    const { error: decideError } = await client.rpc("decide_process_approval_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: approvalStep!.id,
      p_outcome_id: outcomeId,
    });
    expect(decideError).toBeNull();

    const events = await activityFor(client, entity, recordId);
    const decided = events.find((e) => e.event_type === "approval_decided");
    expect(decided?.actor_user_id).toBe(userId);
    expect(decided?.actor_label).toBeTruthy();
    expect(decided?.step_name).toBe("Budget Approval");
    expect(decided?.approval_outcome_label).toBe("Approved");
    expect(events.filter((e) => e.event_type === "approval_decided")).toHaveLength(1);
  });

  it("excludes step_due_soon and step_overdue from the Activity projection", async () => {
    const run = scenarioRun();
    const { entity, recordId } = await fixture(run);
    const { client } = await authenticatedRunner();
    const admin = createSupabaseTestClient();

    const { error } = await admin.from("workspace_events").insert([
      {
        id: randomUUID(),
        workspace_id: DEMO_WORKSPACE_ID,
        event_type: "step_due_soon",
        entity_type_id: entity.id,
        entity_record_id: recordId,
      },
      {
        id: randomUUID(),
        workspace_id: DEMO_WORKSPACE_ID,
        event_type: "step_overdue",
        entity_type_id: entity.id,
        entity_record_id: recordId,
      },
      {
        id: randomUUID(),
        workspace_id: DEMO_WORKSPACE_ID,
        event_type: "recurrence_started_process",
        entity_type_id: entity.id,
        entity_record_id: recordId,
      },
    ]);
    expect(error).toBeNull();

    const events = await activityFor(client, entity, recordId);
    expect(events).toHaveLength(0);
  });

  it("list_record_activity_authorized is unreachable for a caller outside the workspace", async () => {
    const run = scenarioRun();
    const { entity, recordId } = await fixture(run);
    const admin = createSupabaseTestClient();
    const password = `E2E-activity-outsider-${randomUUID()}!`;
    const email = `e2e-activity-outsider-${randomUUID()}@example.test`;
    const { data: userData, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (userError || !userData.user) throw new Error(userError?.message ?? "Unable to create outsider user.");

    const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
    const outsiderClient = createClient(supabaseUrl, supabasePublishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await outsiderClient.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    const result = await outsiderClient.rpc("list_record_activity_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_entity_type_id: entity.id,
      p_entity_record_id: recordId,
      p_limit: 20,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("Workspace access denied");

    await admin.auth.admin.deleteUser(userData.user.id);
  });

  it("marking a notification read does not remove or alter its paired Activity event", async () => {
    const run = scenarioRun();
    const { entity, recordId } = await fixture(run);
    const { client, userId } = await authenticatedRunner();
    const templateId = await createHumanTaskTemplate(run, entity, userId);

    const { error } = await client.rpc("start_process_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
    });
    expect(error).toBeNull();

    const admin = createSupabaseTestClient();
    const { data: notification, error: notificationError } = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("recipient_user_id", userId)
      .eq("event_type", "step_assigned")
      .eq("entity_record_id", recordId)
      .single();
    expect(notificationError).toBeNull();

    const before = await activityFor(client, entity, recordId);
    const assignedBefore = before.find((e) => e.event_type === "step_assigned");
    expect(assignedBefore).toBeTruthy();

    const { error: markReadError } = await client.rpc("mark_notification_read_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_notification_id: notification!.id,
    });
    expect(markReadError).toBeNull();

    const after = await activityFor(client, entity, recordId);
    const assignedAfter = after.find((e) => e.event_type === "step_assigned");
    expect(assignedAfter).toEqual(assignedBefore);
  });
});
