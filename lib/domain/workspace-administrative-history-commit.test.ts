// Focused live contract coverage for 0132. Run after the migration is applied.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };
const workspaceId = randomUUID();
const userIds: string[] = [];
let viewer: User;
let viewerClient: SupabaseClient;
type ProjectionRow = {
  event_id: string;
  event_type: string;
  details: Record<string, unknown>;
  occurred_at: string;
  source_family: string;
  source_event_id: string;
};

async function createUser(): Promise<User> {
  const password = `AdministrativeHistory-${randomUUID()}!`;
  const email = `e2e-administrative-history-${randomUUID()}@example.test`;
  const result = await createSupabaseTestClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (result.error || !result.data.user) throw new Error(result.error?.message ?? "Unable to create test user.");
  userIds.push(result.data.user.id);
  return { id: result.data.user.id, email, password };
}

async function signIn(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  const result = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (result.error) throw new Error(result.error.message);
  return client;
}

beforeAll(async () => {
  const service = createSupabaseTestClient();
  viewer = await createUser();
  const roleId = randomUUID();
  const workspace = await service.from("workspaces").insert({ id: workspaceId, name: "Administrative history" });
  if (workspace.error) throw new Error(workspace.error.message);
  const role = await service.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: "History reader" });
  if (role.error) throw new Error(role.error.message);
  const capability = await service.from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability: "workspace.audit.read" });
  if (capability.error) throw new Error(capability.error.message);
  const membership = await service.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: viewer.id, role_id: roleId });
  if (membership.error) throw new Error(membership.error.message);
  viewerClient = await signIn(viewer);
}, 30_000);

afterAll(async () => {
  const service = createSupabaseTestClient();
  await service.from("workspaces").delete().eq("id", workspaceId);
  for (const userId of userIds) await service.auth.admin.deleteUser(userId);
}, 30_000);

describe("Workspace Administrative History projection", () => {
  it("enforces the capability and returns only the curated normalized sources", async () => {
    const service = createSupabaseTestClient();
    const governanceId = randomUUID();
    const personRecordId = randomUUID();
    const personTypeId = randomUUID();
    const startedId = randomUUID();
    const excludedId = randomUUID();
    const governanceInsert = await service.from("governance_audit_events").insert({
      id: governanceId, workspace_id: workspaceId, event_type: "field_updated", subject_kind: "field",
      subject_id: randomUUID(), subject_name_snapshot: "Region", parent_entity_type_id: personTypeId,
      parent_entity_type_name_snapshot: "Client", changes: { old: { name: "Region" }, new: { name: "Market" } },
      authority_kind: "system",
    });
    expect(governanceInsert.error).toBeNull();
    const events = await service.from("workspace_events").insert([
      { id: startedId, workspace_id: workspaceId, actor_user_id: viewer.id, event_type: "impersonation_started", metadata: { session_id: randomUUID(), effective_user_id: viewer.id } },
      { id: excludedId, workspace_id: workspaceId, actor_user_id: viewer.id, event_type: "step_assigned", metadata: {} },
      { id: randomUUID(), workspace_id: workspaceId, actor_user_id: viewer.id, event_type: "person_linked", metadata: { linked_user_id: viewer.id, person_record_id: personRecordId, person_label_snapshot: "Ada" } },
    ]);
    expect(events.error).toBeNull();

    const page = await viewerClient.rpc("list_workspace_administrative_history_authorized", { p_workspace_id: workspaceId, p_limit: 20 });
    expect(page.error).toBeNull();
    const rows = (page.data ?? []) as ProjectionRow[];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.event_id.startsWith("governance:") || row.event_id.startsWith("workspace_event:"))).toBe(true);
    expect(rows.some((row) => row.event_type === "step_assigned")).toBe(false);
    expect(rows.find((row) => row.event_type === "field_updated")?.details).toEqual({ old: { name: "Region" }, new: { name: "Market" } });
  });

  it("paginates equal-timestamp rows without duplicates or gaps", async () => {
    const first = await viewerClient.rpc("list_workspace_administrative_history_authorized", { p_workspace_id: workspaceId, p_limit: 1 });
    expect(first.error).toBeNull();
    const firstRows = (first.data ?? []) as ProjectionRow[];
    expect(firstRows).toHaveLength(1);
    const last = firstRows[0];
    const second = await viewerClient.rpc("list_workspace_administrative_history_authorized", {
      p_workspace_id: workspaceId, p_limit: 20, p_after_occurred_at: last.occurred_at,
      p_after_source_family: last.source_family, p_after_source_event_id: last.source_event_id,
    });
    expect(second.error).toBeNull();
    const secondRows = (second.data ?? []) as ProjectionRow[];
    expect(secondRows.some((row) => row.event_id === firstRows[0].event_id)).toBe(false);
  });
});
