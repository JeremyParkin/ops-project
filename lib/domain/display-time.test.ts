import { describe, expect, it } from "vitest";
import { formatDisplayTimestamp } from "./display-time";

describe("display timestamp formatting", () => {
  it("uses an explicit timezone without changing the instant", () => {
    expect(formatDisplayTimestamp("2026-01-15T00:00:00.000Z", { timeZone: "America/Toronto" })).toContain("Jan 14");
  });

  it("uses browser-local formatting when no preference is stored", () => {
    expect(formatDisplayTimestamp("2026-01-15T00:00:00.000Z", { timeZone: null })).not.toBe("Unknown time");
  });

  it("does not throw for invalid timestamps", () => {
    expect(formatDisplayTimestamp("not-a-date", { timeZone: "UTC" })).toBe("Unknown time");
  });
});
