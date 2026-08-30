// DB/RPC-level coverage for Phase 8E.3 Workspace Health: one true-positive
// and one true-negative per check (no_active_fields, missing_display_field,
// recurrence_unreachable including all three "can never fire" branches,
// stuck_process_run, deactivated_assignee), the archived/inactive-rule
// exclusion guards, capability rejection, cross-workspace isolation, and a
// from-scratch healthy workspace returning zero findings. Requires
// migration 0071 applied.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };
type Finding = {
  finding_id: string;
  check_type: string;
  severity: string;
  entity_type_id: string | null;
  record_id: string | null;
  process_run_id: string | null;
  process_step_run_id: string | null;
  member_email: string | null;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

function uniqueEmail(label: string) {
  return `e2e-health-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Health-${randomUUID()}!`;
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

function fieldKeyFor(entityTypeId: string, logicalKey: string) {
  return `${logicalKey}_${entityTypeId.slice(0, 8)}`;
}

async function createEntityType(
  workspaceId: string,
  name: string,
  fields: Array<{ key: string; type: "text" | "number"; archived?: boolean }>,
) {
  const admin = createSupabaseTestClient();
  const entityTypeId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityTypeId, workspace_id: workspaceId, name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${entityTypeId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);

  // field_definitions.key is unique per WORKSPACE, not per entity type
  // (unique (workspace_id, key), unchanged since 0001) -- suffixing with
  // the entity type id keeps every field's key unique across every entity
  // type this fixture creates in the shared workspace. createRecord below
  // applies the identical transform so callers can keep passing the plain
  // logical key ("name", "amount").
  let displayFieldId: string | undefined;
  for (const [index, field] of fields.entries()) {
    const fieldId = randomUUID();
    const actualKey = fieldKeyFor(entityTypeId, field.key);
    const { error: fieldError } = await admin.from("field_definitions").insert({
      id: fieldId, workspace_id: workspaceId, entity_type_id: entityTypeId, key: actualKey, name: field.key,
      slug: field.key, type: field.type, required: false, position: index + 1,
      archived_at: field.archived ? new Date().toISOString() : null,
    });
    if (fieldError) throw new Error(fieldError.message);
    if (field.type === "text" && !field.archived && displayFieldId === undefined) displayFieldId = fieldId;
  }
  if (displayFieldId) {
    const { error: displayError } = await admin.rpc("set_entity_display_field", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_field_definition_id: displayFieldId,
    });
    if (displayError) throw new Error(displayError.message);
  }
  return entityTypeId;
}

async function archiveEntityType(workspaceId: string, entityTypeId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("entity_types").update({ archived_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", entityTypeId);
  if (error) throw new Error(error.message);
}

async function createRecord(workspaceId: string, entityTypeId: string, logicalKey: string, value: string) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin.from("entity_records").insert({
    id: recordId, workspace_id: workspaceId, entity_type_id: entityTypeId, values: { [fieldKeyFor(entityTypeId, logicalKey)]: value },
  });
  if (error) throw new Error(error.message);
  return recordId;
}

async function archiveRecord(workspaceId: string, recordId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("entity_records").update({ archived_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", recordId);
  if (error) throw new Error(error.message);
}

async function createProcessTemplate(workspaceId: string, entityTypeId: string, assigneeUserId?: string) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId, workspace_id: workspaceId, name: `Health template ${templateId.slice(0, 8)}`, applies_to_entity_type_id: entityTypeId,
  });
  if (templateError) throw new Error(templateError.message);
  const { error: nodeError } = await admin.from("process_nodes").insert({
    id: randomUUID(), workspace_id: workspaceId, process_template_id: templateId, node_type: "human_task",
    name: "Review", position: 1, assignee_user_id: assigneeUserId ?? null, config: {},
  });
  if (nodeError) throw new Error(nodeError.message);
  return templateId;
}

async function archiveProcessTemplate(workspaceId: string, templateId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("process_templates").update({ archived_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", templateId);
  if (error) throw new Error(error.message);
}

async function createRecurrenceRule(
  workspaceId: string,
  templateId: string,
  entityTypeId: string,
  recordId: string,
  options: { active?: boolean; endDate?: string } = {},
) {
  const admin = createSupabaseTestClient();
  const ruleId = randomUUID();
  const { error } = await admin.from("process_recurrence_rules").insert({
    id: ruleId, workspace_id: workspaceId, process_template_id: templateId,
    origin_entity_type_id: entityTypeId, origin_record_id: recordId,
    frequency: "daily", interval_count: 1, start_date: "2020-01-01", time_of_day: "09:00:00",
    active: options.active ?? true, end_date: options.endDate ?? null,
  });
  if (error) throw new Error(error.message);
  return ruleId;
}

async function findings(workspaceId: string, client?: SupabaseClient): Promise<Finding[]> {
  const supabase = client ?? (await sharedAdminClient());
  const { data, error } = await supabase.rpc("list_workspace_health_findings_authorized", { p_workspace_id: workspaceId });
  if (error) throw new Error(error.message);
  return (data ?? []) as Finding[];
}

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  manageSettingsRoleId: string;
  workerRoleId: string;
  admin: User;
  worker: User;
};

let fixture: Fixture;

beforeAll(async () => {
  const workspaceId = await createWorkspace("E2E Health");
  const otherWorkspaceId = await createWorkspace("E2E Health Other");

  // Also needs processes.operate (to start real process runs via
  // start_process_run_authorized) and both workspace.manage_members and
  // workspace.manage_roles (to deactivate a member via
  // deactivate_workspace_member_authorized -- the last-admin guard,
  // assert_workspace_administrator, requires at least one active member
  // holding BOTH capabilities together, or the deactivation itself is
  // rejected as leaving the workspace without a qualifying admin). The
  // admin fixture is reused for all of this, not just to read Health.
  const manageSettingsRoleId = await createRole(workspaceId, "Settings Manager", [
    "workspace.manage_settings", "processes.operate", "workspace.manage_members", "workspace.manage_roles",
  ]);
  const workerRoleId = await createRole(workspaceId, "Worker", ["records.operate", "processes.operate"]);
  const otherRoleId = await createRole(otherWorkspaceId, "Settings Manager", ["workspace.manage_settings"]);

  const admin = await createUser("admin");
  const worker = await createUser("worker");
  const otherMember = await createUser("other-member");

  await addMembership(workspaceId, admin.id, manageSettingsRoleId);
  await addMembership(workspaceId, worker.id, workerRoleId);
  await addMembership(otherWorkspaceId, otherMember.id, otherRoleId);

  fixture = { workspaceId, otherWorkspaceId, manageSettingsRoleId, workerRoleId, admin, worker };
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
    throw new Error(`workspace-health-commit afterAll cleanup: ${failures.length} failure(s):\n${failures.join("\n")}`);
  }
}, 30_000);

describe("authorization", () => {
  it("requires workspace.manage_settings", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const result = await workerClient.rpc("list_workspace_health_findings_authorized", { p_workspace_id: fixture.workspaceId });
    expect(result.error?.message).toContain("workspace.manage_settings");
  });

  it("rejects a caller from a different workspace", async () => {
    const adminClient = await sharedAdminClient();
    const result = await adminClient.rpc("list_workspace_health_findings_authorized", { p_workspace_id: fixture.otherWorkspaceId });
    expect(result.error?.message).toContain("Workspace access denied");
  });
});

describe("no_active_fields", () => {
  it("flags an active object with zero active fields, and only that check", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Empty Object", []);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.entity_type_id === entityTypeId);
    expect(rows.map((r) => r.check_type)).toEqual(["no_active_fields"]);
  });

  it("does not flag an object with at least one active field", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Numeric Only", [{ key: "amount", type: "number" }]);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.entity_type_id === entityTypeId && f.check_type === "no_active_fields");
    expect(rows).toEqual([]);
  });

  it("does not flag an archived object even with zero fields", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Archived Empty", []);
    await archiveEntityType(fixture.workspaceId, entityTypeId);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.entity_type_id === entityTypeId);
    expect(rows).toEqual([]);
  });
});

describe("missing_display_field", () => {
  it("flags an object with active fields but no active text field, and only that check", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Numeric Only 2", [{ key: "amount", type: "number" }]);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.entity_type_id === entityTypeId);
    expect(rows.map((r) => r.check_type)).toEqual(["missing_display_field"]);
  });

  it("does not flag an object with an active text field", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Healthy Object", [{ key: "name", type: "text" }]);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.entity_type_id === entityTypeId);
    expect(rows).toEqual([]);
  });

  it("does not flag an object whose only text field is archived, as long as it also has zero active fields overall (no_active_fields instead)", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Archived Text Only", [{ key: "name", type: "text", archived: true }]);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.entity_type_id === entityTypeId);
    expect(rows.map((r) => r.check_type)).toEqual(["no_active_fields"]);
  });
});

describe("recurrence_unreachable", () => {
  it("flags a rule whose process template is archived", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Recurrence Origin A", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Origin A");
    const templateId = await createProcessTemplate(fixture.workspaceId, entityTypeId);
    await archiveProcessTemplate(fixture.workspaceId, templateId);
    const ruleId = await createRecurrenceRule(fixture.workspaceId, templateId, entityTypeId, recordId);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.record_id === recordId);
    expect(rows.map((r) => r.check_type)).toEqual(["recurrence_unreachable"]);
    expect(rows[0].finding_id).toBe(`recurrence_unreachable:${ruleId}`);
  });

  it("flags a rule whose origin record is archived", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Recurrence Origin B", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Origin B");
    const templateId = await createProcessTemplate(fixture.workspaceId, entityTypeId);
    await createRecurrenceRule(fixture.workspaceId, templateId, entityTypeId, recordId);
    await archiveRecord(fixture.workspaceId, recordId);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.record_id === recordId);
    expect(rows.map((r) => r.check_type)).toEqual(["recurrence_unreachable"]);
  });

  it("flags a rule whose end date has already passed", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Recurrence Origin C", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Origin C");
    const templateId = await createProcessTemplate(fixture.workspaceId, entityTypeId);
    await createRecurrenceRule(fixture.workspaceId, templateId, entityTypeId, recordId, { endDate: "2020-01-02" });
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.record_id === recordId);
    expect(rows.map((r) => r.check_type)).toEqual(["recurrence_unreachable"]);
  });

  it("does not flag a healthy active rule with a valid template, active origin, and no expired end date", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Recurrence Origin D", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Origin D");
    const templateId = await createProcessTemplate(fixture.workspaceId, entityTypeId);
    await createRecurrenceRule(fixture.workspaceId, templateId, entityTypeId, recordId);
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.record_id === recordId);
    expect(rows).toEqual([]);
  });

  it("does not flag an inactive rule even if its template is archived", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Recurrence Origin E", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Origin E");
    const templateId = await createProcessTemplate(fixture.workspaceId, entityTypeId);
    await archiveProcessTemplate(fixture.workspaceId, templateId);
    await createRecurrenceRule(fixture.workspaceId, templateId, entityTypeId, recordId, { active: false });
    const rows = (await findings(fixture.workspaceId)).filter((f) => f.record_id === recordId);
    expect(rows).toEqual([]);
  });
});

describe("stuck_process_run", () => {
  it("flags an active run whose only step is already completed", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Stuck Origin A", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Stuck A");
    const admin = createSupabaseTestClient();
    const runId = randomUUID();
    const { error: runError } = await admin.from("process_runs").insert({
      id: runId, workspace_id: fixture.workspaceId, process_template_id: (await createProcessTemplate(fixture.workspaceId, entityTypeId)),
      process_template_name: "Stuck template", origin_entity_type_id: entityTypeId, origin_record_id: recordId, status: "active",
    });
    if (runError) throw new Error(runError.message);
    const { error: stepError } = await admin.from("process_step_runs").insert({
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runId, step_index: 1, node_type: "human_task",
      name: "Review", status: "completed", started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    });
    if (stepError) throw new Error(stepError.message);

    const rows = (await findings(fixture.workspaceId)).filter((f) => f.process_run_id === runId);
    expect(rows.map((r) => r.check_type)).toEqual(["stuck_process_run"]);
  });

  it("does not flag an active run with a pending step", async () => {
    const entityTypeId = await createEntityType(fixture.workspaceId, "Stuck Origin B", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Stuck B");
    const admin = createSupabaseTestClient();
    const runId = randomUUID();
    const { error: runError } = await admin.from("process_runs").insert({
      id: runId, workspace_id: fixture.workspaceId, process_template_id: (await createProcessTemplate(fixture.workspaceId, entityTypeId)),
      process_template_name: "Healthy template", origin_entity_type_id: entityTypeId, origin_record_id: recordId, status: "active",
    });
    if (runError) throw new Error(runError.message);
    const { error: stepError } = await admin.from("process_step_runs").insert({
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runId, step_index: 1, node_type: "human_task",
      name: "Review", status: "pending",
    });
    if (stepError) throw new Error(stepError.message);

    const rows = (await findings(fixture.workspaceId)).filter((f) => f.process_run_id === runId);
    expect(rows).toEqual([]);
  });
});

describe("deactivated_assignee", () => {
  it("flags an active step assigned to a now-deactivated member", async () => {
    const target = await createUser("assignee-target");
    await addMembership(fixture.workspaceId, target.id, fixture.workerRoleId);
    const entityTypeId = await createEntityType(fixture.workspaceId, "Assignee Origin A", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Assignee A");
    const templateId = await createProcessTemplate(fixture.workspaceId, entityTypeId, target.id);

    const adminClient = await sharedAdminClient();
    const started = await adminClient.rpc("start_process_run_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_template_id: templateId,
      p_origin_entity_type_id: entityTypeId, p_origin_record_id: recordId,
    });
    expect(started.error).toBeNull();
    const runId = started.data as string;

    const deactivate = await adminClient.rpc("deactivate_workspace_member_authorized", {
      p_workspace_id: fixture.workspaceId, p_user_id: target.id,
    });
    expect(deactivate.error).toBeNull();

    const rows = (await findings(fixture.workspaceId)).filter((f) => f.process_run_id === runId);
    expect(rows.map((r) => r.check_type)).toEqual(["deactivated_assignee"]);
    expect(rows[0].member_email).toBe(target.email);
  });

  it("does not flag an active step assigned to an active member", async () => {
    const target = await createUser("assignee-active");
    await addMembership(fixture.workspaceId, target.id, fixture.workerRoleId);
    const entityTypeId = await createEntityType(fixture.workspaceId, "Assignee Origin B", [{ key: "name", type: "text" }]);
    const recordId = await createRecord(fixture.workspaceId, entityTypeId, "name", "Assignee B");
    const templateId = await createProcessTemplate(fixture.workspaceId, entityTypeId, target.id);

    const adminClient = await sharedAdminClient();
    const started = await adminClient.rpc("start_process_run_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_template_id: templateId,
      p_origin_entity_type_id: entityTypeId, p_origin_record_id: recordId,
    });
    expect(started.error).toBeNull();
    const runId = started.data as string;

    const rows = (await findings(fixture.workspaceId)).filter((f) => f.process_run_id === runId);
    expect(rows).toEqual([]);
  });
});

describe("healthy workspace", () => {
  it("returns no findings for a workspace with no structural problems", async () => {
    const freshWorkspaceId = await createWorkspace("E2E Health Clean");
    const roleId = await createRole(freshWorkspaceId, "Settings Manager", ["workspace.manage_settings"]);
    const cleanAdmin = await createUser("clean-admin");
    await addMembership(freshWorkspaceId, cleanAdmin.id, roleId);
    const entityTypeId = await createEntityType(freshWorkspaceId, "Healthy Only", [{ key: "name", type: "text" }]);
    await createRecord(freshWorkspaceId, entityTypeId, "name", "Fine");

    const cleanAdminClient = await authenticatedClient(cleanAdmin);
    const rows = await findings(freshWorkspaceId, cleanAdminClient);
    expect(rows).toEqual([]);
  });
});
