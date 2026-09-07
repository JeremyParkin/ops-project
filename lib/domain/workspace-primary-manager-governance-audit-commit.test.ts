import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };
const workspaceIds: string[] = [];
const userIds: string[] = [];
const service = () => createSupabaseTestClient();

async function createUser(label: string): Promise<User> {
  const value = { email: `e2e-manager-audit-${label}-${randomUUID()}@example.test`, password: `Manager-${randomUUID()}!` };
  const { data, error } = await service().auth.admin.createUser({ ...value, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user");
  userIds.push(data.user.id);
  return { ...value, id: data.user.id };
}

async function authenticated(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const result = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await result.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return result;
}

async function auditEvents(workspaceId: string) {
  const result = await service().from("governance_audit_events").select("*").eq("workspace_id", workspaceId).eq("event_type", "workspace_primary_manager_changed").order("created_at", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

let workspaceId: string;
let roleId: string;
let administrator: User;
let report: User;
let managerA: User;
let managerB: User;
let client: SupabaseClient;

beforeAll(async () => {
  workspaceId = randomUUID();
  workspaceIds.push(workspaceId);
  const workspace = await service().from("workspaces").insert({ id: workspaceId, name: `Manager audit ${workspaceId.slice(0, 8)}` });
  if (workspace.error) throw new Error(workspace.error.message);
  roleId = randomUUID();
  const role = await service().from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: "Organization administrator" });
  if (role.error) throw new Error(role.error.message);
  const capability = await service().from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability: "workspace.manage_organization" });
  if (capability.error) throw new Error(capability.error.message);
  administrator = await createUser("administrator");
  report = await createUser("report");
  managerA = await createUser("manager-a");
  managerB = await createUser("manager-b");
  for (const user of [administrator, report, managerA, managerB]) {
    const membership = await service().from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: user.id, role_id: roleId });
    if (membership.error) throw new Error(membership.error.message);
  }
  client = await authenticated(administrator);
}, 30_000);

afterAll(async () => {
  const failures: string[] = [];
  for (const id of workspaceIds) {
    const result = await service().from("workspaces").delete().eq("id", id);
    if (result.error) failures.push(result.error.message);
  }
  for (const id of userIds) {
    const result = await service().auth.admin.deleteUser(id);
    if (result.error) failures.push(result.error.message);
  }
  if (failures.length) throw new Error(`primary manager governance cleanup failed:\n${failures.join("\n")}`);
}, 30_000);

describe("primary manager governance audit", () => {
  it("captures set, replace, and clear as one event each with frozen snapshots", async () => {
    const before = (await auditEvents(workspaceId)).length;
    expect((await client.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: report.id, p_manager_user_id: managerA.id })).error).toBeNull();
    expect((await client.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: report.id, p_manager_user_id: managerB.id })).error).toBeNull();
    expect((await client.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: report.id, p_manager_user_id: null })).error).toBeNull();
    const created = (await auditEvents(workspaceId)).slice(before);
    expect(created).toHaveLength(3);
    expect(created.map((event) => event.changes.operation)).toEqual(["set", "replace", "clear"]);
    expect(created[0].subject_kind).toBe("workspace_member");
    expect(created[0].subject_id).toBe(report.id);
    expect(created[0].changes.old_manager_id).toBeNull();
    expect(created[0].changes.new_manager_id).toBe(managerA.id);
    expect(created[1].changes.old_manager_id).toBe(managerA.id);
    expect(created[1].changes.new_manager_id).toBe(managerB.id);
    expect(created[2].changes.old_manager_id).toBe(managerB.id);
    expect(created[2].changes.new_manager_id).toBeNull();
    expect(created[1].changes.old_manager_email).toBe(managerA.email);
    expect(created[1].changes.new_manager_email).toBe(managerB.email);
    expect(created[0].parent_entity_type_id).toBeNull();
    expect(created[0].parent_field_id).toBeNull();
  });

  it("suppresses semantic no-ops and emits no event for rejected validation", async () => {
    const before = (await auditEvents(workspaceId)).length;
    expect((await client.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: report.id, p_manager_user_id: null })).error).toBeNull();
    expect((await client.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: report.id, p_manager_user_id: report.id })).error?.message).toContain("own manager");
    expect((await auditEvents(workspaceId)).length).toBe(before);
    expect((await client.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: managerA.id, p_manager_user_id: managerB.id })).error).toBeNull();
    const sameBefore = (await auditEvents(workspaceId)).length;
    expect((await client.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: managerA.id, p_manager_user_id: managerB.id })).error).toBeNull();
    expect((await auditEvents(workspaceId)).length).toBe(sameBefore);
  });
});
