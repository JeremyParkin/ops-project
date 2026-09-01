// DB/RPC-level regression coverage for Phase 8F.5's corrective migration
// 0079. Before 0079, save_process_template_authorized failed on ANY
// template containing an external_event_wait step with "Process step
// configuration is invalid" -- 0077's external_event_wait branch merged an
// extra, never-valid `config` key into the step it disguised as
// node_type = 'human_task' before delegating to the deeper wrapper chain
// (0043/0039/0037/0035), none of which has ever had an allowlist entry for
// `config` (it has always been a process_nodes TABLE COLUMN set by this
// same function's own subsequent UPDATE, never part of the incoming step
// JSON contract -- every sibling disguise-as-human_task call in that chain
// merges only { node_type: 'human_task' }).
//
// The existing E2E fixture (tests/e2e/process-external-event-waits.spec.ts)
// never caught this because it inserts external_event_wait nodes directly
// into process_nodes via the admin client, bypassing
// save_process_template_authorized entirely -- only a real save through
// that RPC exercises this path. This test calls the RPC directly (as a
// real, capability-checked authenticated member would) with the exact
// step shape lib/domain/process-repository.ts's saveProcessTemplate sends
// over the wire for every step regardless of node type (wait_rule/
// condition_wait_rule/action_config always present, null when irrelevant).
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import {
  cleanupE2eRun,
  createEntity,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  getE2eWorkspaceAdministratorRoleId,
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

async function authenticatedBuilder() {
  const admin = createSupabaseTestClient();
  const password = `E2E-process-save-${randomUUID()}!`;
  const email = `e2e-process-save-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);

  // The built-in "Workspace administrator" role -- documented (0045) as
  // full workspace access, which includes automation.manage, the exact
  // capability save_process_template_authorized requires.
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
  return client;
}

describe("save_process_template_authorized: external_event_wait", () => {
  it("saves a template containing an external_event_wait step through the real authorized RPC path", async () => {
    const run = scenarioRun();
    const admin = createSupabaseTestClient();
    const entity = await createEntity(admin, run, "Save Regression Target", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const builder = await authenticatedBuilder();

    const humanTaskKey = "step-human-task";
    const waitKey = "step-external-event-wait";

    const { data: templateId, error } = await builder.rpc("save_process_template_authorized", {
      p_workspace_id: DEMO_WORKSPACE_ID,
      p_process_template_id: null,
      p_name: `${run.label} Save Regression Template`,
      p_description: null,
      p_applies_to_entity_type_id: entity.id,
      p_steps: [
        {
          client_key: humanTaskKey,
          node_id: "",
          node_type: "human_task",
          parallel_group_id: null,
          name: "Prepare vendor request",
          assignee_user_id: "",
          due_rule: null,
          wait_rule: null,
          condition_wait_rule: null,
          action_config: null,
          routes: [
            {
              target_client_key: waitKey,
              is_default: true,
              is_parallel: false,
              approval_outcome_id: null,
              approval_outcome_label: null,
              conditions: [],
            },
          ],
        },
        {
          client_key: waitKey,
          node_id: "",
          node_type: "external_event_wait",
          parallel_group_id: null,
          name: "Wait for external event",
          assignee_user_id: "",
          due_rule: null,
          wait_rule: null,
          condition_wait_rule: null,
          action_config: null,
          routes: [],
        },
      ],
    });

    // Before migration 0079, this call failed with:
    //   "Process step configuration is invalid"
    // because of the stray `config` key described above.
    expect(error).toBeNull();
    expect(typeof templateId).toBe("string");

    const { data: nodes, error: nodesError } = await admin
      .from("process_nodes")
      .select("id, node_type, name, position, config, assignee_user_id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", templateId)
      .order("position", { ascending: true });
    expect(nodesError).toBeNull();
    expect(nodes).toHaveLength(2);
    expect(nodes?.[0]).toMatchObject({ node_type: "human_task", name: "Prepare vendor request" });
    expect(nodes?.[1]).toMatchObject({
      node_type: "external_event_wait",
      name: "Wait for external event",
      config: {},
      assignee_user_id: null,
    });

    const { data: edges, error: edgesError } = await admin
      .from("process_edges")
      .select("source_node_id, target_node_id, is_default")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", templateId);
    expect(edgesError).toBeNull();
    expect(edges).toHaveLength(1);
    expect(edges?.[0]).toMatchObject({
      source_node_id: nodes?.[0].id,
      target_node_id: nodes?.[1].id,
      is_default: true,
    });
  });
});
