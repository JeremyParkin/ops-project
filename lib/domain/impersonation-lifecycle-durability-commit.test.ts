// Focused Phase 13.2 verification for required impersonation lifecycle
// evidence. Broader effective-identity and authority coverage remains in
// impersonation-commit.test.ts.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

const workspaceId = randomUUID();
const userIds: string[] = [];
let admin: User;
let targetA: User;
let targetB: User;
let adminClient: SupabaseClient;

async function createUser(label: string): Promise<User> {
  const password = `ImpersonationDurability-${randomUUID()}!`;
  const email = `e2e-impersonation-durability-${label}-${randomUUID()}@example.test`;
  const result = await createSupabaseTestClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (result.error || !result.data.user) throw new Error(result.error?.message ?? "Unable to create test user.");
  userIds.push(result.data.user.id);
  return { id: result.data.user.id, email, password };
}

async function signIn(user: User) {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  const result = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (result.error) throw new Error(result.error.message);
  return client;
}

async function endActiveSession() {
  const active = await adminClient.rpc("get_active_impersonation_authorized");
  const session = (active.data ?? [])[0] as { session_id: string } | undefined;
  if (session) await adminClient.rpc("end_impersonation_session_authorized", { p_session_id: session.session_id });
}

async function lifecycleEvent(sessionId: string, eventType: "impersonation_started" | "impersonation_ended") {
  return createSupabaseTestClient()
    .from("workspace_events")
    .select("workspace_id, actor_user_id, event_type, metadata")
    .eq("workspace_id", workspaceId)
    .eq("event_type", eventType)
    .contains("metadata", { session_id: sessionId })
    .single();
}

beforeAll(async () => {
  const service = createSupabaseTestClient();
  const workspace = await service.from("workspaces").insert({ id: workspaceId, name: "Impersonation durability" });
  if (workspace.error) throw new Error(workspace.error.message);

  const roleId = randomUUID();
  const role = await service.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: "Administrator" });
  if (role.error) throw new Error(role.error.message);
  const capability = await service.from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability: "workspace.impersonate_users" });
  if (capability.error) throw new Error(capability.error.message);

  const targetRoleId = randomUUID();
  const targetRole = await service.from("workspace_roles").insert({ id: targetRoleId, workspace_id: workspaceId, name: "Worker" });
  if (targetRole.error) throw new Error(targetRole.error.message);

  admin = await createUser("admin");
  targetA = await createUser("target-a");
  targetB = await createUser("target-b");
  const memberships = await service.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: admin.id, role_id: roleId },
    { workspace_id: workspaceId, user_id: targetA.id, role_id: targetRoleId },
    { workspace_id: workspaceId, user_id: targetB.id, role_id: targetRoleId },
  ]);
  if (memberships.error) throw new Error(memberships.error.message);
  adminClient = await signIn(admin);
}, 30_000);

beforeEach(async () => {
  await endActiveSession();
}, 15_000);

afterAll(async () => {
  const service = createSupabaseTestClient();
  await service.from("workspaces").delete().eq("id", workspaceId);
  for (const userId of userIds) await service.auth.admin.deleteUser(userId);
}, 30_000);

describe("impersonation lifecycle durability", () => {
  it("correlates a valid start and explicit end to one session", async () => {
    const started = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: workspaceId, p_target_user_id: targetA.id,
    });
    expect(started.error).toBeNull();
    const sessionId = started.data as string;

    const startEvent = await lifecycleEvent(sessionId, "impersonation_started");
    expect(startEvent.error).toBeNull();
    expect(startEvent.data).toEqual(expect.objectContaining({ workspace_id: workspaceId, actor_user_id: admin.id }));
    expect(startEvent.data?.metadata).toEqual(expect.objectContaining({ session_id: sessionId, effective_user_id: targetA.id }));

    const ended = await adminClient.rpc("end_impersonation_session_authorized", { p_session_id: sessionId });
    expect(ended.error).toBeNull();
    const endEvent = await lifecycleEvent(sessionId, "impersonation_ended");
    expect(endEvent.error).toBeNull();
    expect(endEvent.data).toEqual(expect.objectContaining({ workspace_id: workspaceId, actor_user_id: admin.id }));
    expect(endEvent.data?.metadata).toEqual(expect.objectContaining({ session_id: sessionId, effective_user_id: targetA.id, reason: "explicit_end" }));
  });

  it("records replacement end before the new start", async () => {
    const first = await adminClient.rpc("start_impersonation_session_authorized", { p_workspace_id: workspaceId, p_target_user_id: targetA.id });
    expect(first.error).toBeNull();
    const firstSessionId = first.data as string;
    const second = await adminClient.rpc("start_impersonation_session_authorized", { p_workspace_id: workspaceId, p_target_user_id: targetB.id });
    expect(second.error).toBeNull();
    const secondSessionId = second.data as string;

    const replacement = await lifecycleEvent(firstSessionId, "impersonation_ended");
    expect(replacement.error).toBeNull();
    expect(replacement.data?.metadata).toEqual(expect.objectContaining({
      session_id: firstSessionId, effective_user_id: targetA.id, reason: "replaced_by_new_session",
    }));
    const replacementRows = await createSupabaseTestClient().from("workspace_events").select("id")
      .eq("workspace_id", workspaceId).eq("event_type", "impersonation_ended").contains("metadata", { session_id: firstSessionId });
    expect(replacementRows.data).toHaveLength(1);
    expect((await lifecycleEvent(secondSessionId, "impersonation_started")).error).toBeNull();
  });

  it("records target-deactivation cleanup exactly once", async () => {
    const started = await adminClient.rpc("start_impersonation_session_authorized", { p_workspace_id: workspaceId, p_target_user_id: targetA.id });
    expect(started.error).toBeNull();
    const sessionId = started.data as string;
    const service = createSupabaseTestClient();
    const deactivated = await service.from("workspace_memberships").update({ deactivated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId).eq("user_id", targetA.id);
    expect(deactivated.error).toBeNull();

    expect((await adminClient.rpc("get_active_impersonation_authorized")).data).toEqual([]);
    expect((await adminClient.rpc("get_active_impersonation_authorized")).data).toEqual([]);
    const ended = await service.from("workspace_events").select("metadata").eq("workspace_id", workspaceId)
      .eq("event_type", "impersonation_ended").contains("metadata", { session_id: sessionId });
    expect(ended.error).toBeNull();
    expect(ended.data).toHaveLength(1);
    expect(ended.data?.[0].metadata).toEqual(expect.objectContaining({ session_id: sessionId, reason: "target_deactivated" }));
  });
});
