// Phase 13.1 trust-boundary and history verification. These tests deliberately
// use the Supabase clients and RPCs directly; executor sequencing remains in
// the existing Workflow/Process suites.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };
type Activity = {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  authority_kind: string | null;
  real_actor_label: string | null;
  changes: { fields?: Array<Record<string, unknown>>; relations?: Array<Record<string, unknown>> } | null;
};

const admin = createSupabaseTestClient();
const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

async function createUser(label: string): Promise<User> {
  const password = `History-${randomUUID()}!`;
  const email = `e2e-history-${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create user");
  createdUsers.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function signIn(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

async function createWorkspace(label: string): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("workspaces").insert({ id, name: `${label} ${id.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  createdWorkspaces.push(id);
  return id;
}

async function createMember(workspaceId: string, capabilities: string[], label: string): Promise<{ user: User; client: SupabaseClient }> {
  const user = await createUser(label);
  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: `${label} role` });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length) {
    const { error } = await admin.from("workspace_role_capabilities").insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })));
    if (error) throw new Error(error.message);
  }
  const { error: memberError } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: user.id, role_id: roleId });
  if (memberError) throw new Error(memberError.message);
  return { user, client: await signIn(user) };
}

async function createEntity(workspaceId: string, name: string) {
  const id = randomUUID();
  const { error } = await admin.from("entity_types").insert({ id, workspace_id: workspaceId, name, slug: `${name.toLowerCase()}-${id.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  return id;
}

async function createField(workspaceId: string, entityTypeId: string, input: { key: string; name: string; type: string; position: number; relatedEntityTypeId?: string }) {
  const id = randomUUID();
  const { error } = await admin.from("field_definitions").insert({
    id, workspace_id: workspaceId, entity_type_id: entityTypeId, key: input.key, name: input.name,
    slug: input.key, type: input.type, position: input.position, required: false,
    related_entity_type_id: input.relatedEntityTypeId ?? null,
  });
  if (error) throw new Error(error.message);
  return { id, key: input.key };
}

async function createDirectRecord(workspaceId: string, entityTypeId: string, values: Record<string, unknown> = {}) {
  const id = randomUUID();
  const { error } = await admin.from("entity_records").insert({ id, workspace_id: workspaceId, entity_type_id: entityTypeId, values });
  if (error) throw new Error(error.message);
  return id;
}

async function activity(client: SupabaseClient, workspaceId: string, entityTypeId: string, recordId: string): Promise<Activity[]> {
  const { data, error } = await client.rpc("list_record_activity_authorized", { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_entity_record_id: recordId, p_limit: 100 });
  if (error) throw new Error(error.message);
  return (data ?? []) as Activity[];
}

async function expectRpcError(result: { error: { message: string } | null }, pattern: RegExp) {
  expect(result.error?.message).toMatch(pattern);
}

beforeAll(async () => {
  // Fail early with a useful message if this is accidentally run without the
  // live commit-test environment.
  requireE2eEnv();
});

afterAll(async () => {
  if (createdWorkspaces.length) await admin.from("workspaces").delete().in("id", createdWorkspaces);
  for (const userId of createdUsers) await admin.auth.admin.deleteUser(userId);
}, 30_000);

describe("record history trust and attribution", () => {
  it("records human and impersonated create/update attribution, including no-op suppression", async () => {
    const workspaceId = await createWorkspace("History Attribution");
    const { user: actor, client } = await createMember(workspaceId, ["records.operate", "workspace.impersonate_users"], "actor");
    const target = await createMember(workspaceId, ["records.operate"], "target");
    const entityTypeId = await createEntity(workspaceId, "Attribution Item");
    const field = await createField(workspaceId, entityTypeId, { key: "name", name: "Name", type: "text", position: 1 });

    const created = await client.rpc("create_entity_record_with_relations_authorized", { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_values: { name: "one" }, p_relations: [] });
    expect(created.error).toBeNull();
    const recordId = created.data as string;
    const humanCreated = (await activity(client, workspaceId, entityTypeId, recordId)).find((row) => row.event_type === "record_created");
    expect(humanCreated).toMatchObject({ authority_kind: "human", actor_user_id: actor.id, real_actor_label: null });

    const updated = await client.rpc("update_entity_record_with_relations_authorized", { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_record_id: recordId, p_values: { name: "two" }, p_relation_field_ids: [], p_relations: [] });
    expect(updated.error).toBeNull();
    const noOp = await client.rpc("update_entity_record_with_relations_authorized", { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_record_id: recordId, p_values: { name: "two" }, p_relation_field_ids: [], p_relations: [] });
    expect(noOp.error).toBeNull();
    const humanEvents = (await activity(client, workspaceId, entityTypeId, recordId)).filter((row) => row.event_type === "record_updated");
    expect(humanEvents).toHaveLength(1);

    const impersonation = await client.rpc("start_impersonation_session_authorized", { p_workspace_id: workspaceId, p_target_user_id: target.user.id });
    expect(impersonation.error).toBeNull();
    const impersonated = await client.rpc("update_entity_record_with_relations_authorized", { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_record_id: recordId, p_values: { name: "three" }, p_relation_field_ids: [], p_relations: [] });
    expect(impersonated.error).toBeNull();
    const impersonatedEvent = (await activity(client, workspaceId, entityTypeId, recordId)).find((row) => row.event_type === "record_updated" && row.authority_kind === "impersonated");
    expect(impersonatedEvent).toMatchObject({ authority_kind: "impersonated", actor_user_id: target.user.id });
    expect(impersonatedEvent?.real_actor_label).toBeTruthy();
    await client.rpc("end_impersonation_session_authorized", { p_session_id: (await client.rpc("get_active_impersonation_authorized")).data?.[0]?.session_id });

    expect(field.key).toBe("name");
  });

  it("rejects interactive provenance spoofing without creating a record or history", async () => {
    const workspaceId = await createWorkspace("History Provenance");
    const { client } = await createMember(workspaceId, ["records.operate"], "provenance");
    const entityTypeId = await createEntity(workspaceId, "Provenance Item");
    const fakeStepRunId = randomUUID();
    const result = await client.rpc("create_entity_record_with_relations_authorized", { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_values: {}, p_relations: [], p_originating_process_step_run_id: fakeStepRunId });
    await expectRpcError(result, /trusted process door/i);
    expect((await admin.from("entity_records").select("id").eq("workspace_id", workspaceId).eq("entity_type_id", entityTypeId)).data ?? []).toHaveLength(0);
  });
});

describe("trusted system doors", () => {
  it("captures Automation create/update/update-related attribution and rejects causal mismatches", async () => {
    const workspaceId = await createWorkspace("History Automation");
    const { client } = await createMember(workspaceId, ["records.operate", "automation.manage"], "automation");
    const sourceTypeId = await createEntity(workspaceId, "Automation Source");
    const targetTypeId = await createEntity(workspaceId, "Automation Target");
    await createField(workspaceId, sourceTypeId, { key: "automation_source_name", name: "Source name", type: "text", position: 1 });
    await createField(workspaceId, targetTypeId, { key: "automation_target_name", name: "Target name", type: "text", position: 1 });
    const relation = await createField(workspaceId, sourceTypeId, { key: "target", name: "Target", type: "relation", position: 2, relatedEntityTypeId: targetTypeId });
    const sourceId = await createDirectRecord(workspaceId, sourceTypeId, {});
    const targetId = await createDirectRecord(workspaceId, targetTypeId, { automation_target_name: "target" });
    await admin.from("entity_record_relation_values").insert({ workspace_id: workspaceId, source_entity_type_id: sourceTypeId, source_record_id: sourceId, field_definition_id: relation.id, target_entity_type_id: targetTypeId, target_record_id: targetId });
    const workflowId = randomUUID();
    const { error: workflowError } = await admin.from("workflows").insert({ id: workflowId, workspace_id: workspaceId, name: "History automation", enabled: true, trigger_type: "record_created", trigger_entity_type_id: sourceTypeId, action_config: { triggerConfig: {}, conditions: [] }, actions: [
      { actionType: "create_record", actionTargetEntityTypeId: targetTypeId, fieldMappings: [] },
      { actionType: "update_record", fieldMappings: [] },
      { actionType: "update_related_record", relatedFieldDefinitionId: relation.id, fieldMappings: [] },
    ] });
    expect(workflowError).toBeNull();
    const created = await admin.rpc("create_entity_record_with_relations_automation_system", { p_workspace_id: workspaceId, p_entity_type_id: targetTypeId, p_values: { automation_target_name: "created" }, p_relations: [], p_originating_workflow_id: workflowId, p_action_type: "create_record", p_related_field_definition_id: null });
    expect(created.error).toBeNull();
    const update = await admin.rpc("update_entity_record_with_relations_automation_system", { p_workspace_id: workspaceId, p_entity_type_id: sourceTypeId, p_record_id: sourceId, p_values: { automation_source_name: "changed" }, p_relation_field_ids: [], p_relations: [], p_originating_workflow_id: workflowId, p_action_type: "update_record", p_related_field_definition_id: null });
    expect(update.error).toBeNull();
    const related = await admin.rpc("update_entity_record_with_relations_automation_system", { p_workspace_id: workspaceId, p_entity_type_id: targetTypeId, p_record_id: targetId, p_values: { automation_target_name: "related changed" }, p_relation_field_ids: [], p_relations: [], p_originating_workflow_id: workflowId, p_action_type: "update_related_record", p_related_field_definition_id: relation.id });
    expect(related.error).toBeNull();
    const wrong = await admin.rpc("create_entity_record_with_relations_automation_system", { p_workspace_id: workspaceId, p_entity_type_id: sourceTypeId, p_values: {}, p_relations: [], p_originating_workflow_id: workflowId, p_action_type: "create_record", p_related_field_definition_id: null });
    await expectRpcError(wrong, /Workflow cause/i);
    const createdEvents = await activity(client, workspaceId, targetTypeId, created.data as string);
    const relatedEvents = await activity(client, workspaceId, targetTypeId, targetId);
    const automationEvents = [...createdEvents, ...relatedEvents].filter((row) => row.authority_kind === "automation");
    expect(automationEvents).toHaveLength(2);
    expect(automationEvents.every((row) => row.actor_user_id === null)).toBe(true);
  });

  it("captures Process create attribution and reuses the same created record on retry", async () => {
    const workspaceId = await createWorkspace("History Process");
    const { client } = await createMember(workspaceId, ["records.operate", "processes.operate"], "process");
    const originTypeId = await createEntity(workspaceId, "Process Origin");
    const targetTypeId = await createEntity(workspaceId, "Process Target");
    const originId = await createDirectRecord(workspaceId, originTypeId, {});
    const templateId = randomUUID();
    const runId = randomUUID();
    const stepId = randomUUID();
    expect((await admin.from("process_templates").insert({ id: templateId, workspace_id: workspaceId, applies_to_entity_type_id: originTypeId, name: "History process" })).error).toBeNull();
    expect((await admin.from("process_runs").insert({ id: runId, workspace_id: workspaceId, process_template_id: templateId, process_template_name: "History process", origin_entity_type_id: originTypeId, origin_record_id: originId, status: "active" })).error).toBeNull();
    expect((await admin.from("process_step_runs").insert({ id: stepId, workspace_id: workspaceId, process_run_id: runId, step_index: 1, node_type: "action", name: "Create", config: { action_config: { action_type: "create_record", action_target_entity_type_id: targetTypeId } }, status: "active", started_at: new Date().toISOString(), assignment_generation: 1 })).error).toBeNull();
    const args = { p_workspace_id: workspaceId, p_entity_type_id: targetTypeId, p_values: { name: "process" }, p_relations: [], p_originating_process_step_run_id: stepId, p_action_type: "create_record", p_related_field_definition_id: null };
    const first = await admin.rpc("create_entity_record_with_relations_process_system", args);
    const second = await admin.rpc("create_entity_record_with_relations_process_system", args);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);
    const rows = await admin.from("entity_records").select("id").eq("originating_process_step_run_id", stepId);
    expect(rows.data).toHaveLength(1);
    const events = (await activity(client, workspaceId, targetTypeId, first.data as string)).filter((row) => row.event_type === "record_created");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ authority_kind: "process", actor_user_id: null });
  });

  it("captures Process update attribution and suppresses a no-op retry", async () => {
    const workspaceId = await createWorkspace("History Process Update");
    const { client } = await createMember(workspaceId, ["records.operate", "processes.operate"], "process-update");
    const entityTypeId = await createEntity(workspaceId, "Process Update Item");
    const field = await createField(workspaceId, entityTypeId, { key: "process_update_name", name: "Process name", type: "text", position: 1 });
    const recordId = await createDirectRecord(workspaceId, entityTypeId, { [field.key]: "before" });
    const templateId = randomUUID();
    const runId = randomUUID();
    const stepId = randomUUID();
    expect((await admin.from("process_templates").insert({ id: templateId, workspace_id: workspaceId, applies_to_entity_type_id: entityTypeId, name: "Process update" })).error).toBeNull();
    expect((await admin.from("process_runs").insert({ id: runId, workspace_id: workspaceId, process_template_id: templateId, process_template_name: "Process update", origin_entity_type_id: entityTypeId, origin_record_id: recordId, status: "active" })).error).toBeNull();
    expect((await admin.from("process_step_runs").insert({ id: stepId, workspace_id: workspaceId, process_run_id: runId, step_index: 1, node_type: "action", name: "Update", config: { action_config: { action_type: "update_record" } }, status: "active", started_at: new Date().toISOString(), assignment_generation: 1 })).error).toBeNull();
    const args = { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_record_id: recordId, p_values: { [field.key]: "after" }, p_relation_field_ids: [], p_relations: [], p_originating_process_step_run_id: stepId, p_action_type: "update_record", p_related_field_definition_id: null };
    expect((await admin.rpc("update_entity_record_with_relations_process_system", args)).error).toBeNull();
    expect((await admin.rpc("update_entity_record_with_relations_process_system", args)).error).toBeNull();
    const events = (await activity(client, workspaceId, entityTypeId, recordId)).filter((row) => row.event_type === "record_updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ authority_kind: "process", actor_user_id: null });
    expect(events[0].changes?.fields).toEqual([expect.objectContaining({ field_key: field.key, old_value: "before", new_value: "after" })]);
  });

  it("captures Process update-related attribution using the persisted relation field", async () => {
    const workspaceId = await createWorkspace("History Process Related");
    const { client } = await createMember(workspaceId, ["records.operate", "processes.operate"], "process-related");
    const sourceTypeId = await createEntity(workspaceId, "Process Related Source");
    const targetTypeId = await createEntity(workspaceId, "Process Related Target");
    const relation = await createField(workspaceId, sourceTypeId, { key: "process_target", name: "Process target", type: "relation", position: 1, relatedEntityTypeId: targetTypeId });
    const targetField = await createField(workspaceId, targetTypeId, { key: "process_target_name", name: "Target name", type: "text", position: 1 });
    const sourceId = await createDirectRecord(workspaceId, sourceTypeId, {});
    const targetId = await createDirectRecord(workspaceId, targetTypeId, { [targetField.key]: "before" });
    expect((await admin.from("entity_record_relation_values").insert({ workspace_id: workspaceId, source_entity_type_id: sourceTypeId, source_record_id: sourceId, field_definition_id: relation.id, target_entity_type_id: targetTypeId, target_record_id: targetId })).error).toBeNull();
    const templateId = randomUUID();
    const runId = randomUUID();
    const stepId = randomUUID();
    expect((await admin.from("process_templates").insert({ id: templateId, workspace_id: workspaceId, applies_to_entity_type_id: sourceTypeId, name: "Process related" })).error).toBeNull();
    expect((await admin.from("process_runs").insert({ id: runId, workspace_id: workspaceId, process_template_id: templateId, process_template_name: "Process related", origin_entity_type_id: sourceTypeId, origin_record_id: sourceId, status: "active" })).error).toBeNull();
    expect((await admin.from("process_step_runs").insert({ id: stepId, workspace_id: workspaceId, process_run_id: runId, step_index: 1, node_type: "action", name: "Update related", config: { action_config: { action_type: "update_related_record", related_field_definition_id: relation.id } }, status: "active", started_at: new Date().toISOString(), assignment_generation: 1 })).error).toBeNull();
    const result = await admin.rpc("update_entity_record_with_relations_process_system", { p_workspace_id: workspaceId, p_entity_type_id: targetTypeId, p_record_id: targetId, p_values: { [targetField.key]: "after" }, p_relation_field_ids: [], p_relations: [], p_originating_process_step_run_id: stepId, p_action_type: "update_related_record", p_related_field_definition_id: relation.id });
    expect(result.error).toBeNull();
    const events = (await activity(client, workspaceId, targetTypeId, targetId)).filter((row) => row.event_type === "record_updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ authority_kind: "process", actor_user_id: null });
  });

  it("rejects consequential Automation and Process causal mismatches without side effects", async () => {
    const workspaceId = await createWorkspace("History Cause Matrix");
    const { client } = await createMember(workspaceId, ["records.operate", "automation.manage", "processes.operate"], "cause-matrix");
    const typeA = await createEntity(workspaceId, "Cause A");
    const typeB = await createEntity(workspaceId, "Cause B");
    const relation = await createField(workspaceId, typeA, { key: "cause_target", name: "Cause target", type: "relation", position: 1, relatedEntityTypeId: typeB });
    const sourceId = await createDirectRecord(workspaceId, typeA, {});
    const targetId = await createDirectRecord(workspaceId, typeB, {});
    const workflowId = randomUUID();
    expect((await admin.from("workflows").insert({ id: workflowId, workspace_id: workspaceId, name: "Cause workflow", enabled: true, trigger_type: "record_created", trigger_entity_type_id: typeA, action_config: { triggerConfig: {}, conditions: [] }, actions: [{ actionType: "create_record", actionTargetEntityTypeId: typeA, fieldMappings: [] }, { actionType: "update_related_record", relatedFieldDefinitionId: relation.id, fieldMappings: [] }] })).error).toBeNull();
    const wrongCreate = await admin.rpc("create_entity_record_with_relations_automation_system", { p_workspace_id: workspaceId, p_entity_type_id: typeB, p_values: {}, p_relations: [], p_originating_workflow_id: workflowId, p_action_type: "create_record", p_related_field_definition_id: null });
    await expectRpcError(wrongCreate, /Workflow cause/i);
    const wrongRelation = await admin.rpc("update_entity_record_with_relations_automation_system", { p_workspace_id: workspaceId, p_entity_type_id: typeB, p_record_id: targetId, p_values: {}, p_relation_field_ids: [], p_relations: [], p_originating_workflow_id: workflowId, p_action_type: "update_related_record", p_related_field_definition_id: randomUUID() });
    await expectRpcError(wrongRelation, /Workflow cause/i);
    const foreignWorkflow = await admin.rpc("create_entity_record_with_relations_automation_system", { p_workspace_id: randomUUID(), p_entity_type_id: typeA, p_values: {}, p_relations: [], p_originating_workflow_id: workflowId, p_action_type: "create_record", p_related_field_definition_id: null });
    await expectRpcError(foreignWorkflow, /Workflow cause/i);
    const templateId = randomUUID();
    const runId = randomUUID();
    const humanStepId = randomUUID();
    expect((await admin.from("process_templates").insert({ id: templateId, workspace_id: workspaceId, applies_to_entity_type_id: typeA, name: "Cause process" })).error).toBeNull();
    expect((await admin.from("process_runs").insert({ id: runId, workspace_id: workspaceId, process_template_id: templateId, process_template_name: "Cause process", origin_entity_type_id: typeA, origin_record_id: sourceId, status: "active" })).error).toBeNull();
    expect((await admin.from("process_step_runs").insert({ id: humanStepId, workspace_id: workspaceId, process_run_id: runId, step_index: 1, node_type: "human_task", name: "Human", config: {}, status: "active", started_at: new Date().toISOString(), assignment_generation: 1 })).error).toBeNull();
    const humanDoor = await admin.rpc("update_entity_record_with_relations_process_system", { p_workspace_id: workspaceId, p_entity_type_id: typeA, p_record_id: sourceId, p_values: {}, p_relation_field_ids: [], p_relations: [], p_originating_process_step_run_id: humanStepId, p_action_type: "update_record", p_related_field_definition_id: null });
    await expectRpcError(humanDoor, /Process cause/i);
    const foreignStep = await admin.rpc("update_entity_record_with_relations_process_system", { p_workspace_id: randomUUID(), p_entity_type_id: typeA, p_record_id: sourceId, p_values: {}, p_relation_field_ids: [], p_relations: [], p_originating_process_step_run_id: humanStepId, p_action_type: "update_record", p_related_field_definition_id: null });
    await expectRpcError(foreignStep, /Process cause/i);
    expect((await admin.from("entity_records").select("id").in("id", [sourceId, targetId])).data).toHaveLength(2);
    expect((await activity(client, workspaceId, typeA, sourceId)).filter((row) => row.authority_kind === "automation" || row.authority_kind === "process")).toHaveLength(0);
  });
});

describe("live history mechanics", () => {
  it("freezes primitive, Choice, relation, field, and target-label snapshots", async () => {
    const workspaceId = await createWorkspace("History Snapshots");
    const { client: builder } = await createMember(workspaceId, ["records.operate", "schema.manage"], "snapshot-builder");
    const { client: worker } = await createMember(workspaceId, ["records.operate"], "snapshot-worker");
    const entityTypeId = await createEntity(workspaceId, "Snapshot Item");
    const relatedTypeId = await createEntity(workspaceId, "Snapshot Target");
    const primitive = await createField(workspaceId, entityTypeId, { key: "snapshot_text", name: "Original text", type: "text", position: 1 });
    const choice = await createField(workspaceId, entityTypeId, { key: "snapshot_choice", name: "Original choice", type: "choice", position: 2 });
    const relation = await createField(workspaceId, entityTypeId, { key: "snapshot_relation", name: "Original relation", type: "relation", position: 3, relatedEntityTypeId: relatedTypeId });
    await createField(workspaceId, relatedTypeId, { key: "snapshot_label", name: "Target label", type: "text", position: 1 });
    const oldOption = (await builder.rpc("add_field_choice_option", { p_workspace_id: workspaceId, p_field_definition_id: choice.id, p_label: "Open", p_color: "gray" })).data as string;
    const newOption = (await builder.rpc("add_field_choice_option", { p_workspace_id: workspaceId, p_field_definition_id: choice.id, p_label: "Closed", p_color: "blue" })).data as string;
    const oldTarget = await createDirectRecord(workspaceId, relatedTypeId, { snapshot_label: "Northwind" });
    const newTarget = await createDirectRecord(workspaceId, relatedTypeId, { snapshot_label: "Contoso" });
    const created = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId,
      p_values: { [primitive.key]: "before", [choice.key]: oldOption },
      p_relations: [{ field_definition_id: relation.id, target_entity_type_id: relatedTypeId, target_record_id: oldTarget }],
    });
    expect(created.error).toBeNull();
    const recordId = created.data as string;
    const updated = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_record_id: recordId,
      p_values: { [primitive.key]: "after", [choice.key]: newOption },
      p_relation_field_ids: [relation.id],
      p_relations: [{ field_definition_id: relation.id, target_entity_type_id: relatedTypeId, target_record_id: newTarget }],
    });
    expect(updated.error).toBeNull();
    const event = (await activity(worker, workspaceId, entityTypeId, recordId)).find((row) => row.event_type === "record_updated");
    expect(event?.changes?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field_definition_id: primitive.id, field_key: primitive.key, field_name_snapshot: "Original text", field_type: "text", old_value: "before", new_value: "after" }),
      expect.objectContaining({ field_definition_id: choice.id, old_value: oldOption, new_value: newOption, old_choice_label_snapshot: "Open", old_choice_color_snapshot: "gray", new_choice_label_snapshot: "Closed", new_choice_color_snapshot: "blue" }),
    ]));
    expect(event?.changes?.relations).toEqual([
      expect.objectContaining({ field_definition_id: relation.id, field_name_snapshot: "Original relation", old_target_record_id: oldTarget, old_target_label_snapshot: "Northwind", new_target_record_id: newTarget, new_target_label_snapshot: "Contoso" }),
    ]);

    const cleared = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_record_id: recordId,
      p_values: { [primitive.key]: "after", [choice.key]: newOption },
      p_relation_field_ids: [relation.id], p_relations: [],
    });
    expect(cleared.error).toBeNull();
    const clearEvent = (await activity(worker, workspaceId, entityTypeId, recordId)).find((row) => row.event_type === "record_updated" && row.id !== event?.id);
    expect(clearEvent?.changes?.relations).toEqual([
      expect.objectContaining({ old_target_record_id: newTarget, old_target_label_snapshot: "Contoso", new_target_record_id: null, new_target_label_snapshot: null }),
    ]);

    expect((await admin.from("field_definitions").update({ name: "Renamed text" }).eq("id", primitive.id)).error).toBeNull();
    expect((await builder.rpc("update_field_choice_option", { p_workspace_id: workspaceId, p_field_definition_id: choice.id, p_option_id: newOption, p_label: "Resolved", p_color: "emerald" })).error).toBeNull();
    expect((await admin.from("entity_records").update({ values: { snapshot_label: "Renamed target" } }).eq("id", newTarget)).error).toBeNull();
    const reread = await activity(worker, workspaceId, entityTypeId, recordId);
    expect(reread.find((row) => row.id === event?.id)?.changes).toEqual(event?.changes);
    expect(reread.find((row) => row.id === clearEvent?.id)?.changes).toEqual(clearEvent?.changes);
  });

  it("exposes the combined Activity shape and blocks direct history table writes", async () => {
    const workspaceId = await createWorkspace("History Mechanics");
    const { client } = await createMember(workspaceId, ["records.operate"], "mechanics");
    const entityTypeId = await createEntity(workspaceId, "Mechanics Item");
    const created = await client.rpc("create_entity_record_with_relations_authorized", { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_values: {}, p_relations: [] });
    const recordId = created.data as string;
    const rows = await activity(client, workspaceId, entityTypeId, recordId);
    expect(rows[0]).toHaveProperty("changes");
    expect(rows[0]).toHaveProperty("authority_kind");
    const eventId = rows[0].id;
    const directUpdate = await admin.from("record_change_events").update({ changes: { forged: true } }).eq("id", eventId);
    const directDelete = await admin.from("record_change_events").delete().eq("id", eventId);
    expect(directUpdate.error?.message).toMatch(/permission denied|append-only/i);
    expect(directDelete.error?.message).toMatch(/permission denied|append-only/i);
  });

  it("keeps workspace teardown cascade available for history-bearing disposable data", async () => {
    const workspaceId = await createWorkspace("History Teardown");
    const { client } = await createMember(workspaceId, ["records.operate"], "teardown");
    const entityTypeId = await createEntity(workspaceId, "Teardown Item");
    expect((await client.rpc("create_entity_record_with_relations_authorized", { p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_values: {}, p_relations: [] })).error).toBeNull();
    const { error } = await admin.from("workspaces").delete().eq("id", workspaceId);
    expect(error).toBeNull();
    createdWorkspaces.splice(createdWorkspaces.indexOf(workspaceId), 1);
  });
});
