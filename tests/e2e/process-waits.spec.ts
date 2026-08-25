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
import { loadE2eEnv, requireE2eEnv } from "./helpers/env";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const E2E_RUNNER_PASSWORD = "E2E-runner-password-2026";

type WaitRule = Record<string, unknown>;

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function authenticatedClient() {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: E2E_RUNNER_EMAIL,
    password: E2E_RUNNER_PASSWORD,
  });
  if (error) throw new Error(`Unable to sign in as E2E runner: ${error.message}`);
  return client;
}

async function createWaitFixture({
  run,
  waitRule,
  withParallel = false,
}: {
  run: TestRun;
  waitRule: WaitRule;
  withParallel?: boolean;
}) {
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Wait case", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} wait record` },
  });
  const templateId = randomUUID();
  const waitNodeId = randomUUID();
  const nextNodeId = randomUUID();
  const templateName = `${run.label} wait template`;

  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: templateName,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  if (!withParallel) {
    const { error: nodeError } = await admin.from("process_nodes").insert([
      {
        id: waitNodeId,
        workspace_id: DEMO_WORKSPACE_ID,
        process_template_id: templateId,
        node_type: "wait",
        name: "Wait for review window",
        position: 1,
        config: { wait_rule: waitRule },
      },
      {
        id: nextNodeId,
        workspace_id: DEMO_WORKSPACE_ID,
        process_template_id: templateId,
        node_type: "human_task",
        name: "Review",
        position: 2,
        config: {},
      },
    ]);
    if (nodeError) throw new Error(nodeError.message);
    const { error: edgeError } = await admin.from("process_edges").insert({
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      source_node_id: waitNodeId,
      target_node_id: nextNodeId,
      priority: 0,
      is_default: true,
      is_parallel: false,
    });
    if (edgeError) throw new Error(edgeError.message);
    return { entity, recordId, templateId, waitNodeId, nextNodeId };
  }

  const splitNodeId = randomUUID();
  const approvalNodeId = randomUUID();
  const joinNodeId = randomUUID();
  const finalNodeId = randomUUID();
  const groupId = randomUUID();
  const { error: nodeError } = await admin.from("process_nodes").insert([
    { id: splitNodeId, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "parallel_split", parallel_group_id: groupId, name: "Split", position: 1, config: {} },
    { id: waitNodeId, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "wait", name: "Wait branch", position: 2, config: { wait_rule: waitRule } },
    { id: approvalNodeId, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "approval", name: "Approval branch", position: 3, config: {} },
    { id: joinNodeId, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "parallel_join", parallel_group_id: groupId, name: "Join", position: 4, config: {} },
    { id: finalNodeId, workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, node_type: "human_task", name: "Finalize", position: 5, config: {} },
  ]);
  if (nodeError) throw new Error(nodeError.message);
  const outcomeId = randomUUID();
  const secondOutcomeId = randomUUID();
  const { error: edgeError } = await admin.from("process_edges").insert([
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: splitNodeId, target_node_id: waitNodeId, priority: 0, is_default: false, is_parallel: true },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: splitNodeId, target_node_id: approvalNodeId, priority: 1, is_default: false, is_parallel: true },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: waitNodeId, target_node_id: joinNodeId, priority: 0, is_default: true, is_parallel: false },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: approvalNodeId, target_node_id: joinNodeId, priority: 0, is_default: false, is_parallel: false, approval_outcome_id: outcomeId, approval_outcome_label: "Approve" },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: approvalNodeId, target_node_id: joinNodeId, priority: 1, is_default: false, is_parallel: false, approval_outcome_id: secondOutcomeId, approval_outcome_label: "Reject" },
    { workspace_id: DEMO_WORKSPACE_ID, process_template_id: templateId, source_node_id: joinNodeId, target_node_id: finalNodeId, priority: 0, is_default: true, is_parallel: false },
  ]);
  if (edgeError) throw new Error(edgeError.message);
  return { entity, recordId, templateId, waitNodeId, nextNodeId: finalNodeId, approvalNodeId, outcomeId };
}

async function startRun(fixture: Awaited<ReturnType<typeof createWaitFixture>>) {
  const client = await authenticatedClient();
  const { data, error } = await client.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: fixture.templateId,
    p_origin_entity_type_id: fixture.entity.id,
    p_origin_record_id: fixture.recordId,
  });
  if (error || typeof data !== "string") throw new Error(error?.message ?? "Unable to start wait run");
  return { client, runId: data };
}

async function stepsForRun(runId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("process_step_runs")
    .select("*")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", runId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function resumeDueWaitsAsService() {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.rpc("resume_due_process_waits_system", { p_limit: 100 });
  if (error) throw new Error(error.message);
  return data;
}

function localParts(timestamp: string, timeZone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

test.beforeAll(async () => cleanupStaleE2eData());
test.afterAll(async () => {
  for (const run of runs) await cleanupE2eRun(run);
});

test("snapshots duration and calendar wait rules, with no premature pending resume time", async () => {
  const hours = await createWaitFixture({
    run: createScenarioRun(),
    waitRule: { kind: "duration", amount: 6, unit: "hours" },
  });
  const { runId } = await startRun(hours);
  const hourSteps = await stepsForRun(runId);
  const wait = hourSteps.find((step) => step.source_node_id === hours.waitNodeId)!;
  const next = hourSteps.find((step) => step.source_node_id === hours.nextNodeId)!;
  expect(wait.status).toBe("active");
  expect(wait.resume_at).toBeTruthy();
  expect(next.status).toBe("pending");
  expect(next.resume_at).toBeNull();
  expect(Math.round((Date.parse(wait.resume_at) - Date.parse(wait.started_at)) / 3_600_000)).toBe(6);

  const calendar = await createWaitFixture({
    run: createScenarioRun(),
    waitRule: { kind: "duration", amount: 3, unit: "calendar_days", time_zone: "America/Toronto" },
  });
  const calendarRun = await startRun(calendar);
  const calendarWait = (await stepsForRun(calendarRun.runId)).find(
    (step) => step.source_node_id === calendar.waitNodeId,
  )!;
  const started = localParts(calendarWait.started_at, "America/Toronto");
  const resumed = localParts(calendarWait.resume_at, "America/Toronto");
  expect(resumed.hour).toBe(started.hour);
  expect(resumed.minute).toBe(started.minute);
  expect(calendarWait.resume_at).toMatch(/(Z|\+00:00)$/);
});

test("rejects direct scheduler execution, protects the route, and resumes a due wait once", async ({ request }) => {
  const fixture = await createWaitFixture({
    run: createScenarioRun(),
    waitRule: { kind: "weekdays", amount: 2, time_zone: "America/Toronto" },
  });
  const { client, runId } = await startRun(fixture);
  const before = (await stepsForRun(runId)).find((step) => step.source_node_id === fixture.waitNodeId)!;
  expect(
    (await client.rpc("resume_due_process_waits_system", { p_limit: 1 })).error?.message,
  ).toContain("permission denied");
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const anonymousClient = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  expect(
    (await anonymousClient.rpc("resume_due_process_waits_system", { p_limit: 1 })).error?.message,
  ).toContain("permission denied");

  expect((await request.post("/api/internal/process-waits")).status()).toBe(401);
  expect(
    (await request.post("/api/internal/process-waits", { headers: { Authorization: "Bearer wrong" } })).status(),
  ).toBe(401);

  loadE2eEnv();
  const secret = process.env.PROCESS_WAIT_SCHEDULER_SECRET;
  expect(secret).toBeTruthy();
  expect(
    (await request.post("/api/internal/process-waits", {
      headers: { Authorization: `Bearer ${secret}` },
    })).ok(),
  ).toBeTruthy();
  expect((await stepsForRun(runId)).find((step) => step.id === before.id)?.status).toBe("active");

  const admin = createSupabaseTestClient();
  await admin
    .from("process_step_runs")
    .update({ resume_at: new Date(Date.now() - 1_000).toISOString() })
    .eq("id", before.id);

  const ticks = await Promise.all(
    [0, 1].map(() =>
      request.post("/api/internal/process-waits", {
        headers: { Authorization: `Bearer ${secret}` },
      }),
    ),
  );
  expect(ticks.every((tick) => tick.ok())).toBeTruthy();
  const batches = await Promise.all(ticks.map((tick) => tick.json()));
  expect(batches.reduce((total, batch) => total + Number(batch.result?.resumed ?? 0), 0)).toBe(1);
  const after = await stepsForRun(runId);
  expect(after.find((step) => step.id === before.id)?.status).toBe("completed");
  expect(after.find((step) => step.source_node_id === fixture.nextNodeId)?.status).toBe("active");
  const noOp = await request.post("/api/internal/process-waits", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(noOp.ok()).toBeTruthy();
  expect((await noOp.json()).result.resumed).toBe(0);
  expect((await stepsForRun(runId)).filter((step) => step.source_node_id === fixture.nextNodeId && step.status === "active")).toHaveLength(1);
});

test("waits preserve branch tokens and resolve their join only after sibling approval arrives", async () => {
  const fixture = await createWaitFixture({
    run: createScenarioRun(),
    waitRule: { kind: "duration", amount: 1, unit: "hours" },
    withParallel: true,
  });
  const { client, runId } = await startRun(fixture);
  const initial = await stepsForRun(runId);
  const wait = initial.find((step) => step.source_node_id === fixture.waitNodeId)!;
  const approval = initial.find((step) => step.source_node_id === fixture.approvalNodeId)!;
  expect(wait.parallel_branch_token).toBeTruthy();
  expect(approval.parallel_branch_token).toBeTruthy();
  expect(
    (
      await client.rpc("decide_process_approval_authorized", {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_run_id: runId,
        p_step_run_id: approval.id,
        p_outcome_id: fixture.outcomeId,
      })
    ).error,
  ).toBeNull();

  const admin = createSupabaseTestClient();
  await admin.from("process_step_runs").update({ resume_at: new Date(Date.now() - 1_000).toISOString() }).eq("id", wait.id);
  await resumeDueWaitsAsService();
  const after = await stepsForRun(runId);
  expect(after.find((step) => step.source_node_id === fixture.waitNodeId)?.status).toBe("completed");
  expect(after.find((step) => step.source_node_id === fixture.nextNodeId)?.status).toBe("active");
});
