// Pure occurrence-date math, called directly against the live RPC
// (compute_recurrence_occurrence_date) -- no table access, no fixtures, no
// cleanup: every input is a literal scalar, so these are effectively pure
// unit tests despite the network round trip. Requires migration 0063
// applied.
import { describe, expect, it } from "vitest";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type OccurrenceRow = { occurrence_date: string | null; scheduled_for: string | null };

async function computeOccurrence(params: {
  frequency: "daily" | "weekly" | "monthly";
  intervalCount: number;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  startDate: string;
  endDate?: string | null;
  timeOfDay: string;
  timezone: string;
  asOf: string;
}) {
  const supabase = createSupabaseTestClient();
  const { data, error } = await supabase.rpc("compute_recurrence_occurrence_date", {
    p_frequency: params.frequency,
    p_interval_count: params.intervalCount,
    p_day_of_week: params.dayOfWeek ?? null,
    p_day_of_month: params.dayOfMonth ?? null,
    p_start_date: params.startDate,
    p_end_date: params.endDate ?? null,
    p_time_of_day: params.timeOfDay,
    p_timezone: params.timezone,
    p_as_of: params.asOf,
  });

  if (error) {
    throw new Error(`compute_recurrence_occurrence_date: ${error.message}`);
  }

  const rows = data as OccurrenceRow[];
  return rows[0] ?? null;
}

describe("compute_recurrence_occurrence_date", () => {
  it("daily: returns each elapsed day up to the as-of date", async () => {
    const result = await computeOccurrence({
      frequency: "daily",
      intervalCount: 1,
      startDate: "2026-01-01",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-05T15:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2026-01-05");
  });

  it("daily: every-N interval lands exactly on multiples of the interval", async () => {
    const onBoundary = await computeOccurrence({
      frequency: "daily",
      intervalCount: 3,
      startDate: "2026-01-01",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-10T00:00:00Z",
    });
    expect(onBoundary?.occurrence_date).toBe("2026-01-10");

    const oneDayShort = await computeOccurrence({
      frequency: "daily",
      intervalCount: 3,
      startDate: "2026-01-01",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-09T00:00:00Z",
    });
    expect(oneDayShort?.occurrence_date).toBe("2026-01-07");
  });

  it("daily: returns nothing before the start date", async () => {
    const result = await computeOccurrence({
      frequency: "daily",
      intervalCount: 1,
      startDate: "2026-06-01",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-01T00:00:00Z",
    });
    expect(result).toBeNull();
  });

  it("weekly: shifts the first occurrence forward to the configured weekday", async () => {
    // 2026-01-01 is a Thursday (dow 4); day_of_week 1 is Monday.
    const result = await computeOccurrence({
      frequency: "weekly",
      intervalCount: 1,
      dayOfWeek: 1,
      startDate: "2026-01-01",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-05T00:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2026-01-05");
  });

  it("weekly: every-N-weeks interval math", async () => {
    // 2026-01-05 is a Monday.
    const twoWeeksLater = await computeOccurrence({
      frequency: "weekly",
      intervalCount: 2,
      dayOfWeek: 1,
      startDate: "2026-01-05",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-19T00:00:00Z",
    });
    expect(twoWeeksLater?.occurrence_date).toBe("2026-01-19");

    const oneDayShortOfNext = await computeOccurrence({
      frequency: "weekly",
      intervalCount: 2,
      dayOfWeek: 1,
      startDate: "2026-01-05",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-18T00:00:00Z",
    });
    expect(oneDayShortOfNext?.occurrence_date).toBe("2026-01-05");
  });

  it("monthly: day 31 clamps to February's last valid day (non-leap year)", async () => {
    const result = await computeOccurrence({
      frequency: "monthly",
      intervalCount: 1,
      dayOfMonth: 31,
      startDate: "2026-01-31",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-02-28T23:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2026-02-28");
  });

  it("monthly: day 31 clamps to February 29 in a leap year", async () => {
    const result = await computeOccurrence({
      frequency: "monthly",
      intervalCount: 1,
      dayOfMonth: 31,
      startDate: "2028-01-31",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2028-02-29T23:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2028-02-29");
  });

  it("monthly: resumes day 31 in March after a clamped February", async () => {
    const result = await computeOccurrence({
      frequency: "monthly",
      intervalCount: 1,
      dayOfMonth: 31,
      startDate: "2026-01-31",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-03-31T23:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2026-03-31");
  });

  it("monthly: skips a bucket-zero day that falls before the start date", async () => {
    // start_date is the 20th, day_of_month is 15 -- January's own 15th is
    // before start_date, so the first real occurrence is February 15th, not
    // a phantom January 15th.
    const beforeFirstRealOccurrence = await computeOccurrence({
      frequency: "monthly",
      intervalCount: 1,
      dayOfMonth: 15,
      startDate: "2026-01-20",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-25T00:00:00Z",
    });
    expect(beforeFirstRealOccurrence).toBeNull();

    const atFirstRealOccurrence = await computeOccurrence({
      frequency: "monthly",
      intervalCount: 1,
      dayOfMonth: 15,
      startDate: "2026-01-20",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-02-15T00:00:00Z",
    });
    expect(atFirstRealOccurrence?.occurrence_date).toBe("2026-02-15");
  });

  it("monthly: every-N-months interval math", async () => {
    const onBoundary = await computeOccurrence({
      frequency: "monthly",
      intervalCount: 3,
      dayOfMonth: 15,
      startDate: "2026-01-15",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-07-15T00:00:00Z",
    });
    expect(onBoundary?.occurrence_date).toBe("2026-07-15");

    const beforeNextBoundary = await computeOccurrence({
      frequency: "monthly",
      intervalCount: 3,
      dayOfMonth: 15,
      startDate: "2026-01-15",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-06-01T00:00:00Z",
    });
    expect(beforeNextBoundary?.occurrence_date).toBe("2026-04-15");
  });

  it("respects an end date even when as-of is further in the future", async () => {
    const result = await computeOccurrence({
      frequency: "daily",
      intervalCount: 1,
      startDate: "2026-01-01",
      endDate: "2026-01-10",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-20T00:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2026-01-10");
  });

  it("latest-missed-occurrence: a large gap still returns exactly one row, the most recent", async () => {
    const result = await computeOccurrence({
      frequency: "daily",
      intervalCount: 1,
      startDate: "2026-01-01",
      timeOfDay: "09:00",
      timezone: "UTC",
      asOf: "2026-01-31T12:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2026-01-31");
  });

  it("converts local time of day to UTC using the given IANA timezone (no DST, EST)", async () => {
    const result = await computeOccurrence({
      frequency: "daily",
      intervalCount: 1,
      startDate: "2026-01-15",
      timeOfDay: "09:00",
      timezone: "America/New_York",
      asOf: "2026-01-15T23:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2026-01-15");
    // Postgres returns timestamptz as "...+00:00", not JS's "...Z" -- same
    // instant, different string form, so compare by value.
    expect(new Date(result!.scheduled_for!).getTime()).toBe(
      new Date("2026-01-15T14:00:00.000Z").getTime(),
    );
  });

  it("converts local time of day to UTC using the given IANA timezone (DST, EDT)", async () => {
    // 2026-03-08 is after the US spring-forward transition; America/New_York
    // is UTC-4 (EDT), not UTC-5 (EST).
    const result = await computeOccurrence({
      frequency: "daily",
      intervalCount: 1,
      startDate: "2026-03-15",
      timeOfDay: "09:00",
      timezone: "America/New_York",
      asOf: "2026-03-15T23:00:00Z",
    });
    expect(result?.occurrence_date).toBe("2026-03-15");
    expect(new Date(result!.scheduled_for!).getTime()).toBe(
      new Date("2026-03-15T13:00:00.000Z").getTime(),
    );
  });

  it("produces a valid instant across the DST transition boundary itself", async () => {
    // Confirms the function resolves the transition date deterministically
    // (via Postgres's own AT TIME ZONE semantics) rather than erroring or
    // returning an unparseable result.
    const beforeTransition = await computeOccurrence({
      frequency: "monthly",
      intervalCount: 1,
      dayOfMonth: 1,
      startDate: "2026-03-01",
      timeOfDay: "09:00",
      timezone: "America/New_York",
      asOf: "2026-03-01T23:00:00Z",
    });
    expect(beforeTransition?.occurrence_date).toBe("2026-03-01");
    expect(beforeTransition?.scheduled_for).toBeTruthy();
    expect(Number.isNaN(new Date(beforeTransition!.scheduled_for!).getTime())).toBe(false);
  });
});
