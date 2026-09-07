import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };
const workspaceIds: string[] = [];
const userIds: string[] = [];
const admin = () => createSupabaseTestClient();

async function createUser(label: string): Promise<User> {
  const value = { email: `e2e-org-authority-${label}-${randomUUID()}@example.test`, password: `Org-${randomUUID()}!` };
  const { data, error } = await admin().auth.admin.createUser({ ...value, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user");
  userIds.push(data.user.id);
  return { ...value, id: data.user.id };
}

async function client(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const result = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await result.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return result;
}

async function createWorkspace(): Promise<string> {
  const id = randomUUID();
  const result = await admin().from("workspaces").insert({ id, name: `Organization authority ${id.slice(0, 8)}` });
  if (result.error) throw new Error(result.error.message);
  workspaceIds.push(id);
  return id;
}

async function createRole(workspaceId: string): Promise<string> {
  const id = randomUUID();
  const result = await admin().from("workspace_roles").insert({ id, workspace_id: workspaceId, name: `Organization administrator ${id.slice(0, 8)}` });
  if (result.error) throw new Error(result.error.message);
  const capabilities = ["workspace.manage_organization", "operations.view", "workspace.impersonate_users"];
  const grants = await admin().from("workspace_role_capabilities").insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
  if (grants.error) throw new Error(grants.error.message);
  return id;
}

async function addMember(workspaceId: string, userId: string, roleId: string) {
  const result = await admin().from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role_id: roleId });
  if (result.error) throw new Error(result.error.message);
}

async function endImpersonation(clientForAdmin: SupabaseClient) {
  const active = await clientForAdmin.rpc("get_active_impersonation_authorized");
  if (active.error) throw new Error(active.error.message);
  const session = (active.data ?? [])[0] as { session_id: string } | undefined;
  if (session) {
    const ended = await clientForAdmin.rpc("end_impersonation_session_authorized", { p_session_id: session.session_id });
    if (ended.error) throw new Error(ended.error.message);
  }
}

let workspaceId: string;
let roleId: string;
let administrator: User;
let manager: User;
let report: User;
let other: User;
let adminClient: SupabaseClient;
let managerClient: SupabaseClient;

beforeAll(async () => {
  workspaceId = await createWorkspace();
  roleId = await createRole(workspaceId);
  administrator = await createUser("administrator");
  manager = await createUser("manager");
  report = await createUser("report");
  other = await createUser("other");
  await addMember(workspaceId, administrator.id, roleId);
  await addMember(workspaceId, manager.id, roleId);
  await addMember(workspaceId, report.id, roleId);
  await addMember(workspaceId, other.id, roleId);
  adminClient = await client(administrator);
  managerClient = await client(manager);
}, 30_000);

afterAll(async () => {
  await endImpersonation(adminClient).catch(() => undefined);
  const failures: string[] = [];
  for (const id of workspaceIds) {
    const result = await admin().from("workspaces").delete().eq("id", id);
    if (result.error) failures.push(result.error.message);
  }
  for (const id of userIds) {
    const result = await admin().auth.admin.deleteUser(id);
    if (result.error) failures.push(result.error.message);
  }
  if (failures.length) throw new Error(`organization authority cleanup failed:\n${failures.join("\n")}`);
}, 30_000);

describe("workspace organization authority correction", () => {
  it("keeps every organization mutation available normally and rejects all seven while impersonating", async () => {
    const first = await adminClient.rpc("create_workspace_team_authorized", { p_workspace_id: workspaceId, p_name: "Primary", p_description: null });
    expect(first.error).toBeNull();
    const teamId = first.data as string;
    const empty = await adminClient.rpc("create_workspace_team_authorized", { p_workspace_id: workspaceId, p_name: "Empty", p_description: null });
    expect(empty.error).toBeNull();
    const emptyTeamId = empty.data as string;
    expect((await adminClient.rpc("update_workspace_team_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_name: "Renamed", p_description: "Updated" })).error).toBeNull();
    expect((await adminClient.rpc("set_workspace_team_archived_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_archived: true })).error).toBeNull();
    expect((await adminClient.rpc("set_workspace_team_archived_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_archived: false })).error).toBeNull();
    expect((await adminClient.rpc("set_workspace_team_membership_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: report.id, p_is_member: true })).error).toBeNull();
    expect((await adminClient.rpc("set_workspace_team_lead_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: report.id, p_is_lead: true })).error).toBeNull();
    expect((await adminClient.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: report.id, p_manager_user_id: manager.id })).error).toBeNull();

    const started = await adminClient.rpc("start_impersonation_session_authorized", { p_workspace_id: workspaceId, p_target_user_id: other.id });
    expect(started.error).toBeNull();
    const rejected = await Promise.all([
      adminClient.rpc("create_workspace_team_authorized", { p_workspace_id: workspaceId, p_name: "Denied", p_description: null }),
      adminClient.rpc("update_workspace_team_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_name: "Denied", p_description: null }),
      adminClient.rpc("set_workspace_team_archived_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_archived: true }),
      adminClient.rpc("delete_workspace_team_if_empty_authorized", { p_workspace_id: workspaceId, p_team_id: emptyTeamId }),
      adminClient.rpc("set_workspace_team_membership_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: other.id, p_is_member: true }),
      adminClient.rpc("set_workspace_team_lead_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: other.id, p_is_lead: true }),
      adminClient.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: other.id, p_manager_user_id: manager.id }),
    ]);
    expect(rejected.every((result) => result.error?.message.includes("Not available while impersonating"))).toBe(true);
    await endImpersonation(adminClient);
    expect((await admin().from("workspace_teams").select("id").eq("id", emptyTeamId)).data).toHaveLength(1);
  });

  it("rejects new relationships for deactivated members but preserves and cleans stale rows", async () => {
    const team = await adminClient.rpc("create_workspace_team_authorized", { p_workspace_id: workspaceId, p_name: "Deactivation", p_description: null });
    expect(team.error).toBeNull();
    const teamId = team.data as string;
    expect((await adminClient.rpc("set_workspace_team_membership_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: report.id, p_is_member: true })).error).toBeNull();
    expect((await adminClient.rpc("set_workspace_team_lead_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: report.id, p_is_lead: true })).error).toBeNull();
    const deactivated = await admin().from("workspace_memberships").update({ deactivated_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("user_id", report.id);
    expect(deactivated.error).toBeNull();
    expect((await adminClient.rpc("set_workspace_team_membership_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: report.id, p_is_member: true })).error?.message).toContain("Deactivated");
    expect((await adminClient.rpc("set_workspace_team_lead_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: report.id, p_is_lead: true })).error?.message).toContain("Deactivated");
    expect((await adminClient.rpc("set_workspace_primary_manager_authorized", { p_workspace_id: workspaceId, p_report_user_id: report.id, p_manager_user_id: manager.id })).error?.message).toContain("Deactivated");
    const rows = await admin().from("workspace_team_memberships").select("user_id").eq("workspace_id", workspaceId).eq("team_id", teamId).eq("user_id", report.id);
    expect(rows.data).toHaveLength(1);
    const leads = await admin().from("workspace_team_leads").select("user_id").eq("workspace_id", workspaceId).eq("team_id", teamId).eq("user_id", report.id);
    expect(leads.data).toHaveLength(1);
    expect((await adminClient.rpc("set_workspace_team_lead_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: report.id, p_is_lead: false })).error).toBeNull();
    expect((await adminClient.rpc("set_workspace_team_membership_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: report.id, p_is_member: false })).error).toBeNull();
  });

  it("excludes deactivated members from active manager and team scopes, then restores them on reactivation", async () => {
    const direct = await managerClient.rpc("list_my_direct_reports_authorized", { p_workspace_id: workspaceId });
    expect(direct.error).toBeNull();
    expect((direct.data ?? []).some((row: { user_id: string }) => row.user_id === report.id)).toBe(false);
    const context = await managerClient.rpc("list_managed_people_context_authorized", { p_workspace_id: workspaceId });
    expect(context.error).toBeNull();
    expect((context.data ?? []).some((row: { user_id: string }) => row.user_id === report.id)).toBe(false);
    const restored = await admin().from("workspace_memberships").update({ deactivated_at: null }).eq("workspace_id", workspaceId).eq("user_id", report.id);
    expect(restored.error).toBeNull();
    const after = await managerClient.rpc("list_my_direct_reports_authorized", { p_workspace_id: workspaceId });
    expect(after.error).toBeNull();
    expect((after.data ?? []).some((row: { user_id: string }) => row.user_id === report.id)).toBe(true);
  });
});
