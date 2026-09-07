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
  const value = { email: `e2e-team-audit-${label}-${randomUUID()}@example.test`, password: `Team-${randomUUID()}!` };
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

async function events(workspaceId: string) {
  const result = await service().from("governance_audit_events").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

let workspaceId: string;
let roleId: string;
let administrator: User;
let member: User;
let client: SupabaseClient;

beforeAll(async () => {
  workspaceId = randomUUID();
  workspaceIds.push(workspaceId);
  const workspace = await service().from("workspaces").insert({ id: workspaceId, name: `Team audit ${workspaceId.slice(0, 8)}` });
  if (workspace.error) throw new Error(workspace.error.message);
  roleId = randomUUID();
  const role = await service().from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: "Team administrator" });
  if (role.error) throw new Error(role.error.message);
  const capabilities = await service().from("workspace_role_capabilities").insert([
    { workspace_id: workspaceId, role_id: roleId, capability: "workspace.manage_organization" },
  ]);
  if (capabilities.error) throw new Error(capabilities.error.message);
  administrator = await createUser("administrator");
  member = await createUser("member");
  for (const user of [administrator, member]) {
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
  if (failures.length) throw new Error(`team governance cleanup failed:\n${failures.join("\n")}`);
}, 30_000);

describe("workspace team governance audit", () => {
  it("captures lifecycle transitions once and preserves the deleted-team snapshot", async () => {
    const before = await events(workspaceId);
    const created = await client.rpc("create_workspace_team_authorized", { p_workspace_id: workspaceId, p_name: "Review", p_description: "Initial" });
    expect(created.error).toBeNull();
    const teamId = created.data as string;
    let current = await events(workspaceId);
    expect(current.slice(before.length).map((event) => event.event_type)).toEqual(["workspace_team_created"]);

    expect((await client.rpc("update_workspace_team_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_name: "Review renamed", p_description: "Changed" })).error).toBeNull();
    expect((await client.rpc("update_workspace_team_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_name: "Review renamed", p_description: "Changed" })).error).toBeNull();
    expect((await client.rpc("set_workspace_team_archived_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_archived: true })).error).toBeNull();
    expect((await client.rpc("set_workspace_team_archived_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_archived: true })).error).toBeNull();
    expect((await client.rpc("set_workspace_team_archived_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_archived: false })).error).toBeNull();
    expect((await client.rpc("set_workspace_team_archived_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_archived: false })).error).toBeNull();
    current = await events(workspaceId);
    expect(current.slice(before.length).map((event) => event.event_type)).toEqual([
      "workspace_team_created", "workspace_team_updated", "workspace_team_archived", "workspace_team_restored",
    ]);

    const deleted = await client.rpc("delete_workspace_team_if_empty_authorized", { p_workspace_id: workspaceId, p_team_id: teamId });
    expect(deleted.error).toBeNull();
    const afterDelete = await events(workspaceId);
    const history = afterDelete.find((event) => event.subject_id === teamId && event.event_type === "workspace_team_deleted");
    expect(history?.changes.old.name).toBe("Review renamed");
    expect(history?.changes.old.description).toBe("Changed");
  });

  it("captures membership and lead mutations without join-row duplication", async () => {
    const created = await client.rpc("create_workspace_team_authorized", { p_workspace_id: workspaceId, p_name: "Operations", p_description: null });
    expect(created.error).toBeNull();
    const teamId = created.data as string;
    const before = (await events(workspaceId)).length;
    expect((await client.rpc("set_workspace_team_membership_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: member.id, p_is_member: true })).error).toBeNull();
    expect((await client.rpc("set_workspace_team_membership_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: member.id, p_is_member: true })).error).toBeNull();
    expect((await client.rpc("set_workspace_team_lead_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: member.id, p_is_lead: true })).error).toBeNull();
    expect((await client.rpc("set_workspace_team_lead_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: member.id, p_is_lead: true })).error).toBeNull();
    expect((await client.rpc("set_workspace_team_membership_authorized", { p_workspace_id: workspaceId, p_team_id: teamId, p_user_id: member.id, p_is_member: false })).error).toBeNull();
    const added = (await events(workspaceId)).slice(before).map((event) => event.event_type);
    expect(added).toEqual(["workspace_team_member_added", "workspace_team_lead_added", "workspace_team_member_removed"]);
    expect(added).not.toContain("workspace_team_lead_removed");
  });
});
