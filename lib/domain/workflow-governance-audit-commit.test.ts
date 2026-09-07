// Live DB verification for Phase 13.2B3a. Workflows intentionally use their
// existing authenticated direct-DML contract; the database trigger is the
// only governance capture boundary.
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

async function createAutomationMember(workspaceId: string, capabilities: string[] = ["automation.manage"]): Promise<SupabaseClient> {
  const admin = createSupabaseTestClient();
  const password = `WorkflowGovernance-${randomUUID()}!`;
  const email = `e2e-workflow-governance-${randomUUID()}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? "Unable to create test user");
  users.push(created.data.user.id);
  const roleId = randomUUID();
  const setup = [await admin.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: `Automation role ${roleId.slice(0, 8)}` })];
  for (const capability of capabilities) {
    setup.push(await admin.from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability }));
  }
  setup.push(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: created.data.user.id, role_id: roleId }));
  for (const result of setup) {
    if (result.error) throw new Error(result.error.message);
  }
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(signedIn.error.message);
  return client;
}

async function getEvents(workspaceId: string) {
  const result = await createSupabaseTestClient()
    .from("governance_audit_events")
    .select("event_type, subject_id, subject_name_snapshot, changes")
    .eq("workspace_id", workspaceId)
    .eq("subject_kind", "workflow")
    .order("created_at", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

describe("Workflow governance audit", () => {
  it("captures grouped lifecycle changes, preserves snapshots, and respects boundaries", async () => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    workspaces.push(workspaceId);
    expect((await admin.from("workspaces").insert({ id: workspaceId, name: "Workflow governance" })).error).toBeNull();

    const triggerEntityTypeId = randomUUID();
    const targetEntityTypeId = randomUUID();
    expect((await admin.from("entity_types").insert([
      { id: triggerEntityTypeId, workspace_id: workspaceId, name: "Requests", slug: `requests-${triggerEntityTypeId.slice(0, 8)}` },
      { id: targetEntityTypeId, workspace_id: workspaceId, name: "Tasks", slug: `tasks-${targetEntityTypeId.slice(0, 8)}` },
    ])).error).toBeNull();
    const fieldId = randomUUID();
    expect((await admin.from("field_definitions").insert({
      id: fieldId, workspace_id: workspaceId, entity_type_id: triggerEntityTypeId,
      name: "Priority", slug: `priority-${fieldId.slice(0, 8)}`, key: "priority", type: "text", position: 1,
    })).error).toBeNull();

    const builder = await createAutomationMember(workspaceId);
    const workflowId = randomUUID();
    const actionConfig = {
      triggerConfig: { watchedFieldDefinitionIds: [fieldId] },
      conditions: [{ sourceFieldDefinitionId: fieldId, operator: "is_set" }],
    };
    const actions = [{ actionType: "create_record", actionTargetEntityTypeId: targetEntityTypeId, fieldMappings: [] }];
    expect((await builder.from("workflows").insert({
      id: workflowId, workspace_id: workspaceId, name: "Request routing", enabled: false,
      trigger_type: "record_updated", trigger_entity_type_id: triggerEntityTypeId,
      action_config: actionConfig, actions,
    })).error).toBeNull();
    expect((await getEvents(workspaceId)).map((event) => event.event_type)).toEqual(["workflow_created"]);

    expect((await builder.from("workflows").update({
      name: "Priority routing", enabled: true,
      action_config: { ...actionConfig, conditions: [{ sourceFieldDefinitionId: fieldId, operator: "changed" }] },
    }).eq("id", workflowId).select("id")).error).toBeNull();
    const grouped = await getEvents(workspaceId);
    expect(grouped).toHaveLength(2);
    expect(grouped[1].event_type).toBe("workflow_updated");
    expect(grouped[1].changes).toMatchObject({
      name: { old: "Request routing", new: "Priority routing" },
      enabled: { old: false, new: true },
      configuration: { old: { trigger_entity_type: { id: triggerEntityTypeId, name: "Requests" } }, new: { trigger_entity_type: { id: triggerEntityTypeId, name: "Requests" } } },
    });

    expect((await builder.from("workflows").update({ enabled: false }).eq("id", workflowId).select("id")).error).toBeNull();
    expect((await getEvents(workspaceId)).at(-1)?.event_type).toBe("workflow_disabled");
    expect((await builder.from("workflows").update({ enabled: false }).eq("id", workflowId).select("id")).error).toBeNull();
    expect((await getEvents(workspaceId)).at(-1)?.event_type).toBe("workflow_disabled");
    expect((await admin.from("entity_types").update({ name: "Renamed Requests" }).eq("id", triggerEntityTypeId)).error).toBeNull();
    const stable = (await getEvents(workspaceId))[0].changes as { new: { trigger_entity_type: { name: string } } };
    expect(stable.new.trigger_entity_type.name).toBe("Requests");

    const viewer = await createAutomationMember(workspaceId, []);
    const denied = await viewer.from("workflows").update({ name: "Denied" }).eq("id", workflowId).select("id");
    expect(denied.error).toBeNull();
    expect(denied.data).toHaveLength(0);

    expect((await builder.from("workflows").delete().eq("id", workflowId).select("id")).error).toBeNull();
    expect((await getEvents(workspaceId)).at(-1)?.event_type).toBe("workflow_deleted");
    expect((await admin.from("workflows").select("id").eq("id", workflowId)).data).toHaveLength(0);
  }, 30_000);
});
