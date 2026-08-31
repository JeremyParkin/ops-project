import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeWebhookSignature, generateWebhookSigningSecret, webhookSecretPreview } from "./webhook-signing";

describe("generateWebhookSigningSecret", () => {
  it("generates a 64-character hex string (32 random bytes)", () => {
    const secret = generateWebhookSigningSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a different secret on every call", () => {
    expect(generateWebhookSigningSecret()).not.toBe(generateWebhookSigningSecret());
  });
});

describe("webhookSecretPreview", () => {
  it("returns the last 4 characters", () => {
    expect(webhookSecretPreview("abcdefgh1234")).toBe("1234");
  });
});

describe("computeWebhookSignature", () => {
  it("matches an independently computed HMAC-SHA256 over `timestamp.body`", () => {
    const secret = "test-secret";
    const timestamp = 1_800_000_000;
    const body = '{"id":"abc"}';
    const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
    expect(computeWebhookSignature({ secret, timestamp, body })).toBe(expected);
  });

  it("produces a different signature for a different timestamp with the same body", () => {
    const secret = "test-secret";
    const body = '{"id":"abc"}';
    const first = computeWebhookSignature({ secret, timestamp: 1, body });
    const second = computeWebhookSignature({ secret, timestamp: 2, body });
    expect(first).not.toBe(second);
  });

  it("produces a different signature for a different body with the same timestamp", () => {
    const secret = "test-secret";
    const timestamp = 1_800_000_000;
    const first = computeWebhookSignature({ secret, timestamp, body: '{"id":"abc"}' });
    const second = computeWebhookSignature({ secret, timestamp, body: '{"id":"xyz"}' });
    expect(first).not.toBe(second);
  });

  it("produces a different signature for a different secret", () => {
    const timestamp = 1_800_000_000;
    const body = '{"id":"abc"}';
    const first = computeWebhookSignature({ secret: "secret-a", timestamp, body });
    const second = computeWebhookSignature({ secret: "secret-b", timestamp, body });
    expect(first).not.toBe(second);
  });
});
