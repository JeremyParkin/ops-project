import type { ProcessRecurrenceRuleInput, RecurrenceFrequency } from "./recurrence-types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Pure, dependency-free form-level validation -- the RPC re-validates
// authoritatively (frequency-specific fields, interval bounds, date
// ordering) via table CHECK constraints; this exists only to give the
// builder form fast, specific feedback before the round trip.
export function validateRecurrenceRuleInput(
  input: ProcessRecurrenceRuleInput,
): string[] {
  const errors: string[] = [];
  const frequencies: RecurrenceFrequency[] = ["daily", "weekly", "monthly"];

  if (!frequencies.includes(input.frequency)) {
    errors.push("Choose how often this should repeat.");
  }

  if (
    !Number.isInteger(input.intervalCount) ||
    input.intervalCount < 1 ||
    input.intervalCount > 999
  ) {
    errors.push("Every must be a whole number between 1 and 999.");
  }

  if (input.frequency === "weekly") {
    if (
      input.dayOfWeek === undefined ||
      !Number.isInteger(input.dayOfWeek) ||
      input.dayOfWeek < 0 ||
      input.dayOfWeek > 6
    ) {
      errors.push("Choose a day of the week.");
    }
  } else if (input.dayOfWeek !== undefined) {
    errors.push("Day of week only applies to a weekly schedule.");
  }

  if (input.frequency === "monthly") {
    if (
      input.dayOfMonth === undefined ||
      !Number.isInteger(input.dayOfMonth) ||
      input.dayOfMonth < 1 ||
      input.dayOfMonth > 31
    ) {
      errors.push("Choose a day of the month (1-31).");
    }
  } else if (input.dayOfMonth !== undefined) {
    errors.push("Day of month only applies to a monthly schedule.");
  }

  if (!isValidCalendarDate(input.startDate)) {
    errors.push("Start date must be a valid date.");
  }

  if (input.endDate !== undefined) {
    if (!isValidCalendarDate(input.endDate)) {
      errors.push("End date must be a valid date.");
    } else if (isValidCalendarDate(input.startDate) && input.endDate < input.startDate) {
      errors.push("End date must be on or after the start date.");
    }
  }

  if (!TIME_PATTERN.test(input.timeOfDay)) {
    errors.push("Time must be a valid time of day.");
  }

  return errors;
}
