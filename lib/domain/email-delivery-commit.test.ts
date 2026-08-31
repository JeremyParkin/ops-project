// DB/RPC-level coverage for Phase 8F.4 Outbound Email / Provider
// Infrastructure: invitation email enqueue atomicity, generation superseding,
// closed raw tables, capability/workspace boundaries, final prepare gate, and
// dispatcher claim/record retry behavior. Requires migration 0076 applied.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };
type DeliveryRow = {
  id: string;
  workspace_id: string;
  workspace_invitation_id: string;
  invitation_generation_id: string;
  recipient_email: string;
  status: "pending" | "accepted" | "failed" | "superseded";
  attempts: number;
  next_attempt_at: string;
  last_attempted_at: string | null;
  last_response_status: number | null;
  last_failure_summary: string | null;
  provider_message_id: string | null;
};
type InvitationRow = {
  id: string;
  token: string;
  email_generation_id: string;
  status: "pending" | "accepted" | "cancelled";
  expires_at: string;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];

  if (createdWorkspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) failures.push(error.message);
  }
  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) failures.push(`${userId}: ${error.message}`);
  }

  if (failures.length > 0) {
    throw new Error(`email-delivery-commit afterAll cleanup: ${failures.length} failure(s):\n${failures.join("\n")}`);
  }
}, 30_000);

function uniqueEmail(label: string) {
  return `e2e-email-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Email-${randomUUID()}!`;
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

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error } = await admin.from("workspaces").insert({ id: workspaceId, name: `${name} ${workspaceId.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function addMember(workspaceId: string, userId: string, roleId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role_id: roleId });
  if (error) throw new Error(error.message);
}

async function memberWithCapabilities(workspaceId: string, capabilities: string[]) {
  const user = await createUser(capabilities.length ? "with-cap" : "no-cap");
  const roleId = await createRole(workspaceId, `Role ${randomUUID().slice(0, 8)}`, capabilities);
  await addMember(workspaceId, user.id, roleId);
  return authenticatedClient(user);
}

async function createInvitation({
  client,
  workspaceId,
  roleId,
  email = uniqueEmail("invitee"),
  enqueueEmail = true,
}: {
  client: SupabaseClient;
  workspaceId: string;
  roleId: string;
  email?: string;
  enqueueEmail?: boolean;
}) {
  const { data: token, error } = await client.rpc("create_workspace_invitation_authorized", {
    p_workspace_id: workspaceId,
    p_email: email,
    p_role_id: roleId,
    p_enqueue_email: enqueueEmail,
  });
  expect(error).toBeNull();

  const admin = createSupabaseTestClient();
  const { data: invitation, error: invitationError } = await admin
    .from("workspace_invitations")
    .select("id, token, email_generation_id, status, expires_at")
    .eq("workspace_id", workspaceId)
    .eq("email", email)
    .single();
  expect(invitationError).toBeNull();

  return { email, token: token as string, invitation: invitation as InvitationRow };
}

async function deliveryRowsForInvitation(invitationId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("outbound_email_deliveries")
    .select("*")
    .eq("workspace_invitation_id", invitationId)
    .order("created_at", { ascending: true });
  expect(error).toBeNull();
  return (data ?? []) as DeliveryRow[];
}

async function currentDeliveryForInvitation(invitationId: string) {
  const deliveries = await deliveryRowsForInvitation(invitationId);
  expect(deliveries.filter((delivery) => delivery.status === "pending")).toHaveLength(1);
  return deliveries.find((delivery) => delivery.status === "pending")!;
}

async function prepare(deliveryId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.rpc("prepare_workspace_invitation_email_delivery_system", {
    p_delivery_id: deliveryId,
  });
  expect(error).toBeNull();
  return data ?? [];
}

describe("invitation email enqueue", () => {
  it("creates exactly one current-generation delivery atomically when enqueue is enabled", async () => {
    const workspaceId = await createWorkspace("Email Atomic Create");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);

    const { email, invitation } = await createInvitation({ client: builder, workspaceId, roleId });
    const deliveries = await deliveryRowsForInvitation(invitation.id);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      workspace_id: workspaceId,
      workspace_invitation_id: invitation.id,
      invitation_generation_id: invitation.email_generation_id,
      recipient_email: email,
      status: "pending",
      attempts: 0,
    });
    expect(JSON.stringify(deliveries[0])).not.toContain(invitation.token);
  });

  it("preserves manual mode by creating no delivery when enqueue is disabled", async () => {
    const workspaceId = await createWorkspace("Email Manual Create");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);

    const { invitation } = await createInvitation({ client: builder, workspaceId, roleId, enqueueEmail: false });
    await expect(deliveryRowsForInvitation(invitation.id)).resolves.toHaveLength(0);
  });

  it("resend rotates token and generation, supersedes the previous pending delivery, and creates one new delivery", async () => {
    const workspaceId = await createWorkspace("Email Resend");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const admin = createSupabaseTestClient();

    const { token: originalToken, invitation } = await createInvitation({ client: builder, workspaceId, roleId });
    const originalGenerationId = invitation.email_generation_id;

    const { data: newToken, error } = await builder.rpc("resend_workspace_invitation_authorized", {
      p_workspace_id: workspaceId,
      p_invitation_id: invitation.id,
      p_enqueue_email: true,
    });
    expect(error).toBeNull();
    expect(newToken).not.toBe(originalToken);

    const { data: updatedInvitation } = await admin
      .from("workspace_invitations")
      .select("token, email_generation_id")
      .eq("id", invitation.id)
      .single();
    expect(updatedInvitation?.email_generation_id).not.toBe(originalGenerationId);

    const deliveries = await deliveryRowsForInvitation(invitation.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.filter((delivery) => delivery.status === "superseded" && delivery.invitation_generation_id === originalGenerationId)).toHaveLength(1);
    expect(deliveries.filter((delivery) => delivery.status === "pending" && delivery.invitation_generation_id === updatedInvitation?.email_generation_id)).toHaveLength(1);
  });

  it("enforces current-generation uniqueness as the durable idempotency identity", async () => {
    const workspaceId = await createWorkspace("Email Unique Generation");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const admin = createSupabaseTestClient();
    const { invitation } = await createInvitation({ client: builder, workspaceId, roleId });
    const delivery = await currentDeliveryForInvitation(invitation.id);

    const { error } = await admin.from("outbound_email_deliveries").insert({
      workspace_id: workspaceId,
      purpose: "workspace_invitation",
      workspace_invitation_id: invitation.id,
      invitation_generation_id: delivery.invitation_generation_id,
      recipient_email: delivery.recipient_email,
    });
    expect(error?.message).toMatch(/duplicate key|unique/i);
  });
});

describe("email delivery access boundaries", () => {
  it("keeps raw outbound_email_deliveries access closed to authenticated callers", async () => {
    const workspaceId = await createWorkspace("Email Raw Closed");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    await createInvitation({ client: builder, workspaceId, roleId });

    const rawRead = await builder.from("outbound_email_deliveries").select("*").eq("workspace_id", workspaceId);
    expect(rawRead.error).not.toBeNull();
    expect(rawRead.error?.message).toMatch(/permission denied|violates row-level security/i);
  });

  it("gates delivery log access on workspace.manage_members and workspace membership", async () => {
    const workspaceId = await createWorkspace("Email Boundaries A");
    const otherWorkspaceId = await createWorkspace("Email Boundaries B");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const viewer = await memberWithCapabilities(workspaceId, ["operations.view"]);
    await createInvitation({ client: builder, workspaceId, roleId });

    const allowed = await builder.rpc("list_outbound_email_deliveries_authorized", {
      p_workspace_id: workspaceId,
      p_limit: 50,
    });
    expect(allowed.error).toBeNull();
    expect(allowed.data).toHaveLength(1);

    const denied = await viewer.rpc("list_outbound_email_deliveries_authorized", {
      p_workspace_id: workspaceId,
      p_limit: 50,
    });
    expect(denied.error?.message).toContain("workspace.manage_members");

    const crossWorkspace = await builder.rpc("list_outbound_email_deliveries_authorized", {
      p_workspace_id: otherWorkspaceId,
      p_limit: 50,
    });
    expect(crossWorkspace.error?.message).toContain("Workspace access denied");
  });
});

describe("prepare_workspace_invitation_email_delivery_system", () => {
  it("returns only the current authoritative token plus minimal render context", async () => {
    const workspaceId = await createWorkspace("Email Prepare Current");
    const roleId = await createRole(workspaceId, "Reviewer", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const { invitation, token, email } = await createInvitation({ client: builder, workspaceId, roleId });
    const delivery = await currentDeliveryForInvitation(invitation.id);

    const prepared = await prepare(delivery.id);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      delivery_id: delivery.id,
      workspace_id: workspaceId,
      invitation_id: invitation.id,
      invitation_token: token,
      recipient_email: email,
      role_name: "Reviewer",
    });
    expect(prepared[0]).not.toHaveProperty("subject");
    expect(prepared[0]).not.toHaveProperty("text_body");
    expect(prepared[0]).not.toHaveProperty("html_body");
  });

  it("refuses and marks a stale generation superseded", async () => {
    const workspaceId = await createWorkspace("Email Prepare Stale");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const admin = createSupabaseTestClient();
    const { invitation } = await createInvitation({ client: builder, workspaceId, roleId });
    const staleDelivery = await currentDeliveryForInvitation(invitation.id);

    await admin.from("workspace_invitations").update({ email_generation_id: randomUUID() }).eq("id", invitation.id);
    await expect(prepare(staleDelivery.id)).resolves.toHaveLength(0);

    const { data: row } = await admin.from("outbound_email_deliveries").select("status").eq("id", staleDelivery.id).single();
    expect(row?.status).toBe("superseded");
  });

  it("refuses cancelled, expired, and already-superseded deliveries", async () => {
    const workspaceId = await createWorkspace("Email Prepare Invalid");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const admin = createSupabaseTestClient();

    const cancelled = await createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("cancelled") });
    const cancelledDelivery = await currentDeliveryForInvitation(cancelled.invitation.id);
    await builder.rpc("cancel_workspace_invitation_authorized", {
      p_workspace_id: workspaceId,
      p_invitation_id: cancelled.invitation.id,
    });
    await expect(prepare(cancelledDelivery.id)).resolves.toHaveLength(0);
    const { data: cancelledRow } = await admin.from("outbound_email_deliveries").select("status").eq("id", cancelledDelivery.id).single();
    expect(cancelledRow?.status).toBe("superseded");

    const expired = await createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("expired") });
    const expiredDelivery = await currentDeliveryForInvitation(expired.invitation.id);
    await admin.from("workspace_invitations").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", expired.invitation.id);
    await expect(prepare(expiredDelivery.id)).resolves.toHaveLength(0);
    const { data: expiredRow } = await admin.from("outbound_email_deliveries").select("status").eq("id", expiredDelivery.id).single();
    expect(expiredRow?.status).toBe("failed");

    const superseded = await createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("superseded") });
    const supersededDelivery = await currentDeliveryForInvitation(superseded.invitation.id);
    await admin.from("outbound_email_deliveries").update({ status: "superseded" }).eq("id", supersededDelivery.id);
    await expect(prepare(supersededDelivery.id)).resolves.toHaveLength(0);
  });
});

describe("email dispatcher claim and recording RPCs", () => {
  it("claims a bounded due batch, leases rows, and does not reclaim them immediately", async () => {
    const workspaceId = await createWorkspace("Email Claim");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const admin = createSupabaseTestClient();
    const invitations = await Promise.all([
      createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("claim-a") }),
      createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("claim-b") }),
      createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("claim-c") }),
    ]);
    const deliveryRows = await Promise.all(invitations.map((item) => currentDeliveryForInvitation(item.invitation.id)));
    const deliveryIds = new Set(deliveryRows.map((row) => row.id));
    await admin
      .from("outbound_email_deliveries")
      .update({ next_attempt_at: "2000-01-01T00:00:00.000Z" })
      .in("id", deliveryRows.map((row) => row.id));

    const { data: claimed, error } = await admin.rpc("claim_due_outbound_email_deliveries_system", { p_limit: 2 });
    expect(error).toBeNull();
    const ours = (claimed ?? []).filter((row: { delivery_id: string }) => deliveryIds.has(row.delivery_id));
    expect(ours).toHaveLength(2);

    const { data: reclaimed } = await admin.rpc("claim_due_outbound_email_deliveries_system", { p_limit: 200 });
    const reclaimedOurs = (reclaimed ?? []).filter((row: { delivery_id: string }) => deliveryIds.has(row.delivery_id));
    expect(reclaimedOurs).toHaveLength(1);

    const { data: leasedRows } = await admin.from("outbound_email_deliveries").select("id, next_attempt_at").in("id", ours.map((row: { delivery_id: string }) => row.delivery_id));
    expect(leasedRows).toHaveLength(2);
    for (const row of leasedRows ?? []) {
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
    }
  });

  it("uses skip-locked semantics so concurrent claims do not return duplicate delivery ids", async () => {
    const workspaceId = await createWorkspace("Email Concurrent Claim");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const admin = createSupabaseTestClient();
    const invitations = await Promise.all([
      createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("concurrent-a") }),
      createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("concurrent-b") }),
    ]);
    const deliveryRows = await Promise.all(invitations.map((item) => currentDeliveryForInvitation(item.invitation.id)));
    const deliveryIds = new Set(deliveryRows.map((row) => row.id));
    await admin
      .from("outbound_email_deliveries")
      .update({ next_attempt_at: "1999-01-01T00:00:00.000Z" })
      .in("id", deliveryRows.map((row) => row.id));

    const [first, second] = await Promise.all([
      admin.rpc("claim_due_outbound_email_deliveries_system", { p_limit: 1 }),
      admin.rpc("claim_due_outbound_email_deliveries_system", { p_limit: 1 }),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    const claimed = [...(first.data ?? []), ...(second.data ?? [])]
      .map((row: { delivery_id: string }) => row.delivery_id)
      .filter((id) => deliveryIds.has(id));
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("records accepted, retryable, retry-after, terminal, and max-attempt outcomes", async () => {
    const workspaceId = await createWorkspace("Email Outcomes");
    const roleId = await createRole(workspaceId, "Member", []);
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_members"]);
    const admin = createSupabaseTestClient();

    const accepted = await createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("accepted") });
    const acceptedDelivery = await currentDeliveryForInvitation(accepted.invitation.id);
    const acceptedResult = await admin.rpc("record_outbound_email_delivery_attempt_system", {
      p_delivery_id: acceptedDelivery.id,
      p_accepted: true,
      p_response_status: 202,
      p_failure_summary: null,
      p_retryable: false,
      p_retry_after_seconds: null,
      p_provider_message_id: "email_accepted",
    });
    expect(acceptedResult.error).toBeNull();
    const { data: acceptedRow } = await admin.from("outbound_email_deliveries").select("status, attempts, provider_message_id").eq("id", acceptedDelivery.id).single();
    expect(acceptedRow).toMatchObject({ status: "accepted", attempts: 1, provider_message_id: "email_accepted" });

    const retry = await createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("retry") });
    const retryDelivery = await currentDeliveryForInvitation(retry.invitation.id);
    const retryBefore = Date.now();
    await admin.rpc("record_outbound_email_delivery_attempt_system", {
      p_delivery_id: retryDelivery.id,
      p_accepted: false,
      p_response_status: 503,
      p_failure_summary: "Received HTTP 503",
      p_retryable: true,
      p_retry_after_seconds: null,
      p_provider_message_id: null,
    });
    const { data: retryRow } = await admin.from("outbound_email_deliveries").select("status, attempts, next_attempt_at").eq("id", retryDelivery.id).single();
    expect(retryRow?.status).toBe("pending");
    expect(retryRow?.attempts).toBe(1);
    const retryDelayMs = new Date(retryRow!.next_attempt_at).getTime() - retryBefore;
    expect(retryDelayMs).toBeGreaterThan(50_000);
    expect(retryDelayMs).toBeLessThan(70_000);

    const retryAfter = await createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("retry-after") });
    const retryAfterDelivery = await currentDeliveryForInvitation(retryAfter.invitation.id);
    const retryAfterBefore = Date.now();
    await admin.rpc("record_outbound_email_delivery_attempt_system", {
      p_delivery_id: retryAfterDelivery.id,
      p_accepted: false,
      p_response_status: 429,
      p_failure_summary: "Received HTTP 429",
      p_retryable: true,
      p_retry_after_seconds: 120,
      p_provider_message_id: null,
    });
    const { data: retryAfterRow } = await admin.from("outbound_email_deliveries").select("status, attempts, next_attempt_at").eq("id", retryAfterDelivery.id).single();
    expect(retryAfterRow?.status).toBe("pending");
    expect(new Date(retryAfterRow!.next_attempt_at).getTime() - retryAfterBefore).toBeGreaterThan(110_000);

    const terminal = await createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("terminal") });
    const terminalDelivery = await currentDeliveryForInvitation(terminal.invitation.id);
    await admin.rpc("record_outbound_email_delivery_attempt_system", {
      p_delivery_id: terminalDelivery.id,
      p_accepted: false,
      p_response_status: 422,
      p_failure_summary: "Received HTTP 422",
      p_retryable: false,
      p_retry_after_seconds: null,
      p_provider_message_id: null,
    });
    const { data: terminalRow } = await admin.from("outbound_email_deliveries").select("status, attempts").eq("id", terminalDelivery.id).single();
    expect(terminalRow).toMatchObject({ status: "failed", attempts: 1 });

    const maxAttempts = await createInvitation({ client: builder, workspaceId, roleId, email: uniqueEmail("max") });
    const maxDelivery = await currentDeliveryForInvitation(maxAttempts.invitation.id);
    for (let attempt = 1; attempt <= 6; attempt++) {
      const { error } = await admin.rpc("record_outbound_email_delivery_attempt_system", {
        p_delivery_id: maxDelivery.id,
        p_accepted: false,
        p_response_status: 500,
        p_failure_summary: "Received HTTP 500",
        p_retryable: true,
        p_retry_after_seconds: null,
        p_provider_message_id: null,
      });
      expect(error).toBeNull();
    }
    const { data: maxRow } = await admin.from("outbound_email_deliveries").select("status, attempts").eq("id", maxDelivery.id).single();
    expect(maxRow).toMatchObject({ status: "failed", attempts: 6 });
  });
});
