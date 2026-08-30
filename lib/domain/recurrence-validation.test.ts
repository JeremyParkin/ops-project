import { describe, expect, it } from "vitest";
import { validateRecurrenceRuleInput } from "./recurrence-validation";
import type { ProcessRecurrenceRuleInput } from "./recurrence-types";

function baseInput(overrides: Partial<ProcessRecurrenceRuleInput> = {}): ProcessRecurrenceRuleInput {
  return {
    frequency: "monthly",
    intervalCount: 1,
    dayOfMonth: 15,
    startDate: "2026-01-01",
    timeOfDay: "09:00",
    ...overrides,
  };
}

describe("validateRecurrenceRuleInput", () => {
  it("accepts a valid monthly rule", () => {
    expect(validateRecurrenceRuleInput(baseInput())).toEqual([]);
  });

  it("accepts a valid weekly rule", () => {
    expect(
      validateRecurrenceRuleInput(
        baseInput({ frequency: "weekly", dayOfMonth: undefined, dayOfWeek: 3 }),
      ),
    ).toEqual([]);
  });

  it("accepts a valid daily rule", () => {
    expect(
      validateRecurrenceRuleInput(baseInput({ frequency: "daily", dayOfMonth: undefined })),
    ).toEqual([]);
  });

  it("accepts an optional end date on or after the start date", () => {
    expect(
      validateRecurrenceRuleInput(baseInput({ endDate: "2026-01-01" })),
    ).toEqual([]);
    expect(
      validateRecurrenceRuleInput(baseInput({ endDate: "2026-06-01" })),
    ).toEqual([]);
  });

  it("rejects an unsupported frequency", () => {
    const errors = validateRecurrenceRuleInput(
      baseInput({ frequency: "yearly" as ProcessRecurrenceRuleInput["frequency"] }),
    );
    expect(errors).toContain("Choose how often this should repeat.");
  });

  it("rejects an interval count out of bounds", () => {
    expect(validateRecurrenceRuleInput(baseInput({ intervalCount: 0 }))).toContain(
      "Every must be a whole number between 1 and 999.",
    );
    expect(validateRecurrenceRuleInput(baseInput({ intervalCount: 1000 }))).toContain(
      "Every must be a whole number between 1 and 999.",
    );
    expect(validateRecurrenceRuleInput(baseInput({ intervalCount: 1.5 }))).toContain(
      "Every must be a whole number between 1 and 999.",
    );
  });

  it("requires a day of week for weekly and rejects it out of range", () => {
    expect(
      validateRecurrenceRuleInput(baseInput({ frequency: "weekly", dayOfMonth: undefined })),
    ).toContain("Choose a day of the week.");
    expect(
      validateRecurrenceRuleInput(
        baseInput({ frequency: "weekly", dayOfMonth: undefined, dayOfWeek: 7 }),
      ),
    ).toContain("Choose a day of the week.");
  });

  it("rejects a day of week supplied for a non-weekly frequency", () => {
    expect(
      validateRecurrenceRuleInput(baseInput({ dayOfWeek: 2 })),
    ).toContain("Day of week only applies to a weekly schedule.");
  });

  it("requires a day of month for monthly and rejects it out of range", () => {
    expect(
      validateRecurrenceRuleInput(baseInput({ dayOfMonth: undefined })),
    ).toContain("Choose a day of the month (1-31).");
    expect(validateRecurrenceRuleInput(baseInput({ dayOfMonth: 32 }))).toContain(
      "Choose a day of the month (1-31).",
    );
    expect(validateRecurrenceRuleInput(baseInput({ dayOfMonth: 0 }))).toContain(
      "Choose a day of the month (1-31).",
    );
  });

  it("rejects a day of month supplied for a non-monthly frequency", () => {
    expect(
      validateRecurrenceRuleInput(
        baseInput({ frequency: "daily", dayOfMonth: 15 }),
      ),
    ).toContain("Day of month only applies to a monthly schedule.");
  });

  it("rejects an invalid or malformed start date", () => {
    expect(validateRecurrenceRuleInput(baseInput({ startDate: "not-a-date" }))).toContain(
      "Start date must be a valid date.",
    );
    expect(validateRecurrenceRuleInput(baseInput({ startDate: "2026-02-30" }))).toContain(
      "Start date must be a valid date.",
    );
  });

  it("rejects an end date before the start date", () => {
    expect(
      validateRecurrenceRuleInput(
        baseInput({ startDate: "2026-06-01", endDate: "2026-01-01" }),
      ),
    ).toContain("End date must be on or after the start date.");
  });

  it("rejects a malformed time of day", () => {
    expect(validateRecurrenceRuleInput(baseInput({ timeOfDay: "25:00" }))).toContain(
      "Time must be a valid time of day.",
    );
    expect(validateRecurrenceRuleInput(baseInput({ timeOfDay: "9am" }))).toContain(
      "Time must be a valid time of day.",
    );
  });
});
