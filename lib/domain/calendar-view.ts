export type CalendarMonth = {
  year: number;
  month: number;
  key: string;
};

export type CalendarSourceRecord = {
  id: string;
  label: string;
  href: string;
  dateValue: unknown;
};

export type CalendarRecord = {
  id: string;
  label: string;
  href: string;
  dateValue?: string;
};

export type CalendarDayCell = {
  date: string;
  day: number;
  inMonth: boolean;
  records: CalendarRecord[];
};

export type CalendarViewModel = {
  month: CalendarMonth;
  weeks: CalendarDayCell[][];
  undatedRecords: CalendarRecord[];
  invalidDateRecords: CalendarRecord[];
  outsideMonthRecordCount: number;
  displayedRecordCount: number;
};

const monthPattern = /^(\d{4})-(\d{2})$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const calendarGridDayCount = 42;

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function monthKey(year: number, month: number) {
  return `${year}-${pad2(month)}`;
}

function dateKey(year: number, month: number, day: number) {
  return `${monthKey(year, month)}-${pad2(day)}`;
}

function daysInMonth(year: number, month: number) {
  if (month === 2) {
    if (year % 400 === 0) return 29;
    if (year % 100 === 0) return 28;
    return year % 4 === 0 ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseCalendarMonth(value: unknown): CalendarMonth | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = monthPattern.exec(value);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return undefined;
  }

  return { year, month, key: monthKey(year, month) };
}

export function currentCalendarMonthUtc(now = new Date()): CalendarMonth {
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    key: monthKey(now.getUTCFullYear(), now.getUTCMonth() + 1),
  };
}

export function resolveCalendarMonth(value: unknown, now = new Date()): CalendarMonth {
  return parseCalendarMonth(value) ?? currentCalendarMonthUtc(now);
}

export function previousCalendarMonth(month: CalendarMonth): CalendarMonth {
  const previousYear = month.month === 1 ? month.year - 1 : month.year;
  const previousMonth = month.month === 1 ? 12 : month.month - 1;

  return { year: previousYear, month: previousMonth, key: monthKey(previousYear, previousMonth) };
}

export function nextCalendarMonth(month: CalendarMonth): CalendarMonth {
  const nextYear = month.month === 12 ? month.year + 1 : month.year;
  const nextMonth = month.month === 12 ? 1 : month.month + 1;

  return { year: nextYear, month: nextMonth, key: monthKey(nextYear, nextMonth) };
}

export function isCanonicalCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const match = datePattern.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

function calendarDateParts(value: string) {
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
  };
}

function addDaysUtc(year: number, month: number, day: number, offset: number) {
  const date = new Date(Date.UTC(year, month - 1, day + offset));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function buildEmptyGrid(month: CalendarMonth): CalendarDayCell[][] {
  const firstDay = new Date(Date.UTC(month.year, month.month - 1, 1)).getUTCDay();
  const start = addDaysUtc(month.year, month.month, 1, -firstDay);
  const cells = Array.from({ length: calendarGridDayCount }, (_, index) => {
    const day = addDaysUtc(start.year, start.month, start.day, index);

    return {
      date: dateKey(day.year, day.month, day.day),
      day: day.day,
      inMonth: day.year === month.year && day.month === month.month,
      records: [],
    };
  });

  return Array.from({ length: calendarGridDayCount / 7 }, (_, weekIndex) =>
    cells.slice(weekIndex * 7, weekIndex * 7 + 7),
  );
}

function toCalendarRecord(record: CalendarSourceRecord, dateValue?: string): CalendarRecord {
  return {
    id: record.id,
    label: record.label,
    href: record.href,
    ...(dateValue ? { dateValue } : {}),
  };
}

export function buildCalendarViewModel({
  month,
  records,
}: {
  month: CalendarMonth;
  records: CalendarSourceRecord[];
}): CalendarViewModel {
  const weeks = buildEmptyGrid(month);
  const cellByDate = new Map(weeks.flatMap((week) => week.map((cell) => [cell.date, cell])));
  const undatedRecords: CalendarRecord[] = [];
  const invalidDateRecords: CalendarRecord[] = [];
  let outsideMonthRecordCount = 0;
  let displayedRecordCount = 0;

  records.forEach((record) => {
    const value = record.dateValue;

    if (value === null || value === undefined || value === "") {
      undatedRecords.push(toCalendarRecord(record));
      return;
    }

    if (!isCanonicalCalendarDate(value)) {
      invalidDateRecords.push(toCalendarRecord(record, typeof value === "string" ? value : undefined));
      return;
    }

    const parts = calendarDateParts(value);
    if (parts.year !== month.year || parts.month !== month.month) {
      outsideMonthRecordCount += 1;
      return;
    }

    const cell = cellByDate.get(value);
    if (cell) {
      cell.records.push(toCalendarRecord(record, value));
      displayedRecordCount += 1;
    }
  });

  return {
    month,
    weeks,
    undatedRecords,
    invalidDateRecords,
    outsideMonthRecordCount,
    displayedRecordCount,
  };
}
