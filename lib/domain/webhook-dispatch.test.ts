import { describe, expect, it } from "vitest";
import { classifyWebhookResponse, classifyWebhookTransportError } from "./webhook-dispatch";

describe("classifyWebhookResponse", () => {
  it("treats any 2xx as success, non-retryable by definition", () => {
    for (const status of [200, 201, 204, 299]) {
      const outcome = classifyWebhookResponse(status);
      expect(outcome).toEqual({ success: true, retryable: false, responseStatus: status, failureSummary: null });
    }
  });

  it("retries 429", () => {
    const outcome = classifyWebhookResponse(429);
    expect(outcome.success).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(outcome.responseStatus).toBe(429);
  });

  it("retries every 5xx", () => {
    for (const status of [500, 502, 503, 599]) {
      const outcome = classifyWebhookResponse(status);
      expect(outcome.success).toBe(false);
      expect(outcome.retryable).toBe(true);
    }
  });

  it("treats any other 4xx as a terminal, non-retryable failure", () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      const outcome = classifyWebhookResponse(status);
      expect(outcome.success).toBe(false);
      expect(outcome.retryable).toBe(false);
      expect(outcome.responseStatus).toBe(status);
    }
  });

  it("treats a 3xx (a redirect we refused to follow) as terminal, non-retryable", () => {
    const outcome = classifyWebhookResponse(301);
    expect(outcome.success).toBe(false);
    expect(outcome.retryable).toBe(false);
  });

  it("includes the status code in the failure summary", () => {
    expect(classifyWebhookResponse(500).failureSummary).toBe("Received HTTP 500");
  });
});

describe("classifyWebhookTransportError", () => {
  it("is always retryable with no response status", () => {
    const outcome = classifyWebhookTransportError(new Error("ECONNREFUSED"));
    expect(outcome.success).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(outcome.responseStatus).toBeNull();
  });

  it("summarizes an AbortError/TimeoutError as a timeout, not the raw error message", () => {
    const timeoutError = new Error("The operation was aborted");
    timeoutError.name = "TimeoutError";
    expect(classifyWebhookTransportError(timeoutError).failureSummary).toBe("Request timed out");

    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    expect(classifyWebhookTransportError(abortError).failureSummary).toBe("Request timed out");
  });

  it("uses the error's own message for a non-timeout transport error", () => {
    expect(classifyWebhookTransportError(new Error("ECONNREFUSED")).failureSummary).toBe("ECONNREFUSED");
  });

  it("handles a thrown non-Error value without crashing", () => {
    const outcome = classifyWebhookTransportError("a plain string failure");
    expect(outcome.retryable).toBe(true);
    expect(outcome.failureSummary).toBe("a plain string failure");
  });

  it("truncates an unreasonably long failure summary", () => {
    const outcome = classifyWebhookTransportError(new Error("x".repeat(1000)));
    expect(outcome.failureSummary?.length).toBeLessThanOrEqual(501);
  });
});
