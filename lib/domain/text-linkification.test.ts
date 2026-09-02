import { describe, expect, it } from "vitest";
import { linkifyText } from "./text-linkification";

describe("linkifyText", () => {
  it("recognizes absolute http/https URLs", () => {
    expect(linkifyText("https://example.com/path?query=1")).toEqual({
      kind: "url",
      href: "https://example.com/path?query=1",
      text: "https://example.com/path?query=1",
    });
    expect(linkifyText("http://example.com")).toEqual({
      kind: "url",
      href: "http://example.com",
      text: "http://example.com",
    });
  });

  it("recognizes valid-looking email addresses", () => {
    expect(linkifyText("person@example.com")).toEqual({
      kind: "email",
      href: "mailto:person@example.com",
      text: "person@example.com",
    });
  });

  it("rejects non-http(s) schemes even though they parse as a URL", () => {
    expect(linkifyText("javascript:alert(1)").kind).toBe("plain");
    expect(linkifyText("data:text/html,hi").kind).toBe("plain");
    expect(linkifyText("ftp://example.com/file").kind).toBe("plain");
    expect(linkifyText("mailto:person@example.com").kind).toBe("plain");
  });

  it("rejects relative, malformed, or partial URLs", () => {
    expect(linkifyText("example.com").kind).toBe("plain");
    expect(linkifyText("/relative/path").kind).toBe("plain");
    expect(linkifyText("www.example.com").kind).toBe("plain");
    expect(linkifyText("not a url at all").kind).toBe("plain");
  });

  it("rejects values containing whitespace, even if a URL/email is embedded", () => {
    expect(linkifyText("see https://example.com for details").kind).toBe("plain");
    expect(linkifyText("https://example.com ").kind).toBe("plain");
    expect(linkifyText(" https://example.com").kind).toBe("plain");
    expect(linkifyText("contact person@example.com please").kind).toBe("plain");
  });

  it("rejects an email address without a dot in the domain", () => {
    expect(linkifyText("user@localhost").kind).toBe("plain");
  });

  it("rejects an empty string", () => {
    expect(linkifyText("").kind).toBe("plain");
  });

  it("returns the original text unchanged for plain values", () => {
    expect(linkifyText("Just some notes")).toEqual({
      kind: "plain",
      text: "Just some notes",
    });
  });
});
