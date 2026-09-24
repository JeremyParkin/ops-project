import { describe, expect, it } from "vitest";
import {
  buildCalendarViewModel,
  currentCalendarMonthUtc,
  isCanonicalCalendarDate,
  nextCalendarMonth,
  parseCalendarMonth,
  previousCalendarMonth,
  resolveCalendarMonth,
  type CalendarSourceRecord,
} from "./calendar-view";

function record(
  id: string,
  dateValue: unknown,
): CalendarSourceRecord {
  return {
    id,
    label: id,
    href: `/records/${id}`,
    dateValue,
  };
}

describe("calendar month parsing", () => {
  it("strictly parses valid month keys", () => {
    expect(parseCalendarMonth("2026-01")).toEqual({ year: 2026, month: 1, key: "2026-01" });
    expect(parseCalendarMonth("2026-12")).toEqual({ year: 2026, month: 12, key: "2026-12" });
  });

  it("rejects malformed or out-of-range month keys", () => {
    for (const value of ["", "2026-1", "2026-00", "2026-13", "26-01", "2026-01-01", ["2026-01"], ["2026-01", "2026-02"]]) {
      expect(parseCalendarMonth(value)).toBeUndefined();
    }
  });

  it("supports previous and next across year boundaries", () => {
    expect(previousCalendarMonth({ year: 2026, month: 1, key: "2026-01" })).toEqual({
      year: 2025,
      month: 12,
      key: "2025-12",
    });
    expect(nextCalendarMonth({ year: 2026, month: 12, key: "2026-12" })).toEqual({
      year: 2027,
      month: 1,
      key: "2027-01",
    });
  });

  it("derives the current fallback month from stable UTC", () => {
    const now = new Date("2026-03-01T00:30:00.000Z");

    expect(currentCalendarMonthUtc(now)).toEqual({ year: 2026, month: 3, key: "2026-03" });
    expect(resolveCalendarMonth("not-a-month", now)).toEqual({ year: 2026, month: 3, key: "2026-03" });
  });
});

describe("canonical calendar dates", () => {
  it("accepts real leap-year dates and rejects impossible dates", () => {
    expect(isCanonicalCalendarDate("2024-02-29")).toBe(true);
    expect(isCanonicalCalendarDate("2026-02-29")).toBe(false);
    expect(isCanonicalCalendarDate("2026-02-30")).toBe(false);
    expect(isCanonicalCalendarDate("2026-04-31")).toBe(false);
    expect(isCanonicalCalendarDate("2026-13-01")).toBe(false);
    expect(isCanonicalCalendarDate("2026-2-1")).toBe(false);
  });
});

describe("buildCalendarViewModel", () => {
  it("groups displayed-month records and preserves same-day evaluated order", () => {
    const model = buildCalendarViewModel({
      month: { year: 2026, month: 8, key: "2026-08" },
      records: [
        record("alpha", "2026-08-12"),
        record("beta", "2026-08-12"),
        record("gamma", "2026-08-05"),
      ],
    });
    const cells = model.weeks.flat();

    expect(cells.find((cell) => cell.date === "2026-08-12")?.records.map((row) => row.id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(cells.find((cell) => cell.date === "2026-08-05")?.records.map((row) => row.id)).toEqual([
      "gamma",
    ]);
  });

  it("keeps undated and malformed non-empty values in distinct truthful buckets", () => {
    const model = buildCalendarViewModel({
      month: { year: 2026, month: 8, key: "2026-08" },
      records: [
        record("missing", undefined),
        record("null", null),
        record("empty", ""),
        record("malformed", "2026-02-30"),
        record("number", 10),
      ],
    });

    expect(model.undatedRecords.map((row) => row.id)).toEqual(["missing", "null", "empty"]);
    expect(model.invalidDateRecords.map((row) => row.id)).toEqual(["malformed", "number"]);
  });

  it("counts outside-month records rather than unique outside dates", () => {
    const model = buildCalendarViewModel({
      month: { year: 2026, month: 8, key: "2026-08" },
      records: [
        record("july-a", "2026-07-31"),
        record("july-b", "2026-07-31"),
        record("september", "2026-09-01"),
        record("august", "2026-08-01"),
      ],
    });

    expect(model.outsideMonthRecordCount).toBe(3);
    expect(model.displayedRecordCount).toBe(1);
  });

  it("builds a deterministic six-week grid with leading and trailing orientation cells", () => {
    const model = buildCalendarViewModel({
      month: { year: 2026, month: 8, key: "2026-08" },
      records: [],
    });

    expect(model.weeks).toHaveLength(6);
    expect(model.weeks.every((week) => week.length === 7)).toBe(true);
    expect(model.weeks[0][0]).toMatchObject({ date: "2026-07-26", inMonth: false });
    expect(model.weeks[0][6]).toMatchObject({ date: "2026-08-01", inMonth: true });
    expect(model.weeks[5][6]).toMatchObject({ date: "2026-09-05", inMonth: false });
  });

  it("keeps deterministic six-week grids for leap and non-leap February", () => {
    const leap = buildCalendarViewModel({
      month: { year: 2024, month: 2, key: "2024-02" },
      records: [],
    });
    const nonLeap = buildCalendarViewModel({
      month: { year: 2026, month: 2, key: "2026-02" },
      records: [],
    });

    expect(leap.weeks).toHaveLength(6);
    expect(leap.weeks[0][0]).toMatchObject({ date: "2024-01-28", inMonth: false });
    expect(leap.weeks[4][4]).toMatchObject({ date: "2024-02-29", inMonth: true });
    expect(nonLeap.weeks).toHaveLength(6);
    expect(nonLeap.weeks[0][0]).toMatchObject({ date: "2026-02-01", inMonth: true });
    expect(nonLeap.weeks[3][6]).toMatchObject({ date: "2026-02-28", inMonth: true });
  });

  it("models a truthful empty displayed month without losing outside and undated records", () => {
    const model = buildCalendarViewModel({
      month: { year: 2026, month: 8, key: "2026-08" },
      records: [
        record("outside", "2026-09-01"),
        record("undated", null),
      ],
    });

    expect(model.displayedRecordCount).toBe(0);
    expect(model.outsideMonthRecordCount).toBe(1);
    expect(model.undatedRecords.map((row) => row.id)).toEqual(["undated"]);
  });
});
