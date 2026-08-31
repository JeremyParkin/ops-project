import { describe, expect, it } from "vitest";
import { assertPublicHttpsWebhookUrl, isPublicAddress, UnsafeWebhookUrlError } from "./webhook-url-safety";

describe("isPublicAddress", () => {
  it("accepts ordinary public IPv4 and IPv6 addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
  });

  it("rejects IPv4 loopback and RFC1918 private ranges", () => {
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("172.16.0.1")).toBe(false);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
  });

  it("rejects IPv4 link-local and carrier-grade NAT ranges", () => {
    expect(isPublicAddress("169.254.1.1")).toBe(false);
    expect(isPublicAddress("100.64.0.1")).toBe(false);
  });

  it("rejects IPv6 loopback, unique-local, and link-local ranges", () => {
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fc00::1")).toBe(false);
    expect(isPublicAddress("fd12:3456:789a::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
  });

  it("rejects reserved, unspecified, and multicast addresses", () => {
    expect(isPublicAddress("0.0.0.0")).toBe(false);
    expect(isPublicAddress("::")).toBe(false);
    expect(isPublicAddress("224.0.0.1")).toBe(false);
    expect(isPublicAddress("240.0.0.1")).toBe(false);
  });

  it("normalizes IPv4-mapped IPv6 addresses before classifying them", () => {
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("rejects a malformed address rather than throwing", () => {
    expect(isPublicAddress("not-an-address")).toBe(false);
  });
});

describe("assertPublicHttpsWebhookUrl", () => {
  const publicLookup = async () => ["93.184.216.34"];

  it("accepts an https URL that resolves to a public address", async () => {
    await expect(assertPublicHttpsWebhookUrl("https://example.com/hook", publicLookup)).resolves.toBeInstanceOf(URL);
  });

  it("rejects a non-https URL", async () => {
    await expect(assertPublicHttpsWebhookUrl("http://example.com/hook", publicLookup)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects a malformed URL", async () => {
    await expect(assertPublicHttpsWebhookUrl("not a url", publicLookup)).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("rejects localhost and internal-style hostnames before any DNS lookup", async () => {
    const lookupThatMustNotBeCalled = async (): Promise<string[]> => {
      throw new Error("lookup should not be called for a blocked hostname");
    };
    await expect(assertPublicHttpsWebhookUrl("https://localhost/hook", lookupThatMustNotBeCalled)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
    await expect(assertPublicHttpsWebhookUrl("https://service.internal/hook", lookupThatMustNotBeCalled)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
    await expect(assertPublicHttpsWebhookUrl("https://box.local/hook", lookupThatMustNotBeCalled)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects a bare private IP literal in the URL without a DNS lookup", async () => {
    const lookupThatMustNotBeCalled = async (): Promise<string[]> => {
      throw new Error("lookup should not be called for an IP literal");
    };
    await expect(assertPublicHttpsWebhookUrl("https://127.0.0.1/hook", lookupThatMustNotBeCalled)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
    await expect(assertPublicHttpsWebhookUrl("https://[::1]/hook", lookupThatMustNotBeCalled)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
    await expect(assertPublicHttpsWebhookUrl("https://192.168.1.1/hook", lookupThatMustNotBeCalled)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("accepts a bare public IP literal without a DNS lookup", async () => {
    const lookupThatMustNotBeCalled = async (): Promise<string[]> => {
      throw new Error("lookup should not be called for an IP literal");
    };
    await expect(assertPublicHttpsWebhookUrl("https://8.8.8.8/hook", lookupThatMustNotBeCalled)).resolves.toBeInstanceOf(
      URL,
    );
  });

  it("rejects a hostname that resolves to a private address, even if it also has a public one", async () => {
    const mixedLookup = async () => ["93.184.216.34", "10.0.0.5"];
    await expect(assertPublicHttpsWebhookUrl("https://rebinding.example.com/hook", mixedLookup)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects a hostname whose only resolved address is an IPv4-mapped IPv6 loopback", async () => {
    const mappedLoopbackLookup = async () => ["::ffff:127.0.0.1"];
    await expect(assertPublicHttpsWebhookUrl("https://sneaky.example.com/hook", mappedLoopbackLookup)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects a hostname that fails to resolve", async () => {
    const failingLookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicHttpsWebhookUrl("https://nowhere.invalid/hook", failingLookup)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects a hostname that resolves to zero addresses", async () => {
    const emptyLookup = async () => [];
    await expect(assertPublicHttpsWebhookUrl("https://empty.example.com/hook", emptyLookup)).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });
});
