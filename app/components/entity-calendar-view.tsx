import { EntityCalendarMonthView } from "@/app/components/entity-calendar-month-view";
import {
  type CalendarMonth,
} from "@/lib/domain/calendar-view";
import { getRecordLabel } from "@/lib/domain/record-repository";
import type { EntityRecord, EntityType, FieldDefinition } from "@/lib/domain/types";

type EntityCalendarViewProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  records: EntityRecord[];
  calendarField: FieldDefinition;
  month: CalendarMonth;
  currentMonth: CalendarMonth;
};

function todayDateKeyUtc(currentMonth: CalendarMonth) {
  const day = new Date().getUTCDate();

  return `${currentMonth.key}-${String(day).padStart(2, "0")}`;
}

export function EntityCalendarView({
  entityType,
  fields,
  records,
  calendarField,
  month,
  currentMonth,
}: EntityCalendarViewProps) {
  const snapshots = records.map((record) => ({
    id: record.id,
    label: getRecordLabel({ entityType, fields, record }),
    href: `/entities/${entityType.id}/records/${record.id}`,
    dateValue: record.values[calendarField.key],
  }));

  return (
    <EntityCalendarMonthView
      entityName={entityType.name}
      calendarFieldName={calendarField.name}
      records={snapshots}
      initialMonth={month}
      currentMonth={currentMonth}
      todayKey={todayDateKeyUtc(currentMonth)}
    />
  );
}
