import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";

import { apiKeyPreview, generateApiKey, hashApiKey } from "@/lib/domain/api-key-signing";
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
const apiKeyIds: string[] = [];
let apiContext: APIRequestContext;

const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const E2E_RUNNER_PASSWORD = "E2E-runner-password-2026";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function authenticatedClient() {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({
    email: E2E_RUNNER_EMAIL,
    password: E2E_RUNNER_PASSWORD,
  });
  if (error) throw new Error(`Unable to sign in as E2E runner: ${error.message}`);
  return client;
}

async function createExternalWaitTemplate(entity: TestEntity, run: TestRun) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const waitNodeId = randomUUID();
  const nextNodeId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} External event wait`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);
  const { error: nodeError } = await admin.from("process_nodes").insert([
    {
      id: waitNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "external_event_wait",
      name: "Wait for vendor callback",
      position: 1,
      config: {},
    },
    {
      id: nextNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name: "Review vendor callback",
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
    condition_config: null,
    is_default: true,
    is_parallel: false,
  });
  if (edgeError) throw new Error(edgeError.message);
  return { templateId, waitNodeId, nextNodeId };
}

async function createExternalWaitActionTemplate({
  origin,
  followUp,
  run,
}: {
  origin: TestEntity;
  followUp: TestEntity;
  run: TestRun;
}) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const waitNodeId = randomUUID();
  const actionNodeId = randomUUID();
  const nextNodeId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} External event wait action`,
    applies_to_entity_type_id: origin.id,
  });
  if (templateError) throw new Error(templateError.message);
  const { error: nodeError } = await admin.from("process_nodes").insert([
    {
      id: waitNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "external_event_wait",
      name: "Wait for vendor callback",
      position: 1,
      config: {},
    },
    {
      id: actionNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "action",
      name: "Create follow-up",
      position: 2,
      config: {
        action_config: {
          action_type: "create_record",
          action_target_entity_type_id: followUp.id,
          related_field_definition_id: null,
          process_template_id: null,
          field_mappings: [
            {
              target_field_definition_id: followUp.fields.summary.id,
              source: { type: "source_field", source_field_definition_id: origin.fields.name.id },
            },
          ],
        },
      },
    },
    {
      id: nextNodeId,
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name: "Review follow-up",
      position: 3,
      config: {},
    },
  ]);
  if (nodeError) throw new Error(nodeError.message);
  const { error: edgeError } = await admin.from("process_edges").insert([
    {
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      source_node_id: waitNodeId,
      target_node_id: actionNodeId,
      priority: 0,
      condition_config: null,
      is_default: true,
      is_parallel: false,
    },
    {
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      source_node_id: actionNodeId,
      target_node_id: nextNodeId,
      priority: 0,
      condition_config: null,
      is_default: true,
      is_parallel: false,
    },
  ]);
  if (edgeError) throw new Error(edgeError.message);
  return { templateId, waitNodeId, actionNodeId, nextNodeId };
}

async function startRun(entity: TestEntity, recordId: string, templateId: string) {
  const client = await authenticatedClient();
  const { data, error } = await client.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: templateId,
    p_origin_entity_type_id: entity.id,
    p_origin_record_id: recordId,
  });
  if (error || typeof data !== "string") throw new Error(error?.message ?? "Unable to start process run.");
  return data;
}

async function stepsForRun(processRunId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("process_step_runs")
    .select("*")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", processRunId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function createScopedKey(scope: "records:read" | "process_waits:complete") {
  const admin = createSupabaseTestClient();
  const rawKey = generateApiKey();
  const id = randomUUID();
  const { error } = await admin.from("api_keys").insert({
    id,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `E2E external waits ${randomUUID()}`,
    key_hash: hashApiKey(rawKey),
    key_preview: apiKeyPreview(rawKey),
    scopes: [scope],
  });
  if (error) throw new Error(error.message);
  const { error: rateLimitError } = await admin.from("api_key_rate_limits").insert({ api_key_id: id });
  if (rateLimitError) throw new Error(rateLimitError.message);
  apiKeyIds.push(id);
  return rawKey;
}

async function postEvent(externalWaitId: string, rawKey: string, idempotencyKey: string) {
  return apiContext.post(`/api/v1/process-waits/external/${externalWaitId}/events`, {
    headers: {
      authorization: `Bearer ${rawKey}`,
      "Idempotency-Key": idempotencyKey,
    },
  });
}

test.beforeAll(async () => {
  await cleanupStaleE2eData();
  apiContext = await playwrightRequest.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100" });
});

test.afterAll(async () => {
  await apiContext.dispose();
  const admin = createSupabaseTestClient();
  if (apiKeyIds.length > 0) {
    const { error } = await admin.from("api_keys").delete().in("id", apiKeyIds);
    if (error) throw new Error(error.message);
  }
  for (const run of runs) await cleanupE2eRun(run);
});

test("external event wait accepts one event, supports duplicate retries, and rejects a new key after completion", async () => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Vendor Task", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Callback target" } });
  const template = await createExternalWaitTemplate(entity, run);
  const processRunId = await startRun(entity, recordId, template.templateId);
  const initialSteps = await stepsForRun(processRunId);
  const waitStep = initialSteps.find((step) => step.source_node_id === template.waitNodeId);
  expect(waitStep?.status).toBe("active");
  expect(waitStep?.external_wait_id).toMatch(/[0-9a-f-]{36}/);

  const recordsKey = await createScopedKey("records:read");
  const denied = await postEvent(waitStep!.external_wait_id, recordsKey, randomUUID());
  expect(denied.status()).toBe(403);
  expect((await stepsForRun(processRunId)).find((step) => step.id === waitStep!.id)?.status).toBe("active");

  const eventKey = await createScopedKey("process_waits:complete");
  const idempotencyKey = randomUUID();
  const accepted = await postEvent(waitStep!.external_wait_id, eventKey, idempotencyKey);
  expect(accepted.status()).toBe(200);
  await expect(accepted.json()).resolves.toEqual({ status: "accepted" });

  const duplicate = await postEvent(waitStep!.external_wait_id, eventKey, idempotencyKey);
  expect(duplicate.status()).toBe(200);
  await expect(duplicate.json()).resolves.toEqual({ status: "accepted" });

  const conflict = await postEvent(waitStep!.external_wait_id, eventKey, randomUUID());
  expect(conflict.status()).toBe(409);

  const resolvedSteps = await stepsForRun(processRunId);
  expect(resolvedSteps.find((step) => step.id === waitStep!.id)?.status).toBe("completed");
  expect(resolvedSteps.find((step) => step.source_node_id === template.nextNodeId)?.status).toBe("active");

  const { data: events, error } = await admin
    .from("process_external_wait_events")
    .select("id, idempotency_key_hash")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("external_wait_id", waitStep!.external_wait_id);
  expect(error).toBeNull();
  expect(events).toHaveLength(1);
  expect(events?.[0]?.idempotency_key_hash).toBe(sha256(idempotencyKey));
});

test("concurrent requests converge on one accepted event and never advance the wait twice", async () => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Concurrent Vendor Task", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Callback target" } });
  const template = await createExternalWaitTemplate(entity, run);
  const processRunId = await startRun(entity, recordId, template.templateId);
  const waitStep = (await stepsForRun(processRunId)).find((step) => step.source_node_id === template.waitNodeId)!;
  const eventKey = await createScopedKey("process_waits:complete");
  const sharedIdempotencyKey = randomUUID();

  const sameKeyResults = await Promise.all([
    postEvent(waitStep.external_wait_id, eventKey, sharedIdempotencyKey),
    postEvent(waitStep.external_wait_id, eventKey, sharedIdempotencyKey),
  ]);
  expect(sameKeyResults.map((response) => response.status()).sort()).toEqual([200, 200]);

  const completedReplayResults = await Promise.all([
    postEvent(waitStep.external_wait_id, eventKey, randomUUID()),
    postEvent(waitStep.external_wait_id, eventKey, randomUUID()),
  ]);
  expect(completedReplayResults.map((response) => response.status()).sort()).toEqual([409, 409]);

  const { data: events, error } = await admin
    .from("process_external_wait_events")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("external_wait_id", waitStep.external_wait_id);
  expect(error).toBeNull();
  expect(events).toHaveLength(1);
  expect((await stepsForRun(processRunId)).filter((step) => step.id === waitStep.id && step.status === "completed")).toHaveLength(1);
});

test("different idempotency keys racing an active wait produce one accept and one conflict", async () => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Racing Vendor Task", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Callback target" } });
  const template = await createExternalWaitTemplate(entity, run);
  const processRunId = await startRun(entity, recordId, template.templateId);
  const waitStep = (await stepsForRun(processRunId)).find((step) => step.source_node_id === template.waitNodeId)!;
  const eventKey = await createScopedKey("process_waits:complete");

  const results = await Promise.all([
    postEvent(waitStep.external_wait_id, eventKey, randomUUID()),
    postEvent(waitStep.external_wait_id, eventKey, randomUUID()),
  ]);
  expect(results.map((response) => response.status()).sort()).toEqual([200, 409]);

  const { data: events, error } = await admin
    .from("process_external_wait_events")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("external_wait_id", waitStep.external_wait_id);
  expect(error).toBeNull();
  expect(events).toHaveLength(1);
  expect((await stepsForRun(processRunId)).filter((step) => step.id === waitStep.id && step.status === "completed")).toHaveLength(1);
});

test("duplicate accepted HTTP retry drains a downstream action if the first request died after DB acceptance", async () => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();
  const origin = await createEntity(admin, run, "Recoverable Callback", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const followUp = await createEntity(admin, run, "Callback Follow Up", [
    { slug: "summary", name: "Summary", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({ entity: origin, valuesBySlug: { name: "Action drain source" } });
  const template = await createExternalWaitActionTemplate({ origin, followUp, run });
  const processRunId = await startRun(origin, recordId, template.templateId);
  const waitStep = (await stepsForRun(processRunId)).find((step) => step.source_node_id === template.waitNodeId)!;
  const eventKey = await createScopedKey("process_waits:complete");
  const idempotencyKey = randomUUID();

  const { error: directAcceptError } = await admin.rpc("receive_external_process_wait_event_for_api_key", {
    p_key_hash: hashApiKey(eventKey),
    p_external_wait_id: waitStep.external_wait_id,
    p_idempotency_key_hash: sha256(idempotencyKey),
  });
  expect(directAcceptError).toBeNull();

  const afterDirectAccept = await stepsForRun(processRunId);
  expect(afterDirectAccept.find((step) => step.id === waitStep.id)?.status).toBe("completed");
  expect(afterDirectAccept.find((step) => step.source_node_id === template.actionNodeId)?.status).toBe("active");

  const duplicate = await postEvent(waitStep.external_wait_id, eventKey, idempotencyKey);
  expect(duplicate.status()).toBe(200);
  await expect(duplicate.json()).resolves.toEqual({ status: "accepted" });

  const afterRetry = await stepsForRun(processRunId);
  expect(afterRetry.find((step) => step.source_node_id === template.actionNodeId)?.status).toBe("completed");
  expect(afterRetry.find((step) => step.source_node_id === template.nextNodeId)?.status).toBe("active");

  const { data: createdRecords, error } = await admin
    .from("entity_records")
    .select("values, originating_process_step_run_id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", followUp.id);
  expect(error).toBeNull();
  expect(createdRecords).toHaveLength(1);
  expect(createdRecords?.[0]?.values?.[followUp.fields.summary.key]).toBe("Action drain source");
  expect(createdRecords?.[0]?.originating_process_step_run_id).toBeTruthy();
});
