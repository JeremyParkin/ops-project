// DB/RPC-level coverage for Phase 8D.2 notifications: assignment/due-soon/
// overdue idempotency, cross-user isolation, mark-read scoping, system-only
// creation, and the My Work/notification separation. Requires migration
// 0064 applied.
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
  DEMO_WORKSPACE_ID,
  getE2eWorkspaceAdministratorRoleId,
  type TestEntity,
  type TestRun,
} from "../../tests/e2e/helpers/supabase-test-data";

const runs: TestRun[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }

  if (createdUserIds.length > 0) {
    const admin = createSupabaseTestClient();
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
}, 30_000);

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function createTestMember(label: string) {
  const admin = createSupabaseTestClient();
  const password = `E2E-notif-${randomUUID()}!`;
  const email = `e2e-notif-${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test member.");
  createdUserIds.push(data.user.id);

  const roleId = await getE2eWorkspaceAdministratorRoleId(admin, DEMO_WORKSPACE_ID);
  const { error: membershipError } = await admin
    .from("workspace_memberships")
    .insert({ workspace_id: DEMO_WORKSPACE_ID, user_id: data.user.id, role_id: roleId });
  if (membershipError) throw new Error(membershipError.message);

  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(signInError.message);

  return { userId: data.user.id, email, client };
}

async function createTemplateWithAssignedStep({
  run,
  entity,
  assigneeUserId,
  dueRule,
}: {
  run: TestRun;
  entity: TestEntity;
  assigneeUserId: string | null;
  dueRule?: { amount: number; unit: "hours" | "days" };
}) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const nodeId = randomUUID();

  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Notification Template`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await admin.from("process_nodes").insert({
    id: nodeId,
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    node_type: "human_task",
    name: "Review summary",
    position: 1,
    assignee_user_id: assigneeUserId,
    config: dueRule ? { due_rule: dueRule } : {},
  });
  if (nodeError) throw new Error(nodeError.message);

  return templateId;
}

async function startRun(templateId: string, entity: TestEntity, recordId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: templateId,
    p_origin_entity_type_id: entity.id,
    p_origin_record_id: recordId,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

describe("assignment notifications", () => {
  it("creates exactly one notification when a step activates with an assignee", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const worker = await createTestMember("assign-one");
    const entity = await createEntity(admin, run, "Notif Assign Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: worker.userId });

    const runId = await startRun(templateId, entity, recordId);

    const { data: notifications, error } = await admin
      .from("notifications")
      .select("*")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("recipient_user_id", worker.userId)
      .eq("process_run_id", runId);
    expect(error).toBeNull();
    expect(notifications).toHaveLength(1);
    expect(notifications![0].event_type).toBe("step_assigned");
    expect(notifications![0].title).toBe("Review summary is ready for you");
    expect(notifications![0].destination_href).toBe(`/process-runs/${runId}`);
    expect(notifications![0].dedup_key).toMatch(/^assignment:/);
    expect(notifications![0].read_at).toBeNull();

    // Scoped to step_assigned specifically -- since Phase 8D.3
    // (migration 0065), starting a run also unconditionally records its own
    // process_started event, so an unfiltered query for this process_run_id
    // now legitimately returns two rows. What this test actually verifies
    // -- exactly one step_assigned event, not a duplicate -- is unchanged.
    const { data: events, error: eventsError } = await admin
      .from("workspace_events")
      .select("*")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .eq("event_type", "step_assigned");
    expect(eventsError).toBeNull();
    expect(events).toHaveLength(1);
    expect(events![0].event_type).toBe("step_assigned");
  });

  it("does not notify when a step has no assignee", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Notif Unassigned Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: null });

    const runId = await startRun(templateId, entity, recordId);

    const { data: notifications, error } = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId);
    expect(error).toBeNull();
    expect(notifications).toHaveLength(0);
  });

  it("the dedup constraint itself rejects a second notification for the same step-run/event pair", async () => {
    // private.activate_process_step_run rejects re-activating a non-pending
    // step before ever reaching the notification insert, and every caller
    // that could plausibly retry (wait resumption, recurrence occurrence
    // claiming, the one-active-run-per-origin index for manual/workflow
    // starts) already has its own upstream idempotency guard -- so a
    // genuine double-activation of the same step can't be reproduced
    // through any real product path. What actually provides "never
    // duplicate, even under a retry neither of us has thought of" is the
    // dedup_key unique constraint itself; this exercises that constraint
    // directly, independent of which caller path might one day retry.
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const worker = await createTestMember("assign-dup");
    const entity = await createEntity(admin, run, "Notif Dup Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: worker.userId });
    const runId = await startRun(templateId, entity, recordId);

    const { data: stepRow } = await admin
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single<{ id: string }>();
    const { data: existing } = await admin
      .from("notifications")
      .select("dedup_key")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_step_run_id", stepRow!.id)
      .single<{ dedup_key: string }>();
    expect(existing?.dedup_key).toBe(`assignment:${stepRow!.id}`);

    const { error: duplicateInsertError } = await admin.from("notifications").insert({
      id: randomUUID(),
      workspace_id: DEMO_WORKSPACE_ID,
      recipient_user_id: worker.userId,
      event_type: "step_assigned",
      process_run_id: runId,
      process_step_run_id: stepRow!.id,
      title: "Duplicate attempt",
      destination_href: `/process-runs/${runId}`,
      dedup_key: existing!.dedup_key,
    });
    expect(duplicateInsertError).not.toBeNull();
    expect(duplicateInsertError!.message).toMatch(/duplicate key|unique constraint/i);

    const { data: notifications, error } = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_step_run_id", stepRow!.id);
    expect(error).toBeNull();
    expect(notifications).toHaveLength(1);
  });

  it("completing the work leaves the notification in history but the item exits My Work", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const worker = await createTestMember("complete");
    const entity = await createEntity(admin, run, "Notif Complete Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: worker.userId });
    const runId = await startRun(templateId, entity, recordId);

    const { data: stepRow } = await admin
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single<{ id: string }>();

    const { error: completeError } = await worker.client.rpc("complete_process_step_run_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_run_id: runId,
      p_step_run_id: stepRow!.id,
    });
    expect(completeError).toBeNull();

    const { data: notifications, error } = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_step_run_id", stepRow!.id);
    expect(error).toBeNull();
    expect(notifications).toHaveLength(1);

    const { data: stepAfter } = await admin
      .from("process_step_runs")
      .select("status")
      .eq("id", stepRow!.id)
      .single<{ status: string }>();
    expect(stepAfter?.status).toBe("completed");
  });
});

describe("due-soon and overdue notifications", () => {
  it("creates a due-soon notification only inside the 24h window, and repeated scheduler passes do not duplicate it", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const worker = await createTestMember("due-soon");
    const entity = await createEntity(admin, run, "Notif DueSoon Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({
      run,
      entity,
      assigneeUserId: worker.userId,
      dueRule: { amount: 1, unit: "hours" },
    });
    const runId = await startRun(templateId, entity, recordId);
    const { data: stepRow } = await admin
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single<{ id: string }>();

    const first = await admin.rpc("generate_step_due_soon_notifications_system", { p_limit: 500 });
    expect(first.error).toBeNull();
    const second = await admin.rpc("generate_step_due_soon_notifications_system", { p_limit: 500 });
    expect(second.error).toBeNull();

    const { data: notifications, error } = await admin
      .from("notifications")
      .select("event_type, dedup_key, title")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_step_run_id", stepRow!.id)
      .eq("event_type", "step_due_soon");
    expect(error).toBeNull();
    expect(notifications).toHaveLength(1);
    expect(notifications![0].title).toBe("Review summary is due soon");
  });

  it("does not create a due-soon notification for a step due beyond the 24h window", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const worker = await createTestMember("not-due-soon");
    const entity = await createEntity(admin, run, "Notif NotDueSoon Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({
      run,
      entity,
      assigneeUserId: worker.userId,
      dueRule: { amount: 30, unit: "days" },
    });
    const runId = await startRun(templateId, entity, recordId);
    const { data: stepRow } = await admin
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single<{ id: string }>();

    const { error } = await admin.rpc("generate_step_due_soon_notifications_system", { p_limit: 500 });
    expect(error).toBeNull();

    const { data: notifications } = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_step_run_id", stepRow!.id)
      .eq("event_type", "step_due_soon");
    expect(notifications).toHaveLength(0);
  });

  it("creates an overdue notification once a step's due date has passed, and repeated passes do not duplicate it", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const worker = await createTestMember("overdue");
    const entity = await createEntity(admin, run, "Notif Overdue Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({
      run,
      entity,
      assigneeUserId: worker.userId,
      dueRule: { amount: 1, unit: "hours" },
    });
    const runId = await startRun(templateId, entity, recordId);
    const { data: stepRow } = await admin
      .from("process_step_runs")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single<{ id: string }>();

    // Force the already-active step's due date into the past -- the only
    // way to deterministically test "overdue" without waiting an hour.
    const pastDue = new Date();
    pastDue.setUTCHours(pastDue.getUTCHours() - 2);
    const { error: backdateError } = await admin
      .from("process_step_runs")
      .update({ due_at: pastDue.toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", stepRow!.id);
    expect(backdateError).toBeNull();

    const first = await admin.rpc("generate_step_overdue_notifications_system", { p_limit: 500 });
    expect(first.error).toBeNull();
    const second = await admin.rpc("generate_step_overdue_notifications_system", { p_limit: 500 });
    expect(second.error).toBeNull();

    const { data: notifications, error } = await admin
      .from("notifications")
      .select("event_type, title")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_step_run_id", stepRow!.id)
      .eq("event_type", "step_overdue");
    expect(error).toBeNull();
    expect(notifications).toHaveLength(1);
    expect(notifications![0].title).toBe("Review summary is overdue");
  });

  it("the reminder scheduler RPCs are unreachable for an authenticated, non-service-role caller", async () => {
    const worker = await createTestMember("reminder-authority");

    const dueSoonResult = await worker.client.rpc("generate_step_due_soon_notifications_system", {
      p_limit: 10,
    });
    expect(dueSoonResult.error).not.toBeNull();

    const overdueResult = await worker.client.rpc("generate_step_overdue_notifications_system", {
      p_limit: 10,
    });
    expect(overdueResult.error).not.toBeNull();
  });
});

describe("recurrence-started event without a notification", () => {
  it("start_process_run_system records a recurrence_started_process event but creates no notification for it", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const worker = await createTestMember("recurrence-event");
    const entity = await createEntity(admin, run, "Notif Recurrence Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: worker.userId });

    const { data: runId, error } = await admin.rpc("start_process_run_system", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: templateId,
      p_origin_entity_type_id: entity.id,
      p_origin_record_id: recordId,
      p_originating_recurrence_occurrence_id: null,
    });
    expect(error).toBeNull();

    const { data: events, error: eventsError } = await admin
      .from("workspace_events")
      .select("event_type")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId as string)
      .eq("event_type", "recurrence_started_process");
    expect(eventsError).toBeNull();
    expect(events).toHaveLength(1);

    // The first step still gets its ordinary assignment notification --
    // recurrence-started runs activate through the exact same canonical
    // path as any other run.
    const { data: assignmentNotifications } = await admin
      .from("notifications")
      .select("id, event_type")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId as string);
    expect(assignmentNotifications).toHaveLength(1);
    expect(assignmentNotifications![0].event_type).toBe("step_assigned");
  });
});

describe("read-state scoping and cross-user isolation", () => {
  it("a worker can only see their own notifications, not another member's", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const workerA = await createTestMember("iso-a");
    const workerB = await createTestMember("iso-b");
    const entity = await createEntity(admin, run, "Notif Isolation Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: workerA.userId });
    await startRun(templateId, entity, recordId);

    const { data: asWorkerA, error: workerAError } = await workerA.client
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID);
    expect(workerAError).toBeNull();
    expect((asWorkerA ?? []).length).toBeGreaterThan(0);

    const { data: asWorkerB, error: workerBError } = await workerB.client
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID);
    expect(workerBError).toBeNull();
    expect(asWorkerB).toHaveLength(0);
  });

  it("mark_notification_read_authorized only affects the caller's own notification", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const workerA = await createTestMember("mark-a");
    const workerB = await createTestMember("mark-b");
    const entity = await createEntity(admin, run, "Notif MarkRead Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: workerA.userId });
    const runId = await startRun(templateId, entity, recordId);
    const { data: notification } = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single<{ id: string }>();

    // Worker B attempts to mark worker A's notification read -- must
    // silently no-op, never actually marking it read.
    const { error: crossReadError } = await workerB.client.rpc("mark_notification_read_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_notification_id: notification!.id,
    });
    expect(crossReadError).toBeNull();

    const { data: stillUnread } = await admin
      .from("notifications")
      .select("read_at")
      .eq("id", notification!.id)
      .single<{ read_at: string | null }>();
    expect(stillUnread?.read_at).toBeNull();

    const { error: ownReadError } = await workerA.client.rpc("mark_notification_read_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_notification_id: notification!.id,
    });
    expect(ownReadError).toBeNull();

    const { data: nowRead } = await admin
      .from("notifications")
      .select("read_at")
      .eq("id", notification!.id)
      .single<{ read_at: string | null }>();
    expect(nowRead?.read_at).not.toBeNull();
  });

  it("mark_all_notifications_read_authorized only affects the current user's own notifications in the current workspace", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const workerA = await createTestMember("markall-a");
    const workerB = await createTestMember("markall-b");
    const entity = await createEntity(admin, run, "Notif MarkAll Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordA = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} A Client` } });
    const recordB = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} B Client` } });
    const templateA = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: workerA.userId });
    const templateB = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: workerB.userId });
    await startRun(templateA, entity, recordA);
    await startRun(templateB, entity, recordB);

    const { error: markAllError } = await workerA.client.rpc("mark_all_notifications_read_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
    });
    expect(markAllError).toBeNull();

    const { data: workerANotifications } = await admin
      .from("notifications")
      .select("read_at")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("recipient_user_id", workerA.userId);
    expect(workerANotifications!.every((n) => n.read_at !== null)).toBe(true);

    const { data: workerBNotifications } = await admin
      .from("notifications")
      .select("read_at")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("recipient_user_id", workerB.userId);
    expect(workerBNotifications!.every((n) => n.read_at === null)).toBe(true);
  });

  it("marking a notification read does not change My Work state", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const worker = await createTestMember("myworkseparation");
    const entity = await createEntity(admin, run, "Notif MyWork Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
    const templateId = await createTemplateWithAssignedStep({ run, entity, assigneeUserId: worker.userId });
    const runId = await startRun(templateId, entity, recordId);
    const { data: stepBefore } = await admin
      .from("process_step_runs")
      .select("id, status, assignee_user_id, due_at")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single();
    const { data: notification } = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single<{ id: string }>();

    const { error: markReadError } = await worker.client.rpc("mark_notification_read_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_notification_id: notification!.id,
    });
    expect(markReadError).toBeNull();

    const { data: stepAfter } = await admin
      .from("process_step_runs")
      .select("id, status, assignee_user_id, due_at")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_run_id", runId)
      .single();

    expect(stepAfter).toEqual(stepBefore);
  });
});
