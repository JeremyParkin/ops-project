import Link from "next/link";
import { CalendarMoreDisclosure } from "@/app/components/calendar-more-disclosure";
import {
  buildCalendarViewModel,
  type CalendarMonth,
  type CalendarRecord,
} from "@/lib/domain/calendar-view";
import { getRecordLabel } from "@/lib/domain/record-repository";
import type { EntityRecord, EntityType, FieldDefinition } from "@/lib/domain/types";

export const CALENDAR_DAY_VISIBLE_RECORD_LIMIT = 3;

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type EntityCalendarViewProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  records: EntityRecord[];
  calendarField: FieldDefinition;
  month: CalendarMonth;
  previousHref: string;
  todayHref: string;
  nextHref: string;
};

function formatMonthHeading(month: CalendarMonth) {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(month.year, month.month - 1, 1)));
}

function formatDateLabel(value: string) {
  const [year, month, day] = value.split("-").map(Number);

  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function RecordLink({ record }: { record: CalendarRecord }) {
  return (
    <Link
      href={record.href}
      className="block truncate border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground underline-offset-4 hover:bg-background hover:underline focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
    >
      {record.label}
    </Link>
  );
}

function RecordList({
  title,
  description,
  records,
  testId,
}: {
  title: string;
  description: string;
  records: CalendarRecord[];
  testId: string;
}) {
  if (records.length === 0) {
    return null;
  }

  return (
    <section className="border border-grit bg-paper p-4" data-testid={testId}>
      <h3 className="text-sm font-semibold text-graphite">{title}</h3>
      <p className="mt-1 text-sm text-stone">{description}</p>
      <ul role="list" className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {records.map((record) => (
          <li key={record.id}>
            <Link
              href={record.href}
              className="block border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground underline-offset-4 hover:bg-background hover:underline focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
            >
              {record.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EntityCalendarView({
  entityType,
  fields,
  records,
  calendarField,
  month,
  previousHref,
  todayHref,
  nextHref,
}: EntityCalendarViewProps) {
  const model = buildCalendarViewModel({
    month,
    records: records.map((record) => ({
      id: record.id,
      label: getRecordLabel({ entityType, fields, record }),
      href: `/entities/${entityType.id}/records/${record.id}`,
      dateValue: record.values[calendarField.key],
    })),
  });
  const monthHeading = formatMonthHeading(month);

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4" data-testid="entity-calendar-view">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-grit bg-chalk px-4 py-3">
        <div>
          <p className="text-xs font-semibold uppercase text-stone">Calendar by {calendarField.name}</p>
          <h2 className="text-xl font-semibold text-graphite">{monthHeading}</h2>
        </div>
        <nav aria-label="Calendar month navigation" className="flex flex-wrap items-center gap-2">
          <Link
            href={previousHref}
            className="inline-flex h-9 items-center justify-center border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-background focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
          >
            Previous
          </Link>
          <Link
            href={todayHref}
            className="inline-flex h-9 items-center justify-center border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-background focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
          >
            Today
          </Link>
          <Link
            href={nextHref}
            className="inline-flex h-9 items-center justify-center border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-background focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
          >
            Next
          </Link>
        </nav>
      </div>

      {model.outsideMonthRecordCount > 0 ? (
        <p className="border border-border bg-surface px-4 py-3 text-sm text-muted">
          {model.outsideMonthRecordCount} dated record{model.outsideMonthRecordCount === 1 ? "" : "s"} in this view fall outside {monthHeading}.
        </p>
      ) : null}

      {model.displayedRecordCount === 0 ? (
        <section className="border border-dashed border-grit bg-chalk px-5 py-6 text-center">
          <h3 className="text-lg font-semibold text-graphite">No records fall in this month.</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-stone">
            This calendar still reflects the current view. Records may be undated or dated outside {monthHeading}.
          </p>
        </section>
      ) : null}

      <div className="overflow-x-auto border border-grit bg-paper">
        <table className="min-w-[760px] table-fixed border-collapse" aria-label={`${entityType.name} calendar for ${monthHeading}`}>
          <thead className="bg-chalk">
            <tr>
              {weekdayLabels.map((label) => (
                <th key={label} scope="col" className="border-b border-grit px-3 py-2 text-left text-xs font-semibold uppercase text-stone">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.weeks.map((week, weekIndex) => (
              <tr key={`week-${weekIndex}`}>
                {week.map((cell) => {
                  const visibleRecords = cell.records.slice(0, CALENDAR_DAY_VISIBLE_RECORD_LIMIT);
                  const hiddenRecords = cell.records.slice(CALENDAR_DAY_VISIBLE_RECORD_LIMIT);
                  const dateLabel = formatDateLabel(cell.date);

                  return (
                    <td
                      key={cell.date}
                      aria-label={`${dateLabel}${cell.inMonth ? "" : " outside displayed month"}`}
                      className={`h-36 align-top border-b border-r border-grit p-2 ${
                        cell.inMonth ? "bg-paper" : "bg-chalk text-muted"
                      }`}
                      data-calendar-date={cell.date}
                      data-calendar-in-month={cell.inMonth ? "true" : "false"}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className={`text-sm font-semibold ${cell.inMonth ? "text-graphite" : "text-stone"}`}>
                          {cell.day}
                        </span>
                        {cell.records.length > 0 ? (
                          <span className="text-xs text-stone">
                            {cell.records.length}
                          </span>
                        ) : null}
                      </div>
                      {cell.inMonth && visibleRecords.length > 0 ? (
                        <ul role="list" className="grid gap-1">
                          {visibleRecords.map((record) => (
                            <li key={record.id}>
                              <RecordLink record={record} />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {cell.inMonth && hiddenRecords.length > 0 ? (
                        <CalendarMoreDisclosure dateLabel={dateLabel} records={hiddenRecords} />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <RecordList
        title="Undated"
        description={`Records in this view without a value for ${calendarField.name}.`}
        records={model.undatedRecords}
        testId="calendar-undated-records"
      />
      <RecordList
        title="Needs date review"
        description={`Records in this view with a non-empty ${calendarField.name} value that is not a valid YYYY-MM-DD date.`}
        records={model.invalidDateRecords}
        testId="calendar-invalid-date-records"
      />
    </section>
  );
}
