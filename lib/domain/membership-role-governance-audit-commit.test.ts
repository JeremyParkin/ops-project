import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };
const workspaceIds: string[] = [];
const userIds: string[] = [];

const admin = () => createSupabaseTestClient();
const email = (label: string) => `e2e-access-audit-${label}-${randomUUID()}@example.test`;

async function createUser(label: string, requestedEmail = email(label)): Promise<User> {
  const value = { email: requestedEmail, password: `Access-${randomUUID()}!` };
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

async function role(workspaceId: string, name: string, capabilities: string[]) {
  const roleId = randomUUID();
  const { error } = await admin().from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name });
  if (error) throw new Error(error.message);
  if (capabilities.length) {
    const result = await admin().from("workspace_role_capabilities").insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })));
    if (result.error) throw new Error(result.error.message);
  }
  return roleId;
}

async function events(workspaceId: string, eventType?: string) {
  let query = admin().from("governance_audit_events").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: true });
  if (eventType) query = query.eq("event_type", eventType);
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

let workspaceId: string;
let administrator: User;
let administratorRole: string;

beforeAll(async () => {
  workspaceId = randomUUID();
  workspaceIds.push(workspaceId);
  const created = await admin().from("workspaces").insert({ id: workspaceId, name: `Access audit ${workspaceId.slice(0, 8)}` });
  if (created.error) throw new Error(created.error.message);
  administratorRole = await role(workspaceId, "Access administrator", ["workspace.manage_members", "workspace.manage_roles"]);
  administrator = await createUser("administrator");
  const membership = await admin().from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: administrator.id, role_id: administratorRole });
  if (membership.error) throw new Error(membership.error.message);
}, 30_000);

afterAll(async () => {
  const failures: string[] = [];
  for (const id of workspaceIds) {
    const result = await admin().from("workspaces").delete().eq("id", id);
    if (result.error) failures.push(result.error.message);
  }
  for (const id of userIds) {
    const result = await admin().auth.admin.deleteUser(id);
    if (result.error) failures.push(result.error.message);
  }
  if (failures.length) throw new Error(`membership-role governance cleanup failed:\n${failures.join("\n")}`);
}, 30_000);

describe("membership and role governance audit", () => {
  it("preserves four-argument invitation email-queue compatibility", async () => {
    const adminClient = await client(administrator);
    const invitedRole = await role(workspaceId, "Queue compatibility role", []);
    const withoutEmail = email("queue-off");
    const withEmail = email("queue-on");
    const before = await events(workspaceId, "workspace_member_invited");

    const noQueue = await adminClient.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: workspaceId, p_email: withoutEmail, p_role_id: invitedRole, p_enqueue_email: false,
    });
    expect(noQueue.error).toBeNull();
    const queued = await adminClient.rpc("create_workspace_invitation_authorized", {
      p_workspace_id: workspaceId, p_email: withEmail, p_role_id: invitedRole, p_enqueue_email: true,
    });
    expect(queued.error).toBeNull();

    const invitations = await admin().from("workspace_invitations").select("id, email").eq("workspace_id", workspaceId).in("email", [withoutEmail, withEmail]);
    expect(invitations.error).toBeNull();
    const deliveryRows = await admin().from("outbound_email_deliveries").select("workspace_invitation_id, recipient_email").eq("workspace_id", workspaceId).in("recipient_email", [withoutEmail, withEmail]);
    expect(deliveryRows.error).toBeNull();
    expect(deliveryRows.data).toEqual([{ workspace_invitation_id: expect.any(String), recipient_email: withEmail }]);

    const createdEvents = (await events(workspaceId, "workspace_member_invited")).slice(before.length);
    expect(createdEvents).toHaveLength(2);
    expect(createdEvents.every((event) => event.subject_kind === "workspace_invitation")).toBe(true);
    expect(createdEvents.every((event) => event.changes.role_id === invitedRole && event.changes.role_name === "Queue compatibility role" && event.changes.status === "pending")).toBe(true);
    expect(createdEvents.every((event) => event.changes.token === undefined && event.changes.delivery_status === undefined)).toBe(true);
    expect(createdEvents.map((event) => event.changes.email).sort()).toEqual([withoutEmail, withEmail].sort());
  });

  it("audits invitation creation/cancellation and invitee activation with truthful subjects", async () => {
    const adminClient = await client(administrator);
    const beforeInvitationEvents = await events(workspaceId, "workspace_member_invited");
    const invitedEmail = email("invitee");
    const invitedRole = await role(workspaceId, "Invited member", []);
    const created = await adminClient.rpc("create_workspace_invitation_authorized", { p_workspace_id: workspaceId, p_email: invitedEmail, p_role_id: invitedRole });
    expect(created.error).toBeNull();
    const invitation = await admin().from("workspace_invitations").select("id").eq("workspace_id", workspaceId).eq("email", invitedEmail).single();
    expect(invitation.error).toBeNull();
    const cancelled = await adminClient.rpc("cancel_workspace_invitation_authorized", { p_workspace_id: workspaceId, p_invitation_id: invitation.data!.id });
    expect(cancelled.error).toBeNull();
    const invitationEvents = (await events(workspaceId, "workspace_member_invited")).slice(beforeInvitationEvents.length);
    expect(invitationEvents.filter((event) => event.subject_kind === "workspace_invitation")).toHaveLength(1);
    expect(invitationEvents[0].subject_id).toBe(invitation.data!.id);
    expect(invitationEvents[0].changes.token).toBeUndefined();

    const secondEmail = email("accepted");
    const second = await adminClient.rpc("create_workspace_invitation_authorized", { p_workspace_id: workspaceId, p_email: secondEmail, p_role_id: invitedRole });
    const invitee = await createUser("accepted", secondEmail);
    const inviteRow = await admin().from("workspace_invitations").select("id").eq("workspace_id", workspaceId).eq("email", secondEmail).single();
    const accepted = await (await client(invitee)).rpc("accept_workspace_invitation_authorized", { p_token: second.data });
    expect(accepted.error).toBeNull();
    const activation = (await events(workspaceId, "workspace_member_activated")).at(-1);
    expect(activation?.subject_id).toBe(invitee.id);
    expect(activation?.changes.invitation_id).toBe(inviteRow.data!.id);
    expect(activation?.real_actor_user_id).toBeNull();
    expect(activation?.effective_actor_user_id).toBe(invitee.id);
  });

  it("groups role definition changes and records member reassignment fan-out", async () => {
    const adminClient = await client(administrator);
    const targetRole = await role(workspaceId, "Temporary role", ["operations.view"]);
    const replacementRole = await role(workspaceId, "Replacement role", ["workspace.manage_members", "workspace.manage_roles"]);
    const member = await createUser("reassigned");
    const membership = await admin().from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: member.id, role_id: targetRole });
    if (membership.error) throw new Error(membership.error.message);

    const before = await events(workspaceId);
    const updated = await adminClient.rpc("update_workspace_role_authorized", { p_workspace_id: workspaceId, p_role_id: targetRole, p_name: "Temporary renamed", p_description: "Updated", p_capabilities: ["operations.view", "records.operate"] });
    expect(updated.error).toBeNull();
    const updateEvents = (await events(workspaceId)).filter((event) => event.event_type === "workspace_role_updated");
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0].changes.old_capabilities).toEqual(["operations.view"]);
    expect(updateEvents[0].changes.new_capabilities).toEqual(["operations.view", "records.operate"]);

    const withAuditRead = await adminClient.rpc("update_workspace_role_authorized", {
      p_workspace_id: workspaceId,
      p_role_id: targetRole,
      p_name: "Temporary renamed",
      p_description: "Updated",
      p_capabilities: ["operations.view", "records.operate", "workspace.audit.read"],
    });
    expect(withAuditRead.error).toBeNull();
    const auditReadAdded = (await events(workspaceId)).filter((event) => event.event_type === "workspace_role_updated");
    expect(auditReadAdded).toHaveLength(2);
    expect(auditReadAdded.at(-1)?.changes.old_capabilities).toEqual(["operations.view", "records.operate"]);
    expect(auditReadAdded.at(-1)?.changes.new_capabilities).toEqual(["operations.view", "records.operate", "workspace.audit.read"]);

    const withoutAuditRead = await adminClient.rpc("update_workspace_role_authorized", {
      p_workspace_id: workspaceId,
      p_role_id: targetRole,
      p_name: "Temporary renamed",
      p_description: "Updated",
      p_capabilities: ["operations.view", "records.operate"],
    });
    expect(withoutAuditRead.error).toBeNull();
    const auditReadRemoved = (await events(workspaceId)).filter((event) => event.event_type === "workspace_role_updated");
    expect(auditReadRemoved).toHaveLength(3);
    expect(auditReadRemoved.at(-1)?.changes.old_capabilities).toEqual(["operations.view", "records.operate", "workspace.audit.read"]);
    expect(auditReadRemoved.at(-1)?.changes.new_capabilities).toEqual(["operations.view", "records.operate"]);

    const noOp = await adminClient.rpc("update_workspace_role_authorized", {
      p_workspace_id: workspaceId,
      p_role_id: targetRole,
      p_name: "Temporary renamed",
      p_description: "Updated",
      p_capabilities: ["operations.view", "records.operate"],
    });
    expect(noOp.error).toBeNull();
    expect((await events(workspaceId)).filter((event) => event.event_type === "workspace_role_updated")).toHaveLength(3);

    const deleted = await adminClient.rpc("delete_workspace_role_with_reassignment_authorized", { p_workspace_id: workspaceId, p_role_id: targetRole, p_replacement_role_id: replacementRole });
    expect(deleted.error).toBeNull();
    const newEvents = (await events(workspaceId)).slice(before.length);
    expect(newEvents.filter((event) => event.event_type === "workspace_role_deleted")).toHaveLength(1);
    const memberEvents = newEvents.filter((event) => event.event_type === "workspace_member_role_changed");
    expect(memberEvents).toHaveLength(1);
    expect(memberEvents[0].subject_id).toBe(member.id);
    expect(memberEvents[0].changes.cause).toBe("role_deleted");
    expect(memberEvents[0].changes.operation_id).toBe(newEvents.find((event) => event.event_type === "workspace_role_deleted")?.changes.operation_id);
  });
});
