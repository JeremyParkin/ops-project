import { describe, expect, it, vi } from "vitest";
import {
  classifyEmailTransportError,
  classifyResendResponse,
  invitationUrlForToken,
  parseRetryAfter,
  providerIdempotencyKeyForDelivery,
  renderWorkspaceInvitationEmail,
} from "./email-dispatch";

describe("providerIdempotencyKeyForDelivery", () => {
  it("derives the provider idempotency key from the non-secret delivery id", () => {
    expect(providerIdempotencyKeyForDelivery("delivery-123")).toBe("kinema-email/delivery-123");
  });
});

describe("invitationUrlForToken", () => {
  it("builds a public accept URL and encodes the token", () => {
    expect(invitationUrlForToken({ appUrl: "https://app.example.com/", token: "abc/123" })).toBe(
      "https://app.example.com/accept-invitation?token=abc%2F123",
    );
  });
});

describe("renderWorkspaceInvitationEmail", () => {
  it("renders the token only at send time", () => {
    const rendered = renderWorkspaceInvitationEmail({
      appUrl: "https://app.example.com",
      delivery: {
        deliveryId: "delivery-123",
        workspaceId: "workspace-123",
        invitationId: "invitation-123",
        invitationToken: "token-123",
        recipientEmail: "person@example.com",
        workspaceName: "Acme Ops",
        roleName: "Operator",
        expiresAt: "2026-09-14T00:00:00.000Z",
      },
    });

    expect(rendered.subject).toBe("You're invited to Acme Ops on Kinema");
    expect(rendered.text).toContain("https://app.example.com/accept-invitation?token=token-123");
    expect(rendered.html).toContain("https://app.example.com/accept-invitation?token=token-123");
  });

  it("escapes workspace and role names in HTML", () => {
    const rendered = renderWorkspaceInvitationEmail({
      appUrl: "https://app.example.com",
      delivery: {
        deliveryId: "delivery-123",
        workspaceId: "workspace-123",
        invitationId: "invitation-123",
        invitationToken: "token-123",
        recipientEmail: "person@example.com",
        workspaceName: "<Acme>",
        roleName: "Owner & Admin",
        expiresAt: "2026-09-14T00:00:00.000Z",
      },
    });

    expect(rendered.html).toContain("&lt;Acme&gt;");
    expect(rendered.html).toContain("Owner &amp; Admin");
  });
});

describe("parseRetryAfter", () => {
  it("parses positive seconds", () => {
    expect(parseRetryAfter("2")).toBe(2);
    expect(parseRetryAfter("2.2")).toBe(3);
  });

  it("parses a future HTTP date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    expect(parseRetryAfter("Mon, 31 Aug 2026 12:00:05 GMT")).toBe(5);
    vi.useRealTimers();
  });

  it("ignores missing, invalid, zero, and past values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("0")).toBeNull();
    expect(parseRetryAfter("not a date")).toBeNull();
    expect(parseRetryAfter("Mon, 31 Aug 2026 11:59:59 GMT")).toBeNull();
    vi.useRealTimers();
  });
});

describe("classifyResendResponse", () => {
  it("treats any 2xx as accepted by provider", () => {
    const outcome = classifyResendResponse({ status: 202, bodyText: '{"id":"email_123"}' });
    expect(outcome).toEqual({
      accepted: true,
      retryable: false,
      responseStatus: 202,
      failureSummary: null,
      retryAfterSeconds: null,
      providerMessageId: "email_123",
    });
  });

  it("extracts nested Resend message ids", () => {
    expect(classifyResendResponse({ status: 200, bodyText: '{"data":{"id":"email_nested"}}' }).providerMessageId).toBe(
      "email_nested",
    );
  });

  it("retries 429 and respects Retry-After when present", () => {
    const outcome = classifyResendResponse({ status: 429, retryAfterHeader: "60" });
    expect(outcome.accepted).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(outcome.retryAfterSeconds).toBe(60);
  });

  it("retries every 5xx", () => {
    for (const status of [500, 502, 503, 599]) {
      const outcome = classifyResendResponse({ status });
      expect(outcome.accepted).toBe(false);
      expect(outcome.retryable).toBe(true);
    }
  });

  it("retries Resend concurrent idempotency conflicts", () => {
    const outcome = classifyResendResponse({
      status: 409,
      bodyText: '{"error":{"type":"concurrent_idempotent_requests"}}',
    });
    expect(outcome.retryable).toBe(true);
  });

  it("treats other 4xx responses as terminal", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const outcome = classifyResendResponse({ status });
      expect(outcome.accepted).toBe(false);
      expect(outcome.retryable).toBe(false);
    }
  });

  it("treats non-concurrent idempotency conflicts as terminal", () => {
    const outcome = classifyResendResponse({
      status: 409,
      bodyText: '{"error":{"type":"invalid_idempotent_request"}}',
    });
    expect(outcome.retryable).toBe(false);
  });
});

describe("classifyEmailTransportError", () => {
  it("is retryable with no response status", () => {
    const outcome = classifyEmailTransportError(new Error("ECONNREFUSED"));
    expect(outcome.accepted).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(outcome.responseStatus).toBeNull();
  });

  it("summarizes an AbortError/TimeoutError as a timeout", () => {
    const timeoutError = new Error("The operation was aborted");
    timeoutError.name = "TimeoutError";
    expect(classifyEmailTransportError(timeoutError).failureSummary).toBe("Request timed out");

    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    expect(classifyEmailTransportError(abortError).failureSummary).toBe("Request timed out");
  });

  it("handles thrown non-Error values", () => {
    const outcome = classifyEmailTransportError("a plain string failure");
    expect(outcome.retryable).toBe(true);
    expect(outcome.failureSummary).toBe("a plain string failure");
  });
});
