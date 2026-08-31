import { describe, expect, it } from "vitest";
import { buildApiPage, decodeApiCursor, encodeApiCursor } from "./api-cursor";

type Row = { createdAt: string; id: string };

function row(createdAt: string, id: string): Row {
  return { createdAt, id };
}

describe("encodeApiCursor / decodeApiCursor", () => {
  it("round-trips a cursor exactly", () => {
    const cursor = { createdAt: "2026-08-30T12:00:00.000Z", id: "11111111-1111-4111-8111-111111111111" };
    expect(decodeApiCursor(encodeApiCursor(cursor))).toEqual(cursor);
  });

  it("returns null for garbage input rather than throwing", () => {
    expect(decodeApiCursor("not-valid-base64url-json")).toBeNull();
  });

  it("returns null for valid base64url that isn't JSON", () => {
    const notJson = Buffer.from("hello world", "utf8").toString("base64url");
    expect(decodeApiCursor(notJson)).toBeNull();
  });

  it("returns null for well-formed JSON missing the expected shape", () => {
    const wrongShape = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url");
    expect(decodeApiCursor(wrongShape)).toBeNull();
  });

  it("returns null when createdAt or id has the wrong type", () => {
    const wrongTypes = Buffer.from(JSON.stringify({ createdAt: 123, id: "x" }), "utf8").toString("base64url");
    expect(decodeApiCursor(wrongTypes)).toBeNull();
  });
});

describe("buildApiPage", () => {
  it("returns no cursor when fewer rows than the limit come back (a genuine last page)", () => {
    const rows = [row("2026-01-01T00:00:00.000Z", "a"), row("2026-01-02T00:00:00.000Z", "b")];
    const page = buildApiPage(rows, 5);
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("returns no cursor when exactly the limit comes back (an exact-multiple last page)", () => {
    const rows = [row("2026-01-01T00:00:00.000Z", "a"), row("2026-01-02T00:00:00.000Z", "b")];
    const page = buildApiPage(rows, 2);
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("trims to the limit and returns a cursor only when limit + 1 rows come back", () => {
    const rows = [
      row("2026-01-01T00:00:00.000Z", "a"),
      row("2026-01-02T00:00:00.000Z", "b"),
      row("2026-01-03T00:00:00.000Z", "c"),
    ];
    const page = buildApiPage(rows, 2);
    expect(page.rows).toEqual(rows.slice(0, 2));
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it("builds the cursor from the last row of the trimmed page, not the lookahead row", () => {
    const rows = [
      row("2026-01-01T00:00:00.000Z", "a"),
      row("2026-01-02T00:00:00.000Z", "b"),
      row("2026-01-03T00:00:00.000Z", "lookahead-only"),
    ];
    const page = buildApiPage(rows, 2);
    expect(decodeApiCursor(page.nextCursor!)).toEqual({ createdAt: "2026-01-02T00:00:00.000Z", id: "b" });
  });

  it("never returns more rows than the requested limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, `id-${i}`));
    const page = buildApiPage(rows, 3);
    expect(page.rows.length).toBeLessThanOrEqual(3);
  });
});
