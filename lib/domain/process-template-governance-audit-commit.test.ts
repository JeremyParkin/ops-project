// Live DB verification for Phase 13.2B3b. Process Template governance is
// captured by the outer authorized RPCs, so graph row churn remains one event.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

const workspaces: string[] = [];
const users: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  for (const workspaceId of workspaces) await admin.from("workspaces").delete().eq("id", workspaceId);
  for (const userId of users) await admin.auth.admin.deleteUser(userId);
}, 30_000);

async function memberClient(workspaceId: string, capabilities: string[]): Promise<SupabaseClient> {
  const admin = createSupabaseTestClient();
  const password = `ProcessGovernance-${randomUUID()}!`;
  const email = `e2e-process-governance-${randomUUID()}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? "Unable to create test user");
  users.push(created.data.user.id);
  const roleId = randomUUID();
  const setup = [await admin.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: `Process role ${roleId.slice(0, 8)}` })];
  for (const capability of capabilities) {
    setup.push(await admin.from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability }));
  }
  setup.push(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: created.data.user.id, role_id: roleId }));
  for (const result of setup) if (result.error) throw new Error(result.error.message);
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(signedIn.error.message);
  return client;
}

async function events(workspaceId: string) {
  const result = await createSupabaseTestClient()
    .from("governance_audit_events")
    .select("event_type, subject_id, subject_name_snapshot, parent_entity_type_id, parent_entity_type_name_snapshot, changes")
    .eq("workspace_id", workspaceId)
    .eq("subject_kind", "process_template")
    .order("created_at", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

function steps(firstName: string, secondName: string, firstId = "", secondId = "") {
  return [
    {
      client_key: "first",
      node_id: firstId,
      node_type: "human_task",
      parallel_group_id: null,
      name: firstName,
      assignee_user_id: "",
      due_rule: null,
      wait_rule: null,
      condition_wait_rule: null,
      action_config: null,
      routes: [{ target_client_key: "second", is_default: true, is_parallel: false, approval_outcome_id: null, approval_outcome_label: null, conditions: [] }],
    },
    {
      client_key: "second",
      node_id: secondId,
      node_type: "human_task",
      parallel_group_id: null,
      name: secondName,
      assignee_user_id: "",
      due_rule: null,
      wait_rule: null,
      condition_wait_rule: null,
      action_config: null,
      routes: [],
    },
  ];
}

describe("Process Template governance audit", () => {
  it("captures one event per save and distinct lifecycle transitions", async () => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    workspaces.push(workspaceId);
    expect((await admin.from("workspaces").insert({ id: workspaceId, name: "Process governance" })).error).toBeNull();
    const entityTypeId = randomUUID();
    expect((await admin.from("entity_types").insert({ id: entityTypeId, workspace_id: workspaceId, name: "Requests", slug: `requests-${entityTypeId.slice(0, 8)}` })).error).toBeNull();
    const builder = await memberClient(workspaceId, ["automation.manage"]);

    const created = await builder.rpc("save_process_template_authorized", {
      p_workspace_id: workspaceId, p_process_template_id: null, p_name: "Request approval",
      p_description: "Initial process", p_applies_to_entity_type_id: entityTypeId,
      p_steps: steps("Review", "Approve"),
    });
    expect(created.error).toBeNull();
    const templateId = created.data as string;
    let audit = await events(workspaceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event_type: "process_template_created", subject_id: templateId, subject_name_snapshot: "Request approval", parent_entity_type_id: entityTypeId, parent_entity_type_name_snapshot: "Requests" });
    expect(audit[0].changes.new.nodes).toHaveLength(2);
    expect(audit[0].changes.new.routes).toHaveLength(1);

    const nodes = await admin.from("process_nodes").select("id").eq("workspace_id", workspaceId).eq("process_template_id", templateId).order("position");
    expect(nodes.error).toBeNull();
    const firstId = nodes.data?.[0]?.id as string;
    const secondId = nodes.data?.[1]?.id as string;
    expect((await builder.rpc("save_process_template_authorized", {
      p_workspace_id: workspaceId, p_process_template_id: templateId, p_name: "Request approval v2",
      p_description: "Updated process", p_applies_to_entity_type_id: entityTypeId,
      p_steps: steps("Review request", "Approve request", firstId, secondId),
    })).error).toBeNull();
    audit = await events(workspaceId);
    expect(audit).toHaveLength(2);
    expect(audit[1].event_type).toBe("process_template_updated");
    expect(audit[1].changes.old.name).toBe("Request approval");
    expect(audit[1].changes.new.nodes).toHaveLength(2);

    expect((await builder.rpc("save_process_template_authorized", {
      p_workspace_id: workspaceId, p_process_template_id: templateId, p_name: "Request approval v2",
      p_description: "Updated process", p_applies_to_entity_type_id: entityTypeId,
      p_steps: steps("Review request", "Approve request", firstId, secondId),
    })).error).toBeNull();
    expect(await events(workspaceId)).toHaveLength(2);

    expect((await builder.rpc("archive_process_template_authorized", { p_workspace_id: workspaceId, p_process_template_id: templateId })).error).toBeNull();
    expect((await builder.rpc("restore_process_template_authorized", { p_workspace_id: workspaceId, p_process_template_id: templateId })).error).toBeNull();
    audit = await events(workspaceId);
    expect(audit.map((event) => event.event_type)).toEqual(["process_template_created", "process_template_updated", "process_template_archived", "process_template_restored"]);

    expect((await admin.from("entity_types").update({ name: "Renamed Requests" }).eq("id", entityTypeId)).error).toBeNull();
    const oldCreated = audit[0].changes.new;
    expect(oldCreated.applies_to_entity_type.name).toBe("Requests");

    expect((await builder.rpc("delete_process_template_if_safe_authorized", { p_workspace_id: workspaceId, p_process_template_id: templateId })).error).toBeNull();
    audit = await events(workspaceId);
    expect(audit.at(-1)?.event_type).toBe("process_template_deleted");
    expect(audit.at(-1)?.subject_id).toBe(templateId);
    expect((await admin.from("process_templates").select("id").eq("id", templateId)).data).toHaveLength(0);
  }, 30_000);

  it("enforces automation.manage at safe delete and leaves blocked deletes unaudited", async () => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    workspaces.push(workspaceId);
    expect((await admin.from("workspaces").insert({ id: workspaceId, name: "Process governance authority" })).error).toBeNull();
    const entityTypeId = randomUUID();
    expect((await admin.from("entity_types").insert({ id: entityTypeId, workspace_id: workspaceId, name: "Requests", slug: `requests-${entityTypeId.slice(0, 8)}` })).error).toBeNull();
    const builder = await memberClient(workspaceId, ["automation.manage"]);
    const ordinary = await memberClient(workspaceId, []);
    const created = await builder.rpc("save_process_template_authorized", {
      p_workspace_id: workspaceId, p_process_template_id: null, p_name: "Protected process",
      p_description: null, p_applies_to_entity_type_id: entityTypeId, p_steps: steps("Start", "Finish"),
    });
    expect(created.error).toBeNull();
    const templateId = created.data as string;
    const before = await events(workspaceId);
    const denied = await ordinary.rpc("delete_process_template_if_safe_authorized", { p_workspace_id: workspaceId, p_process_template_id: templateId });
    expect(denied.error).not.toBeNull();
    expect(await events(workspaceId)).toHaveLength(before.length);
    expect((await builder.rpc("delete_process_template_if_safe_authorized", { p_workspace_id: workspaceId, p_process_template_id: templateId })).error).toBeNull();
  }, 30_000);
});
