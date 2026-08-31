import { afterEach, describe, expect, it, vi } from "vitest";

describe("POST /api/internal/email-deliveries", () => {
  const originalSecret = process.env.EMAIL_DISPATCH_SCHEDULER_SECRET;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
    if (originalSecret === undefined) {
      delete process.env.EMAIL_DISPATCH_SCHEDULER_SECRET;
    } else {
      process.env.EMAIL_DISPATCH_SCHEDULER_SECRET = originalSecret;
    }
  });

  function authorizedRequest() {
    return new Request("https://kinema.test/api/internal/email-deliveries", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
  }

  it("rejects requests without the scheduler bearer secret before touching service-role state", async () => {
    process.env.EMAIL_DISPATCH_SCHEDULER_SECRET = "secret";
    const { POST } = await import("../../app/api/internal/email-deliveries/route");
    const response = await POST(new Request("https://kinema.test/api/internal/email-deliveries", { method: "POST" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("prepares, sends, and records accepted-by-provider outcomes for configured deliveries", async () => {
    process.env.EMAIL_DISPATCH_SCHEDULER_SECRET = "secret";
    const supabase = { rpc: vi.fn() };
    const claimDueOutboundEmailDeliveryIds = vi.fn().mockResolvedValue(["delivery-1"]);
    const prepareWorkspaceInvitationEmailDelivery = vi.fn().mockResolvedValue({
      deliveryId: "delivery-1",
      workspaceId: "workspace-1",
      invitationId: "invitation-1",
      invitationToken: "token-1",
      recipientEmail: "person@example.com",
      workspaceName: "Acme",
      roleName: "Member",
      expiresAt: "2026-09-14T00:00:00.000Z",
    });
    const recordOutboundEmailDeliveryAttempt = vi.fn().mockResolvedValue(undefined);
    const sendWorkspaceInvitationEmail = vi.fn().mockResolvedValue({
      accepted: true,
      retryable: false,
      responseStatus: 202,
      failureSummary: null,
      retryAfterSeconds: null,
      providerMessageId: "email_123",
    });

    vi.doMock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => supabase }));
    vi.doMock("@/lib/domain/email-delivery-repository", () => ({
      claimDueOutboundEmailDeliveryIds,
      prepareWorkspaceInvitationEmailDelivery,
      recordOutboundEmailDeliveryAttempt,
    }));
    vi.doMock("@/lib/domain/email-dispatch", () => ({
      getEmailProviderConfig: () => ({ apiKey: "key", from: "Kinema <hello@example.com>", appUrl: "https://kinema.test" }),
      sendWorkspaceInvitationEmail,
      emailProviderNotConfiguredOutcome: () => ({
        accepted: false,
        retryable: false,
        responseStatus: null,
        failureSummary: "Outbound email provider is not configured.",
        retryAfterSeconds: null,
        providerMessageId: null,
      }),
    }));

    const { POST } = await import("../../app/api/internal/email-deliveries/route");
    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: { claimed: 1, attempted: 1, acceptedByProvider: 1, skipped: 0, failedToProcess: 0 },
    });
    expect(prepareWorkspaceInvitationEmailDelivery).toHaveBeenCalledWith({ supabase, deliveryId: "delivery-1" });
    expect(sendWorkspaceInvitationEmail).toHaveBeenCalledTimes(1);
    expect(recordOutboundEmailDeliveryAttempt).toHaveBeenCalledWith({
      supabase,
      deliveryId: "delivery-1",
      outcome: {
        accepted: true,
        retryable: false,
        responseStatus: 202,
        failureSummary: null,
        retryAfterSeconds: null,
        providerMessageId: "email_123",
      },
    });
  });

  it("skips stale rows refused by the DB prepare gate without calling the provider", async () => {
    process.env.EMAIL_DISPATCH_SCHEDULER_SECRET = "secret";
    const claimDueOutboundEmailDeliveryIds = vi.fn().mockResolvedValue(["delivery-stale"]);
    const prepareWorkspaceInvitationEmailDelivery = vi.fn().mockResolvedValue(null);
    const recordOutboundEmailDeliveryAttempt = vi.fn();
    const sendWorkspaceInvitationEmail = vi.fn();

    vi.doMock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ rpc: vi.fn() }) }));
    vi.doMock("@/lib/domain/email-delivery-repository", () => ({
      claimDueOutboundEmailDeliveryIds,
      prepareWorkspaceInvitationEmailDelivery,
      recordOutboundEmailDeliveryAttempt,
    }));
    vi.doMock("@/lib/domain/email-dispatch", () => ({
      getEmailProviderConfig: () => ({ apiKey: "key", from: "Kinema <hello@example.com>", appUrl: "https://kinema.test" }),
      sendWorkspaceInvitationEmail,
      emailProviderNotConfiguredOutcome: vi.fn(),
    }));

    const { POST } = await import("../../app/api/internal/email-deliveries/route");
    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: { claimed: 1, attempted: 0, acceptedByProvider: 0, skipped: 1, failedToProcess: 0 },
    });
    expect(sendWorkspaceInvitationEmail).not.toHaveBeenCalled();
    expect(recordOutboundEmailDeliveryAttempt).not.toHaveBeenCalled();
  });

  it("does not duplicate accepted deliveries when a later dispatcher run has no claimable rows", async () => {
    process.env.EMAIL_DISPATCH_SCHEDULER_SECRET = "secret";
    const claimDueOutboundEmailDeliveryIds = vi.fn()
      .mockResolvedValueOnce(["delivery-1"])
      .mockResolvedValueOnce([]);
    const prepareWorkspaceInvitationEmailDelivery = vi.fn().mockResolvedValue({
      deliveryId: "delivery-1",
      workspaceId: "workspace-1",
      invitationId: "invitation-1",
      invitationToken: "token-1",
      recipientEmail: "person@example.com",
      workspaceName: "Acme",
      roleName: "Member",
      expiresAt: "2026-09-14T00:00:00.000Z",
    });
    const recordOutboundEmailDeliveryAttempt = vi.fn().mockResolvedValue(undefined);
    const sendWorkspaceInvitationEmail = vi.fn().mockResolvedValue({
      accepted: true,
      retryable: false,
      responseStatus: 202,
      failureSummary: null,
      retryAfterSeconds: null,
      providerMessageId: "email_123",
    });

    vi.doMock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ rpc: vi.fn() }) }));
    vi.doMock("@/lib/domain/email-delivery-repository", () => ({
      claimDueOutboundEmailDeliveryIds,
      prepareWorkspaceInvitationEmailDelivery,
      recordOutboundEmailDeliveryAttempt,
    }));
    vi.doMock("@/lib/domain/email-dispatch", () => ({
      getEmailProviderConfig: () => ({ apiKey: "key", from: "Kinema <hello@example.com>", appUrl: "https://kinema.test" }),
      sendWorkspaceInvitationEmail,
      emailProviderNotConfiguredOutcome: vi.fn(),
    }));

    const { POST } = await import("../../app/api/internal/email-deliveries/route");
    const first = await POST(authorizedRequest());
    const second = await POST(authorizedRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sendWorkspaceInvitationEmail).toHaveBeenCalledTimes(1);
    await expect(second.json()).resolves.toEqual({
      result: { claimed: 0, attempted: 0, acceptedByProvider: 0, skipped: 0, failedToProcess: 0 },
    });
  });
});
