// DB/RPC-level coverage for Phase 8F.2 Outbound Webhooks: capability
// backfill, subscription CRUD + capability/cross-workspace rejection, the
// workspace_events AFTER INSERT fan-out trigger (event-type filtering,
// inactive-subscription exclusion, idempotent uniqueness), and the two
// dispatcher RPCs (claim+lease, retry backoff progression, terminal
// classification). Delivery over HTTP itself is exercised by dogfood, not
// here -- this file only exercises the DB layer. Requires migration 0073
// applied.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient, DEMO_WORKSPACE_ID, getE2eWorkspaceAdministratorRoleId } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  if (createdWorkspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) throw new Error(error.message);
  }
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}, 30_000);

function uniqueEmail(label: string) {
  return `e2e-webhook-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Webhook-${randomUUID()}!`;
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

async function insertWorkspaceEvent(workspaceId: string, eventType: string, overrides: Record<string, unknown> = {}) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("workspace_events")
    .insert({ workspace_id: workspaceId, event_type: eventType, ...overrides })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Unable to insert workspace_events row.");
  return data.id as string;
}

describe("workspace.manage_integrations capability", () => {
  it("is backfilled onto the built-in Workspace administrator role", async () => {
    const admin = createSupabaseTestClient();
    const roleId = await getE2eWorkspaceAdministratorRoleId(admin, DEMO_WORKSPACE_ID);
    const { data, error } = await admin
      .from("workspace_role_capabilities")
      .select("capability")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("role_id", roleId)
      .eq("capability", "workspace.manage_integrations")
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
});

describe("webhook subscription management", () => {
  it("creates, lists, updates, and rejects a caller without workspace.manage_integrations", async () => {
    const workspaceId = await createWorkspace("Webhook Subscriptions");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const viewer = await memberWithCapabilities(workspaceId, ["operations.view"]);

    const { data: created, error: createError } = await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Ops relay",
      p_url: "https://example.com/hook",
      p_event_types: ["process_started", "step_assigned"],
      p_signing_secret: "a".repeat(64),
    });
    expect(createError).toBeNull();
    const subscription = created?.[0];
    expect(subscription?.secret_preview).toBe("aaaa");
    expect(subscription?.active).toBe(true);
    const subscriptionId = subscription.id as string;

    const { data: listed, error: listError } = await builder.rpc("list_webhook_subscriptions_authorized", {
      p_workspace_id: workspaceId,
    });
    expect(listError).toBeNull();
    expect(listed).toHaveLength(1);
    expect(listed?.[0].id).toBe(subscriptionId);

    const { error: updateError } = await builder.rpc("update_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_subscription_id: subscriptionId,
      p_name: "Ops relay (renamed)",
      p_url: "https://example.com/hook2",
      p_event_types: ["process_completed"],
      p_active: false,
    });
    expect(updateError).toBeNull();

    const { data: relisted } = await builder.rpc("list_webhook_subscriptions_authorized", { p_workspace_id: workspaceId });
    expect(relisted?.[0].name).toBe("Ops relay (renamed)");
    expect(relisted?.[0].active).toBe(false);

    const { error: viewerError } = await viewer.rpc("list_webhook_subscriptions_authorized", { p_workspace_id: workspaceId });
    expect(viewerError?.message).toContain("workspace.manage_integrations");
  });

  it("rejects a caller from a different workspace", async () => {
    const workspaceId = await createWorkspace("Webhook Isolation A");
    const otherWorkspaceId = await createWorkspace("Webhook Isolation B");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);

    const { error } = await builder.rpc("list_webhook_subscriptions_authorized", { p_workspace_id: otherWorkspaceId });
    expect(error?.message).toContain("Workspace access denied");
  });

  it("rejects an invalid event type", async () => {
    const workspaceId = await createWorkspace("Webhook Invalid Event Type");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);

    const { error } = await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Bad",
      p_url: "https://example.com/hook",
      p_event_types: ["record_created"],
      p_signing_secret: "a".repeat(64),
    });
    expect(error?.message).toContain("Invalid event type");
  });
});

describe("workspace_events -> webhook_deliveries fan-out trigger", () => {
  it("enqueues a delivery only for an active, matching-event-type subscription", async () => {
    const workspaceId = await createWorkspace("Webhook Fanout");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();

    const { data: matching } = await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Matching, active",
      p_url: "https://example.com/hook-a",
      p_event_types: ["process_started"],
      p_signing_secret: "a".repeat(64),
    });
    const { data: wrongType } = await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Wrong event type",
      p_url: "https://example.com/hook-b",
      p_event_types: ["process_completed"],
      p_signing_secret: "b".repeat(64),
    });
    const { data: inactive } = await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Matching, inactive",
      p_url: "https://example.com/hook-c",
      p_event_types: ["process_started"],
      p_signing_secret: "c".repeat(64),
    });
    await builder.rpc("update_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_subscription_id: inactive?.[0].id,
      p_name: "Matching, inactive",
      p_url: "https://example.com/hook-c",
      p_event_types: ["process_started"],
      p_active: false,
    });

    const eventId = await insertWorkspaceEvent(workspaceId, "process_started");

    const { data: deliveries, error } = await admin
      .from("webhook_deliveries")
      .select("subscription_id, status, next_attempt_at")
      .eq("event_id", eventId);
    expect(error).toBeNull();
    expect(deliveries).toHaveLength(1);
    expect(deliveries?.[0].subscription_id).toBe(matching?.[0].id);
    expect(deliveries?.[0].status).toBe("pending");
    void wrongType;
  });

  it("never produces a duplicate delivery row for the same (subscription, event) pair", async () => {
    const workspaceId = await createWorkspace("Webhook Idempotency");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();

    const { data: subscription } = await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Dedup target",
      p_url: "https://example.com/hook",
      p_event_types: ["step_assigned"],
      p_signing_secret: "d".repeat(64),
    });

    const eventId = await insertWorkspaceEvent(workspaceId, "step_assigned");

    const { error: duplicateError } = await admin
      .from("webhook_deliveries")
      .insert({ workspace_id: workspaceId, subscription_id: subscription?.[0].id, event_id: eventId });
    expect(duplicateError).not.toBeNull();
    expect(duplicateError?.message).toMatch(/duplicate key|unique/i);
  });
});

describe("dispatcher RPCs", () => {
  it("claims a due pending delivery, leases it, and does not reclaim it immediately after", async () => {
    const workspaceId = await createWorkspace("Webhook Claim");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();

    await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Claim target",
      p_url: "https://example.com/hook",
      p_event_types: ["approval_decided"],
      p_signing_secret: "e".repeat(64),
    });
    const eventId = await insertWorkspaceEvent(workspaceId, "approval_decided", {
      process_run_id: randomUUID(),
      metadata: { outcome: "approved" },
    });

    const { data: claimed, error: claimError } = await admin.rpc("claim_due_webhook_deliveries_system", { p_limit: 200 });
    expect(claimError).toBeNull();
    const ourClaim = claimed?.find((row: { event_id: string }) => row.event_id === eventId);
    expect(ourClaim).toBeDefined();
    expect(ourClaim.url).toBe("https://example.com/hook");
    expect(ourClaim.signing_secret).toBe("e".repeat(64));
    expect(ourClaim.metadata).toEqual({ outcome: "approved" });

    const { data: reclaimed, error: reclaimError } = await admin.rpc("claim_due_webhook_deliveries_system", { p_limit: 200 });
    expect(reclaimError).toBeNull();
    expect(reclaimed?.some((row: { event_id: string }) => row.event_id === eventId)).toBe(false);

    const { data: leasedRow } = await admin
      .from("webhook_deliveries")
      .select("next_attempt_at, status")
      .eq("event_id", eventId)
      .single();
    expect(leasedRow?.status).toBe("pending");
    expect(new Date(leasedRow!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("does not claim a pending delivery whose subscription is inactive", async () => {
    const workspaceId = await createWorkspace("Webhook Claim Inactive");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();

    const { data: subscription } = await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Will be disabled",
      p_url: "https://example.com/hook",
      p_event_types: ["process_started"],
      p_signing_secret: "f".repeat(64),
    });
    const eventId = await insertWorkspaceEvent(workspaceId, "process_started");
    await builder.rpc("update_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_subscription_id: subscription?.[0].id,
      p_name: "Will be disabled",
      p_url: "https://example.com/hook",
      p_event_types: ["process_started"],
      p_active: false,
    });

    const { data: claimed } = await admin.rpc("claim_due_webhook_deliveries_system", { p_limit: 200 });
    expect(claimed?.some((row: { event_id: string }) => row.event_id === eventId)).toBe(false);
  });

  it("records a successful attempt as terminal succeeded", async () => {
    const workspaceId = await createWorkspace("Webhook Success");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();

    await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Success target",
      p_url: "https://example.com/hook",
      p_event_types: ["process_started"],
      p_signing_secret: "g".repeat(64),
    });
    const eventId = await insertWorkspaceEvent(workspaceId, "process_started");
    const { data: claimed } = await admin.rpc("claim_due_webhook_deliveries_system", { p_limit: 200 });
    const deliveryId = claimed?.find((row: { event_id: string }) => row.event_id === eventId)?.delivery_id;

    const { error } = await admin.rpc("record_webhook_delivery_attempt_system", {
      p_delivery_id: deliveryId,
      p_success: true,
      p_response_status: 200,
      p_failure_summary: null,
      p_retryable: false,
    });
    expect(error).toBeNull();

    const { data: row } = await admin.from("webhook_deliveries").select("status, attempts").eq("id", deliveryId).single();
    expect(row?.status).toBe("succeeded");
    expect(row?.attempts).toBe(1);
  });

  it("keeps a retryable failure pending with next_attempt_at pushed to the first backoff step", async () => {
    const workspaceId = await createWorkspace("Webhook Retry");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();

    await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Retry target",
      p_url: "https://example.com/hook",
      p_event_types: ["process_started"],
      p_signing_secret: "h".repeat(64),
    });
    const eventId = await insertWorkspaceEvent(workspaceId, "process_started");
    const { data: claimed } = await admin.rpc("claim_due_webhook_deliveries_system", { p_limit: 200 });
    const deliveryId = claimed?.find((row: { event_id: string }) => row.event_id === eventId)?.delivery_id;

    const before = Date.now();
    const { error } = await admin.rpc("record_webhook_delivery_attempt_system", {
      p_delivery_id: deliveryId,
      p_success: false,
      p_response_status: 503,
      p_failure_summary: "Received HTTP 503",
      p_retryable: true,
    });
    expect(error).toBeNull();

    const { data: row } = await admin
      .from("webhook_deliveries")
      .select("status, attempts, next_attempt_at, last_response_status, last_failure_summary")
      .eq("id", deliveryId)
      .single();
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.last_response_status).toBe(503);
    expect(row?.last_failure_summary).toBe("Received HTTP 503");
    // First backoff step is 1 minute -- next_attempt_at should land roughly
    // 1 minute out, not immediately due again and not the 2-minute claim lease.
    const delayMs = new Date(row!.next_attempt_at).getTime() - before;
    expect(delayMs).toBeGreaterThan(50_000);
    expect(delayMs).toBeLessThan(70_000);
  });

  it("marks a non-retryable failure terminal on the first attempt", async () => {
    const workspaceId = await createWorkspace("Webhook Terminal");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();

    await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Terminal target",
      p_url: "https://example.com/hook",
      p_event_types: ["process_started"],
      p_signing_secret: "i".repeat(64),
    });
    const eventId = await insertWorkspaceEvent(workspaceId, "process_started");
    const { data: claimed } = await admin.rpc("claim_due_webhook_deliveries_system", { p_limit: 200 });
    const deliveryId = claimed?.find((row: { event_id: string }) => row.event_id === eventId)?.delivery_id;

    const { error } = await admin.rpc("record_webhook_delivery_attempt_system", {
      p_delivery_id: deliveryId,
      p_success: false,
      p_response_status: 404,
      p_failure_summary: "Received HTTP 404",
      p_retryable: false,
    });
    expect(error).toBeNull();

    const { data: row } = await admin.from("webhook_deliveries").select("status, attempts").eq("id", deliveryId).single();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);
  });

  it("marks a retryable failure terminal once max_attempts (6) is reached", async () => {
    const workspaceId = await createWorkspace("Webhook Max Attempts");
    const builder = await memberWithCapabilities(workspaceId, ["workspace.manage_integrations"]);
    const admin = createSupabaseTestClient();

    await builder.rpc("create_webhook_subscription_authorized", {
      p_workspace_id: workspaceId,
      p_name: "Exhaustion target",
      p_url: "https://example.com/hook",
      p_event_types: ["process_started"],
      p_signing_secret: "j".repeat(64),
    });
    const eventId = await insertWorkspaceEvent(workspaceId, "process_started");
    const { data: claimed } = await admin.rpc("claim_due_webhook_deliveries_system", { p_limit: 200 });
    const deliveryId = claimed?.find((row: { event_id: string }) => row.event_id === eventId)?.delivery_id;

    for (let attempt = 1; attempt <= 6; attempt++) {
      const { error } = await admin.rpc("record_webhook_delivery_attempt_system", {
        p_delivery_id: deliveryId,
        p_success: false,
        p_response_status: 500,
        p_failure_summary: "Received HTTP 500",
        p_retryable: true,
      });
      expect(error).toBeNull();
    }

    const { data: row } = await admin.from("webhook_deliveries").select("status, attempts").eq("id", deliveryId).single();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(6);
  });
});
