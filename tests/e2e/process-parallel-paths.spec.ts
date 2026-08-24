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
const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const E2E_RUNNER_PASSWORD = "E2E-runner-password-2026";

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
});

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

  if (error) {
    throw new Error(`Unable to sign in as E2E runner: ${error.message}`);
  }

  return client;
}

type ParallelFixture = {
  entity: TestEntity;
  recordId: string;
  templateId: string;
  nodeIds: Record<string, string>;
};

async function createParallelFixture({
  run,
  withConditionalBranch = false,
}: {
  run: TestRun;
  withConditionalBranch?: boolean;
}): Promise<ParallelFixture> {
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
    ...(withConditionalBranch
      ? [{ slug: "needs_revisions", name: "Needs revisions", type: "boolean" as const }]
      : []),
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: {
      name: "Parallel report",
      ...(withConditionalBranch ? { needs_revisions: true } : {}),
    },
  });
  const templateId = randomUUID();
  const parallelGroupId = randomUUID();
  const nodeIds = Object.fromEntries(
    ["draft", "split", "editorial", "legal", "revisions", "publish", "join", "finalize"].map(
      (key) => [key, randomUUID()],
    ),
  ) as Record<string, string>;

  const nodes = [
    { key: "draft", name: "Draft", type: "human_task", position: 1 },
    { key: "split", name: "Parallel reviews", type: "parallel_split", position: 2 },
    { key: "editorial", name: "Editorial review", type: "human_task", position: 3 },
    { key: "legal", name: "Legal review", type: "human_task", position: 4 },
    ...(withConditionalBranch
      ? [
          { key: "revisions", name: "Revise", type: "human_task", position: 5 },
          { key: "publish", name: "Publish as-is", type: "human_task", position: 6 },
          { key: "join", name: "Join reviews", type: "parallel_join", position: 7 },
          { key: "finalize", name: "Finalize", type: "human_task", position: 8 },
        ]
      : [
          { key: "join", name: "Join reviews", type: "parallel_join", position: 5 },
          { key: "finalize", name: "Finalize", type: "human_task", position: 6 },
        ]),
  ];

  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Parallel review`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await admin.from("process_nodes").insert(
    nodes.map((node) => ({
      id: nodeIds[node.key],
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: node.type,
      parallel_group_id: node.type === "parallel_split" || node.type === "parallel_join" ? parallelGroupId : null,
      name: node.name,
      position: node.position,
      config: {},
    })),
  );
  if (nodeError) throw new Error(nodeError.message);

  const edges = [
    ["draft", "split", true, false, null],
    ["split", "editorial", false, true, null],
    ["split", "legal", false, true, null],
    ["legal", "join", true, false, null],
    ["join", "finalize", true, false, null],
    ...(withConditionalBranch
      ? [
          [
            "editorial",
            "revisions",
            false,
            false,
            [
              {
                sourceFieldDefinitionId: entity.fields.needs_revisions.id,
                operator: "equals",
                value: true,
              },
            ],
          ],
          ["editorial", "publish", true, false, null],
          ["revisions", "join", true, false, null],
          ["publish", "join", true, false, null],
        ]
      : [["editorial", "join", true, false, null]]),
  ] as Array<[string, string, boolean, boolean, unknown]>;
  const { error: edgeError } = await admin.from("process_edges").insert(
    edges.map(([source, target, isDefault, isParallel, conditionConfig], priority) => ({
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      source_node_id: nodeIds[source],
      target_node_id: nodeIds[target],
      priority,
      is_default: isDefault,
      is_parallel: isParallel,
      condition_config: conditionConfig,
    })),
  );
  if (edgeError) throw new Error(edgeError.message);

  return { entity, recordId, templateId, nodeIds };
}

async function startRun(client: Awaited<ReturnType<typeof authenticatedClient>>, fixture: ParallelFixture) {
  const { data, error } = await client.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: fixture.templateId,
    p_origin_entity_type_id: fixture.entity.id,
    p_origin_record_id: fixture.recordId,
  });
  if (error || typeof data !== "string") throw new Error(error?.message ?? "Run was not created");
  return data;
}

async function runSteps(runId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("process_step_runs")
    .select("*")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", runId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

test("parallel split activates both branches, blocks direct system completion, and joins once", async () => {
  const fixture = await createParallelFixture({ run: createScenarioRun() });
  const client = await authenticatedClient();
  const runId = await startRun(client, fixture);
  const initial = await runSteps(runId);
  const initialByNode = new Map(initial.map((step) => [step.source_node_id, step]));
  expect(initialByNode.get(fixture.nodeIds.draft)?.status).toBe("active");

  const draft = initialByNode.get(fixture.nodeIds.draft)!;
  expect(
    (
      await client.rpc("complete_process_step_run_authorized", {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_run_id: runId,
        p_step_run_id: initialByNode.get(fixture.nodeIds.split)?.id,
      })
    ).error?.message,
  ).toContain("System process steps advance automatically");

  expect(
    (
      await client.rpc("complete_process_step_run_authorized", {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_run_id: runId,
        p_step_run_id: draft.id,
      })
    ).error,
  ).toBeNull();

  const afterSplit = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  expect(afterSplit.get(fixture.nodeIds.split)?.status).toBe("completed");
  expect(afterSplit.get(fixture.nodeIds.editorial)?.status).toBe("active");
  expect(afterSplit.get(fixture.nodeIds.legal)?.status).toBe("active");
  expect(afterSplit.get(fixture.nodeIds.join)?.status).toBe("pending");

  const first = await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: afterSplit.get(fixture.nodeIds.editorial)?.id,
  });
  expect(first.error).toBeNull();
  const mid = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  expect(mid.get(fixture.nodeIds.join)?.status).toBe("pending");
  expect(mid.get(fixture.nodeIds.legal)?.status).toBe("active");

  const second = await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: mid.get(fixture.nodeIds.legal)?.id,
  });
  expect(second.error).toBeNull();
  const afterJoin = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  expect(afterJoin.get(fixture.nodeIds.join)?.status).toBe("completed");
  expect(afterJoin.get(fixture.nodeIds.finalize)?.status).toBe("active");

  const admin = createSupabaseTestClient();
  const { data: obligations, error } = await admin
    .from("process_parallel_join_obligations")
    .select("arrived_at")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", runId);
  expect(error).toBeNull();
  expect(obligations).toHaveLength(2);
  expect(obligations?.every((obligation) => obligation.arrived_at)).toBe(true);
});

test("concurrent branch completions retain both arrivals and activate downstream once", async () => {
  const fixture = await createParallelFixture({ run: createScenarioRun() });
  const client = await authenticatedClient();
  const runId = await startRun(client, fixture);
  let steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.draft)?.id,
  });
  steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  const [editorial, legal] = await Promise.all(
    [fixture.nodeIds.editorial, fixture.nodeIds.legal].map((nodeId) =>
      client.rpc("complete_process_step_run_authorized", {
        p_workspace_id: DEMO_WORKSPACE_ID,
        p_process_run_id: runId,
        p_step_run_id: steps.get(nodeId)?.id,
      }),
    ),
  );
  expect(editorial.error).toBeNull();
  expect(legal.error).toBeNull();
  const completed = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  expect(completed.get(fixture.nodeIds.join)?.status).toBe("completed");
  expect(completed.get(fixture.nodeIds.finalize)?.status).toBe("active");
  expect(completed.get(fixture.nodeIds.finalize)?.started_at).toBeTruthy();
});

test("a conditional branch keeps one obligation while its skipped alternative never blocks the join", async () => {
  const fixture = await createParallelFixture({
    run: createScenarioRun(),
    withConditionalBranch: true,
  });
  const client = await authenticatedClient();
  const runId = await startRun(client, fixture);
  let steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.draft)?.id,
  });
  steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.editorial)?.id,
  });
  steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  expect(steps.get(fixture.nodeIds.revisions)?.status).toBe("active");
  expect(steps.get(fixture.nodeIds.publish)?.status).toBe("skipped");
  expect(steps.get(fixture.nodeIds.legal)?.status).toBe("active");
  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.revisions)?.id,
  });
  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.legal)?.id,
  });
  steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  expect(steps.get(fixture.nodeIds.join)?.status).toBe("completed");
  expect(steps.get(fixture.nodeIds.finalize)?.status).toBe("active");
});

test("parallel branches preserve their own assignment and due snapshots while My Work waits at the join", async ({
  page,
}) => {
  const fixture = await createParallelFixture({ run: createScenarioRun() });
  const client = await authenticatedClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  expect(user).toBeTruthy();
  const admin = createSupabaseTestClient();

  for (const [nodeId, amount] of [
    [fixture.nodeIds.editorial, 2],
    [fixture.nodeIds.legal, 4],
    [fixture.nodeIds.finalize, 1],
  ] as const) {
    const { error } = await admin
      .from("process_nodes")
      .update({
        assignee_user_id: user!.id,
        config: { due_rule: { amount, unit: "hours" } },
      })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", nodeId);
    expect(error).toBeNull();
  }

  const runId = await startRun(client, fixture);
  let steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.draft)?.id,
  });
  steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  expect(steps.get(fixture.nodeIds.editorial)?.due_at).toBeTruthy();
  expect(steps.get(fixture.nodeIds.legal)?.due_at).toBeTruthy();
  expect(steps.get(fixture.nodeIds.finalize)?.due_at).toBeNull();

  await page.goto("/my-work");
  const readyNow = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Ready now" }),
  });
  await expect(readyNow.getByText("Editorial review")).toBeVisible();
  await expect(readyNow.getByText("Legal review")).toBeVisible();
  await expect(page.getByText("Finalize", { exact: true })).not.toBeVisible();

  // Existing runs must never consult modified live template routes/config.
  const { error: changedTemplateError } = await admin
    .from("process_edges")
    .delete()
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_template_id", fixture.templateId)
    .eq("source_node_id", fixture.nodeIds.split);
  expect(changedTemplateError).toBeNull();

  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.editorial)?.id,
  });
  steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.legal)?.id,
  });
  steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  expect(steps.get(fixture.nodeIds.finalize)?.status).toBe("active");
  expect(steps.get(fixture.nodeIds.finalize)?.due_at).toBeTruthy();

  await page.reload();
  await expect(readyNow.getByText("Finalize", { exact: true })).toBeVisible();
});

test("parallel join obligations are workspace-scoped select-only runtime state", async () => {
  const fixture = await createParallelFixture({ run: createScenarioRun() });
  const client = await authenticatedClient();
  const runId = await startRun(client, fixture);
  const steps = new Map((await runSteps(runId)).map((step) => [step.source_node_id, step]));
  await client.rpc("complete_process_step_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_run_id: runId,
    p_step_run_id: steps.get(fixture.nodeIds.draft)?.id,
  });
  const admin = createSupabaseTestClient();
  const { data: obligations } = await admin
    .from("process_parallel_join_obligations")
    .select("*")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("process_run_id", runId);
  expect(obligations).toHaveLength(2);

  const rawInsert = await client.from("process_parallel_join_obligations").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    process_run_id: runId,
    join_step_run_id: obligations![0].join_step_run_id,
    parallel_group_id: obligations![0].parallel_group_id,
    branch_token: randomUUID(),
  });
  expect(rawInsert.error?.message).toMatch(/permission denied|not allowed/i);

  const workspaceMove = await admin
    .from("process_parallel_join_obligations")
    .update({ workspace_id: randomUUID() })
    .eq("id", obligations![0].id);
  expect(workspaceMove.error?.message).toMatch(/workspace_id.*immutable|immutable.*workspace_id/i);
});

test("system nodes accept JSON null config but reject due rules and assignees", async () => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const client = await authenticatedClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  expect(user).toBeTruthy();
  const groupId = randomUUID();
  const steps: Array<{
    client_key: string;
    node_id: null;
    node_type: string;
    parallel_group_id: string | null;
    name: string;
    assignee_user_id: string | null;
    due_rule: unknown;
    routes: Array<{
      target_client_key: string;
      is_default: boolean;
      is_parallel: boolean;
      conditions: unknown[];
    }>;
  }> = [
    {
      client_key: "draft",
      node_id: null,
      node_type: "human_task",
      parallel_group_id: null,
      name: "Draft",
      assignee_user_id: null,
      due_rule: null,
      routes: [{ target_client_key: "split", is_default: true, is_parallel: false, conditions: [] }],
    },
    {
      client_key: "split",
      node_id: null,
      node_type: "parallel_split",
      parallel_group_id: groupId,
      name: "Split",
      assignee_user_id: null,
      due_rule: null,
      routes: [
        { target_client_key: "first", is_default: false, is_parallel: true, conditions: [] },
        { target_client_key: "second", is_default: false, is_parallel: true, conditions: [] },
      ],
    },
    {
      client_key: "first",
      node_id: null,
      node_type: "human_task",
      parallel_group_id: null,
      name: "First",
      assignee_user_id: null,
      due_rule: null,
      routes: [{ target_client_key: "join", is_default: true, is_parallel: false, conditions: [] }],
    },
    {
      client_key: "second",
      node_id: null,
      node_type: "human_task",
      parallel_group_id: null,
      name: "Second",
      assignee_user_id: null,
      due_rule: null,
      routes: [{ target_client_key: "join", is_default: true, is_parallel: false, conditions: [] }],
    },
    {
      client_key: "join",
      node_id: null,
      node_type: "parallel_join",
      parallel_group_id: groupId,
      name: "Join",
      assignee_user_id: null,
      due_rule: null,
      routes: [{ target_client_key: "finish", is_default: true, is_parallel: false, conditions: [] }],
    },
    {
      client_key: "finish",
      node_id: null,
      node_type: "human_task",
      parallel_group_id: null,
      name: "Finish",
      assignee_user_id: null,
      due_rule: null,
      routes: [],
    },
  ];
  const save = (name: string, pSteps: unknown) =>
    client.rpc("save_process_template_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: null,
      p_name: name,
      p_description: null,
      p_applies_to_entity_type_id: entity.id,
      p_steps: pSteps,
    });

  const valid = await save(`${run.label} Null system config`, steps);
  expect(valid.error).toBeNull();

  const configuredDueRule = structuredClone(steps);
  configuredDueRule[1].due_rule = { amount: 1, unit: "hours" };
  const dueRuleResult = await save(`${run.label} Split due rule`, configuredDueRule);
  expect(dueRuleResult.error?.message).toContain("Parallel system nodes cannot have an assignee or due rule");

  const configuredAssignee = structuredClone(steps);
  configuredAssignee[4].assignee_user_id = user!.id;
  const assigneeResult = await save(`${run.label} Join assignee`, configuredAssignee);
  expect(assigneeResult.error?.message).toContain("Parallel system nodes cannot have an assignee or due rule");
});

test("malformed parallel template configuration is rejected atomically by the canonical save RPC", async () => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const client = await authenticatedClient();
  const templateName = `${run.label} Invalid parallel template`;
  const groupId = randomUUID();
  const result = await client.rpc("save_process_template_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: null,
    p_name: templateName,
    p_description: null,
    p_applies_to_entity_type_id: entity.id,
    p_steps: [
      {
        client_key: "draft",
        node_id: null,
        node_type: "human_task",
        parallel_group_id: null,
        name: "Draft",
        assignee_user_id: null,
        due_rule: null,
        routes: [
          {
            target_client_key: "split",
            is_default: true,
            is_parallel: false,
            conditions: [],
          },
        ],
      },
      {
        client_key: "split",
        node_id: null,
        node_type: "parallel_split",
        parallel_group_id: groupId,
        name: "Broken split",
        assignee_user_id: null,
        due_rule: null,
        routes: [
          {
            target_client_key: "first",
            is_default: false,
            is_parallel: true,
            conditions: [],
          },
          {
            target_client_key: "second",
            is_default: false,
            is_parallel: true,
            conditions: [],
          },
        ],
      },
      {
        client_key: "first",
        node_id: null,
        node_type: "human_task",
        parallel_group_id: null,
        name: "First branch",
        assignee_user_id: null,
        due_rule: null,
        routes: [],
      },
      {
        client_key: "second",
        node_id: null,
        node_type: "human_task",
        parallel_group_id: null,
        name: "Second branch",
        assignee_user_id: null,
        due_rule: null,
        routes: [],
      },
    ],
  });
  expect(result.error?.message).toContain("exactly one split and one join");
  const { data: templates, error } = await admin
    .from("process_templates")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("name", templateName);
  expect(error).toBeNull();
  expect(templates).toEqual([]);
});
