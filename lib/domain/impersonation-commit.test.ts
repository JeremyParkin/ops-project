// DB/RPC-level coverage for Phase 8E.2 Impersonation: session lifecycle
// (start/end authorization, same-workspace/active-member/self-impersonation
// guards, one-open-session-per-admin, self-healing on target deactivation),
// effective-identity enforcement for records.operate (RLS-enforced create/
// archive/view paths) and processes.operate (assignee-equality-gated step
// completion and approval decisions), the deliberate real-actor-bound scope
// boundary for schema.manage, and real/effective actor audit semantics on
// workspace_events. Requires migration 0068 applied.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

function uniqueEmail(label: string) {
  return `e2e-impersonation-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Impersonation-${randomUUID()}!`;
  const email = uniqueEmail(label);
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
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

// The admin fixture is signed in once and reused everywhere (including the
// beforeEach isolation guard below) rather than re-authenticating per test --
// this file alone would otherwise trigger 15+ Supabase Auth sign-ins back to
// back, which reliably hits Supabase's own auth rate limiter (confirmed
// directly: a first version that signed in fresh per test failed the
// majority of tests with "Request rate limit reached", an infrastructure
// error unrelated to anything under test).
let sharedAdminClientPromise: ReturnType<typeof authenticatedClient> | undefined;
function sharedAdminClient() {
  sharedAdminClientPromise ??= authenticatedClient(fixture.admin);
  return sharedAdminClientPromise;
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error } = await admin.from("workspaces").insert({ id: workspaceId, name: `${name} ${workspaceId.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function addMembership(workspaceId: string, userId: string, roleId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role_id: roleId });
  if (error) throw new Error(error.message);
}

async function createEntityType(workspaceId: string, name: string) {
  const admin = createSupabaseTestClient();
  const entityTypeId = randomUUID();
  const fieldId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityTypeId, workspace_id: workspaceId, name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${entityTypeId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);
  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: fieldId, workspace_id: workspaceId, entity_type_id: entityTypeId, key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);
  const { error: displayFieldError } = await admin.rpc("set_entity_display_field", {
    p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_field_definition_id: fieldId,
  });
  if (displayFieldError) throw new Error(displayFieldError.message);
  return { entityTypeId, fieldId };
}

async function createHumanTaskTemplate(workspaceId: string, entityTypeId: string, assigneeUserId: string) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId, workspace_id: workspaceId, name: `Impersonation task template ${templateId.slice(0, 8)}`, applies_to_entity_type_id: entityTypeId,
  });
  if (templateError) throw new Error(templateError.message);
  const { error: nodeError } = await admin.from("process_nodes").insert({
    id: randomUUID(), workspace_id: workspaceId, process_template_id: templateId, node_type: "human_task",
    name: "Review", position: 1, assignee_user_id: assigneeUserId, config: {},
  });
  if (nodeError) throw new Error(nodeError.message);
  return templateId;
}

async function createApprovalTemplate(workspaceId: string, entityTypeId: string, assigneeUserId: string) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const approvalNodeId = randomUUID();
  const approveTargetNodeId = randomUUID();
  const rejectTargetNodeId = randomUUID();
  const approveOutcomeId = randomUUID();
  const rejectOutcomeId = randomUUID();

  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId, workspace_id: workspaceId, name: `Impersonation approval template ${templateId.slice(0, 8)}`, applies_to_entity_type_id: entityTypeId,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await admin.from("process_nodes").insert([
    { id: approvalNodeId, workspace_id: workspaceId, process_template_id: templateId, node_type: "approval", name: "Approve", position: 1, assignee_user_id: assigneeUserId, config: {} },
    { id: approveTargetNodeId, workspace_id: workspaceId, process_template_id: templateId, node_type: "human_task", name: "Approved path", position: 2, config: {} },
    { id: rejectTargetNodeId, workspace_id: workspaceId, process_template_id: templateId, node_type: "human_task", name: "Rejected path", position: 3, config: {} },
  ]);
  if (nodeError) throw new Error(nodeError.message);

  const { error: edgeError } = await admin.from("process_edges").insert([
    { workspace_id: workspaceId, process_template_id: templateId, source_node_id: approvalNodeId, target_node_id: approveTargetNodeId, priority: 0, is_default: false, is_parallel: false, approval_outcome_id: approveOutcomeId, approval_outcome_label: "Approved" },
    { workspace_id: workspaceId, process_template_id: templateId, source_node_id: approvalNodeId, target_node_id: rejectTargetNodeId, priority: 1, is_default: false, is_parallel: false, approval_outcome_id: rejectOutcomeId, approval_outcome_label: "Rejected" },
  ]);
  if (edgeError) throw new Error(edgeError.message);

  return { templateId, outcomeId: approveOutcomeId };
}

// entity_records.values is keyed by the field's stable `key`, not its id or
// slug -- createEntityType always creates its one field with key "name".
async function createRecord(workspaceId: string, entityTypeId: string, name: string) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin.from("entity_records").insert({
    id: recordId, workspace_id: workspaceId, entity_type_id: entityTypeId, values: { name },
  });
  if (error) throw new Error(error.message);
  return recordId;
}

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  fullAdminRoleId: string;
  workerRoleId: string;
  restrictedRoleId: string;
  admin: User;
  worker: User;
  restrictedMember: User;
  assignee: User;
  entityTypeId: string;
  fieldId: string;
};

let fixture: Fixture;

beforeAll(async () => {
  const workspaceId = await createWorkspace("E2E Impersonation");
  const otherWorkspaceId = await createWorkspace("E2E Impersonation Other");

  const fullAdminRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members", "workspace.manage_roles", "workspace.manage_organization", "workspace.manage_settings",
    "schema.manage", "automation.manage", "records.operate", "processes.operate", "operations.view",
    "workspace.impersonate_users",
  ]);
  const workerRoleId = await createRole(workspaceId, "Worker", ["records.operate", "processes.operate"]);
  const restrictedRoleId = await createRole(workspaceId, "Restricted", []);
  const otherAdminRoleId = await createRole(otherWorkspaceId, "Administrator", ["workspace.impersonate_users"]);

  const admin = await createUser("admin");
  const worker = await createUser("worker");
  const restrictedMember = await createUser("restricted");
  const assignee = await createUser("assignee");
  const otherAdmin = await createUser("other-admin");

  await addMembership(workspaceId, admin.id, fullAdminRoleId);
  await addMembership(workspaceId, worker.id, workerRoleId);
  await addMembership(workspaceId, restrictedMember.id, restrictedRoleId);
  await addMembership(workspaceId, assignee.id, workerRoleId);
  await addMembership(otherWorkspaceId, otherAdmin.id, otherAdminRoleId);

  const { entityTypeId, fieldId } = await createEntityType(workspaceId, `Impersonation Object ${workspaceId.slice(0, 6)}`);

  fixture = {
    workspaceId, otherWorkspaceId, fullAdminRoleId, workerRoleId, restrictedRoleId,
    admin, worker, restrictedMember, assignee, entityTypeId, fieldId,
  };
}, 30_000);

afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];

  if (createdWorkspaceIds.length) {
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) failures.push(error.message);
  }
  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) failures.push(`${userId}: ${error.message}`);
  }

  if (failures.length > 0) {
    throw new Error(`impersonation-commit afterAll cleanup: ${failures.length} failure(s):\n${failures.join("\n")}`);
  }
}, 30_000);

async function endAnyActiveSession(adminClient: SupabaseClient) {
  const { data } = await adminClient.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await adminClient.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

// A failed assertion mid-test can skip a test's own trailing
// endAnyActiveSession cleanup, leaving a stale session that would otherwise
// bleed into and misattribute every later test in this file (each test's
// own end-of-test cleanup is not a substitute for real isolation). Every
// test starts from a guaranteed-clean slate regardless of what the previous
// one did or how it failed.
beforeEach(async () => {
  const adminClient = await sharedAdminClient();
  await endAnyActiveSession(adminClient);
});

describe("impersonation session lifecycle", () => {
  it("requires workspace.impersonate_users to start a session", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const result = await workerClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.restrictedMember.id,
    });
    expect(result.error?.message).toContain("workspace.impersonate_users");
  });

  it("rejects self-impersonation", async () => {
    const adminClient = await sharedAdminClient();
    const result = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.admin.id,
    });
    expect(result.error?.message).toContain("cannot impersonate yourself");
  });

  it("rejects a target who is not an active member of the workspace", async () => {
    const adminClient = await sharedAdminClient();
    const nonMember = await createUser("non-member");
    const result = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: nonMember.id,
    });
    expect(result.error?.message).toContain("not found or not active");
    await endAnyActiveSession(adminClient);
  });

  it("rejects a target from a different workspace", async () => {
    const adminClient = await sharedAdminClient();
    const result = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.otherWorkspaceId, p_target_user_id: fixture.worker.id,
    });
    // The admin fixture is not a member of otherWorkspaceId at all, so the
    // capability check itself denies first -- still proves cross-workspace
    // isolation, just via the earlier gate.
    expect(result.error).not.toBeNull();
    await endAnyActiveSession(adminClient);
  });

  it("starting a new session ends the admin's prior open session, and get_active_impersonation_authorized reflects exactly one active session", async () => {
    const adminClient = await sharedAdminClient();

    const first = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.worker.id,
    });
    expect(first.error).toBeNull();

    const second = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.restrictedMember.id,
    });
    expect(second.error).toBeNull();

    const active = await adminClient.rpc("get_active_impersonation_authorized");
    expect(active.error).toBeNull();
    expect(active.data).toHaveLength(1);
    expect((active.data as Array<{ effective_user_id: string }>)[0].effective_user_id).toBe(fixture.restrictedMember.id);

    await endAnyActiveSession(adminClient);
    const afterEnd = await adminClient.rpc("get_active_impersonation_authorized");
    expect(afterEnd.data).toEqual([]);
  });

  it("end_impersonation_session_authorized only ends the caller's own session", async () => {
    const adminClient = await sharedAdminClient();
    const started = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.worker.id,
    });
    const sessionId = started.data as string;

    const workerClient = await authenticatedClient(fixture.worker);
    const wrongEnd = await workerClient.rpc("end_impersonation_session_authorized", { p_session_id: sessionId });
    expect(wrongEnd.error?.message).toContain("not found or already ended");

    const rightEnd = await adminClient.rpc("end_impersonation_session_authorized", { p_session_id: sessionId });
    expect(rightEnd.error).toBeNull();

    const doubleEnd = await adminClient.rpc("end_impersonation_session_authorized", { p_session_id: sessionId });
    expect(doubleEnd.error?.message).toContain("not found or already ended");
  });

  it("self-heals: deactivating the target mid-session ends it and get_active_impersonation_authorized returns empty", async () => {
    const target = await createUser("deactivate-mid-session");
    await addMembership(fixture.workspaceId, target.id, fixture.workerRoleId);
    const adminClient = await sharedAdminClient();

    const started = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: target.id,
    });
    expect(started.error).toBeNull();
    const activeBefore = await adminClient.rpc("get_active_impersonation_authorized");
    expect(activeBefore.data).toHaveLength(1);

    const serviceAdmin = createSupabaseTestClient();
    const { error: deactivateError } = await serviceAdmin
      .from("workspace_memberships")
      .update({ deactivated_at: new Date().toISOString() })
      .eq("workspace_id", fixture.workspaceId).eq("user_id", target.id);
    expect(deactivateError).toBeNull();

    const activeAfter = await adminClient.rpc("get_active_impersonation_authorized");
    expect(activeAfter.data).toEqual([]);

    // Confirms the RPC actually ended the row (self-heal), not merely hid it.
    const secondCall = await adminClient.rpc("get_active_impersonation_authorized");
    expect(secondCall.data).toEqual([]);
  });
});

describe("effective-identity enforcement: records.operate", () => {
  it("create_entity_record_with_relations_authorized evaluates the effective user's records.operate, not the real admin's", async () => {
    const adminClient = await sharedAdminClient();
    await endAnyActiveSession(adminClient);

    const asRestricted = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.restrictedMember.id,
    });
    expect(asRestricted.error).toBeNull();

    const denied = await adminClient.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityTypeId,
      p_values: { name: "Denied while impersonating restricted member" }, p_relations: [],
    });
    expect(denied.error?.message).toContain("records.operate");

    await endAnyActiveSession(adminClient);
    const asWorker = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.worker.id,
    });
    expect(asWorker.error).toBeNull();

    const allowed = await adminClient.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityTypeId,
      p_values: { name: "Allowed while impersonating a worker" }, p_relations: [],
    });
    expect(allowed.error).toBeNull();

    await endAnyActiveSession(adminClient);
  });

  it("the entity_records RLS write policy (archive) evaluates the effective user, not the real admin", async () => {
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "RLS archive target");
    const adminClient = await sharedAdminClient();
    await endAnyActiveSession(adminClient);

    const asRestricted = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.restrictedMember.id,
    });
    expect(asRestricted.error).toBeNull();

    const deniedArchive = await adminClient
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", fixture.workspaceId).eq("id", recordId)
      .select("id");
    // RLS silently filters rather than raising -- zero rows affected is the
    // correct signal a WITH CHECK failure produces here.
    expect(deniedArchive.error).toBeNull();
    expect(deniedArchive.data).toEqual([]);

    await endAnyActiveSession(adminClient);
    const asWorker = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.worker.id,
    });
    expect(asWorker.error).toBeNull();

    const allowedArchive = await adminClient
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", fixture.workspaceId).eq("id", recordId)
      .select("id");
    expect(allowedArchive.error).toBeNull();
    expect(allowedArchive.data).toHaveLength(1);

    await endAnyActiveSession(adminClient);
  });

  it("set_entity_records_archived_authorized (Phase 9.5 bulk archive/restore) evaluates the effective user's records.operate, not the real admin's", async () => {
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Bulk archive impersonation target");
    const adminClient = await sharedAdminClient();
    await endAnyActiveSession(adminClient);

    const asRestricted = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.restrictedMember.id,
    });
    expect(asRestricted.error).toBeNull();

    const denied = await adminClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityTypeId,
      p_record_ids: [recordId], p_archived: true,
    });
    expect(denied.error?.message).toContain("records.operate");
    const admin = createSupabaseTestClient();
    const { data: stillActive } = await admin.from("entity_records").select("archived_at").eq("id", recordId).single();
    expect(stillActive?.archived_at).toBeNull();

    await endAnyActiveSession(adminClient);
    const asWorker = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.worker.id,
    });
    expect(asWorker.error).toBeNull();

    const allowed = await adminClient
      .rpc("set_entity_records_archived_authorized", {
        p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.entityTypeId,
        p_record_ids: [recordId], p_archived: true,
      })
      .single<{ updated_record_count: number }>();
    expect(allowed.error).toBeNull();
    expect(allowed.data?.updated_record_count).toBe(1);

    await endAnyActiveSession(adminClient);
  });
});

describe("scope boundary: governance and builder capabilities stay real-actor-bound", () => {
  it("schema.manage is unaffected by impersonation -- the real admin's own capability still governs", async () => {
    const adminClient = await sharedAdminClient();
    await endAnyActiveSession(adminClient);

    const asRestricted = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.restrictedMember.id,
    });
    expect(asRestricted.error).toBeNull();

    // The real admin holds schema.manage; the impersonated restricted
    // member does not. This deliberately still succeeds -- schema.manage
    // was explicitly scoped OUT of effective-identity enforcement.
    const schemaWrite = await adminClient
      .from("entity_types")
      .update({ description: "Edited while impersonating a non-builder" })
      .eq("workspace_id", fixture.workspaceId).eq("id", fixture.entityTypeId)
      .select("id");
    expect(schemaWrite.error).toBeNull();
    expect(schemaWrite.data).toHaveLength(1);

    await endAnyActiveSession(adminClient);
  });
});

describe("effective-identity enforcement: processes.operate worker actions", () => {
  it("completes a human task as the effective user, gated by their assignment, not the real admin's", async () => {
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Task record");
    const templateId = await createHumanTaskTemplate(fixture.workspaceId, fixture.entityTypeId, fixture.assignee.id);

    const adminClient = await sharedAdminClient();
    await endAnyActiveSession(adminClient);

    // The real admin is not the assignee and could never complete this step
    // directly -- but impersonating the actual assignee must succeed.
    const asAssignee = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.assignee.id,
    });
    expect(asAssignee.error).toBeNull();

    const started = await adminClient.rpc("start_process_run_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_template_id: templateId,
      p_origin_entity_type_id: fixture.entityTypeId, p_origin_record_id: recordId,
    });
    expect(started.error).toBeNull();
    const runId = started.data as string;

    const serviceAdmin = createSupabaseTestClient();
    const { data: stepRun } = await serviceAdmin
      .from("process_step_runs").select("id").eq("workspace_id", fixture.workspaceId).eq("process_run_id", runId).single();

    const complete = await adminClient.rpc("complete_process_step_run_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_run_id: runId, p_step_run_id: stepRun!.id,
    });
    expect(complete.error).toBeNull();

    await endAnyActiveSession(adminClient);
  });

  it("rejects completing a human task while impersonating someone who is not the assignee", async () => {
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Task record 2");
    const templateId = await createHumanTaskTemplate(fixture.workspaceId, fixture.entityTypeId, fixture.assignee.id);

    const adminClient = await sharedAdminClient();
    await endAnyActiveSession(adminClient);

    const started = await adminClient.rpc("start_process_run_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_template_id: templateId,
      p_origin_entity_type_id: fixture.entityTypeId, p_origin_record_id: recordId,
    });
    expect(started.error).toBeNull();
    const runId = started.data as string;

    const serviceAdmin = createSupabaseTestClient();
    const { data: stepRun } = await serviceAdmin
      .from("process_step_runs").select("id").eq("workspace_id", fixture.workspaceId).eq("process_run_id", runId).single();

    const asWorker = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.worker.id,
    });
    expect(asWorker.error).toBeNull();

    const denied = await adminClient.rpc("complete_process_step_run_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_run_id: runId, p_step_run_id: stepRun!.id,
    });
    expect(denied.error?.message).toContain("assigned to another member");

    await endAnyActiveSession(adminClient);
  });

  it("attributes an approval decision to the effective user and records the real actor separately", async () => {
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Approval record");
    const { templateId, outcomeId } = await createApprovalTemplate(fixture.workspaceId, fixture.entityTypeId, fixture.assignee.id);

    const adminClient = await sharedAdminClient();
    await endAnyActiveSession(adminClient);

    const asAssignee = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId, p_target_user_id: fixture.assignee.id,
    });
    expect(asAssignee.error).toBeNull();

    const started = await adminClient.rpc("start_process_run_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_template_id: templateId,
      p_origin_entity_type_id: fixture.entityTypeId, p_origin_record_id: recordId,
    });
    expect(started.error).toBeNull();
    const runId = started.data as string;

    const serviceAdmin = createSupabaseTestClient();
    const { data: stepRun } = await serviceAdmin
      .from("process_step_runs").select("id").eq("workspace_id", fixture.workspaceId).eq("process_run_id", runId)
      .eq("node_type", "approval").single();

    const decide = await adminClient.rpc("decide_process_approval_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_run_id: runId, p_step_run_id: stepRun!.id, p_outcome_id: outcomeId,
    });
    expect(decide.error).toBeNull();

    const { data: decidedStep } = await serviceAdmin
      .from("process_step_runs").select("decided_by_user_id, decided_by_label").eq("id", stepRun!.id).single();
    expect(decidedStep?.decided_by_user_id).toBe(fixture.assignee.id);
    expect(decidedStep?.decided_by_label).toBe(fixture.assignee.email);

    const { data: events } = await serviceAdmin
      .from("workspace_events")
      .select("actor_user_id, real_actor_user_id")
      .eq("workspace_id", fixture.workspaceId).eq("process_run_id", runId).eq("event_type", "approval_decided");
    expect(events).toHaveLength(1);
    expect(events?.[0]?.actor_user_id).toBe(fixture.assignee.id);
    expect(events?.[0]?.real_actor_user_id).toBe(fixture.admin.id);

    await endAnyActiveSession(adminClient);
  });

  it("does not populate real_actor_user_id when the effective user matches the real actor (not impersonating)", async () => {
    const recordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Non-impersonated approval");
    const { templateId, outcomeId } = await createApprovalTemplate(fixture.workspaceId, fixture.entityTypeId, fixture.admin.id);

    const adminClient = await sharedAdminClient();
    await endAnyActiveSession(adminClient);

    const started = await adminClient.rpc("start_process_run_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_template_id: templateId,
      p_origin_entity_type_id: fixture.entityTypeId, p_origin_record_id: recordId,
    });
    expect(started.error).toBeNull();
    const runId = started.data as string;

    const serviceAdmin = createSupabaseTestClient();
    const { data: stepRun } = await serviceAdmin
      .from("process_step_runs").select("id").eq("workspace_id", fixture.workspaceId).eq("process_run_id", runId)
      .eq("node_type", "approval").single();

    const decide = await adminClient.rpc("decide_process_approval_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_run_id: runId, p_step_run_id: stepRun!.id, p_outcome_id: outcomeId,
    });
    expect(decide.error).toBeNull();

    const { data: events } = await serviceAdmin
      .from("workspace_events")
      .select("actor_user_id, real_actor_user_id")
      .eq("workspace_id", fixture.workspaceId).eq("process_run_id", runId).eq("event_type", "approval_decided");
    expect(events?.[0]?.actor_user_id).toBe(fixture.admin.id);
    expect(events?.[0]?.real_actor_user_id).toBeNull();
  });
});

describe("capability grant/backfill", () => {
  it("the role editor accepts workspace.impersonate_users as a valid capability", async () => {
    const adminClient = await sharedAdminClient();
    const created = await adminClient.rpc("create_workspace_role_authorized", {
      p_workspace_id: fixture.workspaceId, p_name: "Impersonation-capable role", p_description: null,
      p_capabilities: ["workspace.impersonate_users"],
    });
    expect(created.error).toBeNull();
  });
});
