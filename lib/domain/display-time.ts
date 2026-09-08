export type DisplayTimeStyle = "compact" | "full";

export function formatDisplayTimestamp(
  value: string,
  { timeZone, style = "compact" }: { timeZone: string | null; style?: DisplayTimeStyle },
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  const options = style === "full"
    ? { dateStyle: "medium" as const, timeStyle: "short" as const }
    : { month: "short" as const, day: "numeric" as const, hour: "numeric" as const, minute: "2-digit" as const };
  return new Intl.DateTimeFormat(undefined, { ...options, ...(timeZone ? { timeZone } : {}) }).format(date);
}
