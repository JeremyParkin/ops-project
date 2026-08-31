import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiKeyPreview, generateApiKey, hashApiKey } from "./api-key-signing";

describe("generateApiKey", () => {
  it("starts with the recognizable kinema_live_ prefix", () => {
    expect(generateApiKey()).toMatch(/^kinema_live_[0-9a-f]{64}$/);
  });

  it("generates a different key on every call", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe("hashApiKey", () => {
  it("matches an independently computed SHA-256 hex digest", () => {
    const key = "kinema_live_abc123";
    expect(hashApiKey(key)).toBe(createHash("sha256").update(key).digest("hex"));
  });

  it("is deterministic for the same input", () => {
    const key = "kinema_live_abc123";
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("produces a different hash for a different key", () => {
    expect(hashApiKey("kinema_live_a")).not.toBe(hashApiKey("kinema_live_b"));
  });
});

describe("apiKeyPreview", () => {
  it("returns the last 4 characters", () => {
    expect(apiKeyPreview("kinema_live_abcdefgh1234")).toBe("1234");
  });
});
