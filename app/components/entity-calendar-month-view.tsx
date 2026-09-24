"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, type MouseEvent } from "react";
import { CalendarMoreDisclosure } from "@/app/components/calendar-more-disclosure";
import {
  buildCalendarViewModel,
  nextCalendarMonth,
  parseCalendarMonth,
  previousCalendarMonth,
  type CalendarMonth,
  type CalendarRecord,
  type CalendarSourceRecord,
} from "@/lib/domain/calendar-view";

export const CALENDAR_DAY_VISIBLE_RECORD_LIMIT = 3;

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type EntityCalendarMonthViewProps = {
  entityName: string;
  calendarFieldName: string;
  records: CalendarSourceRecord[];
  initialMonth: CalendarMonth;
  currentMonth: CalendarMonth;
  todayKey: string;
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

function resolveUrlMonth(searchParams: URLSearchParams, fallbackMonth: CalendarMonth) {
  const monthValues = searchParams.getAll("month");

  if (monthValues.length !== 1) {
    return fallbackMonth;
  }

  return parseCalendarMonth(monthValues[0]) ?? fallbackMonth;
}

function isPlainPrimaryActivation(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0) {
    return false;
  }

  const target = event.currentTarget.getAttribute("target");

  return (
    (!target || target === "_self") &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
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

export function EntityCalendarMonthView({
  entityName,
  calendarFieldName,
  records,
  initialMonth,
  currentMonth,
  todayKey,
}: EntityCalendarMonthViewProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const liveSearchParams = useMemo(
    () => new URLSearchParams(searchParams.toString()),
    [searchParams],
  );
  const month = resolveUrlMonth(liveSearchParams, initialMonth);
  const model = useMemo(
    () => buildCalendarViewModel({ month, records }),
    [month, records],
  );
  const monthHeading = formatMonthHeading(month);

  function hrefFor(monthKey: string) {
    const nextParams = new URLSearchParams(liveSearchParams);
    nextParams.delete("month");
    nextParams.set("month", monthKey);
    const query = nextParams.toString();

    return query ? `${pathname}?${query}` : pathname;
  }

  function navigateMonth(event: MouseEvent<HTMLAnchorElement>, monthKey: string) {
    if (!isPlainPrimaryActivation(event)) {
      return;
    }

    event.preventDefault();

    const nextParams = new URLSearchParams(window.location.search);
    nextParams.delete("month");
    nextParams.set("month", monthKey);
    const query = nextParams.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;

    window.history.pushState(null, "", nextUrl);
  }

  const previousMonth = previousCalendarMonth(month);
  const nextMonth = nextCalendarMonth(month);
  const previousHref = hrefFor(previousMonth.key);
  const todayHref = hrefFor(currentMonth.key);
  const nextHref = hrefFor(nextMonth.key);

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4" data-testid="entity-calendar-view">
      <div className="border border-grit bg-paper">
        <div className="border-b border-grit bg-chalk px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-stone">Calendar by {calendarFieldName}</p>
            <nav aria-label="Calendar month navigation" className="mt-1 flex flex-wrap items-center gap-2">
              <Link
                href={previousHref}
                scroll={false}
                prefetch={false}
                aria-label="Previous month"
                onClick={(event) => navigateMonth(event, previousMonth.key)}
                className="inline-flex h-8 w-8 items-center justify-center border border-border bg-surface text-lg font-semibold text-foreground hover:bg-background focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
              >
                <span aria-hidden="true">‹</span>
              </Link>
              <h2 className="min-w-0 text-xl font-semibold text-graphite" aria-live="polite" aria-atomic="true">{monthHeading}</h2>
              <Link
                href={nextHref}
                scroll={false}
                prefetch={false}
                aria-label="Next month"
                onClick={(event) => navigateMonth(event, nextMonth.key)}
                className="inline-flex h-8 w-8 items-center justify-center border border-border bg-surface text-lg font-semibold text-foreground hover:bg-background focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
              >
                <span aria-hidden="true">›</span>
              </Link>
              <Link
                href={todayHref}
                scroll={false}
                prefetch={false}
                onClick={(event) => navigateMonth(event, currentMonth.key)}
                className="inline-flex h-9 items-center justify-center border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-background focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
              >
                Today
              </Link>
            </nav>
          </div>
        </div>

        <div className="overflow-x-auto" data-testid="calendar-scroll-container">
          <table className="w-full min-w-[760px] table-fixed border-collapse" aria-label={`${entityName} calendar for ${monthHeading}`}>
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
                    const isToday = cell.inMonth && cell.date === todayKey;

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
                          <span className={`inline-flex h-6 min-w-6 items-center justify-center px-1 text-sm font-semibold ${
                            isToday
                              ? "bg-brass text-graphite"
                              : cell.inMonth
                                ? "text-graphite"
                                : "text-stone"
                          }`}>
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

      <RecordList
        title="Undated"
        description={`Records in this view without a value for ${calendarFieldName}.`}
        records={model.undatedRecords}
        testId="calendar-undated-records"
      />
      <RecordList
        title="Needs date review"
        description={`Records in this view with a non-empty ${calendarFieldName} value that is not a valid YYYY-MM-DD date.`}
        records={model.invalidDateRecords}
        testId="calendar-invalid-date-records"
      />
    </section>
  );
}
