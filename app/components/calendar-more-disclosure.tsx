"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { CalendarRecord } from "@/lib/domain/calendar-view";

export function CalendarMoreDisclosure({
  dateLabel,
  records,
}: {
  dateLabel: string;
  records: CalendarRecord[];
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  return (
    <div className="mt-1" onKeyDown={handleKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? "Hide" : "Show"} ${records.length} more record${records.length === 1 ? "" : "s"} on ${dateLabel}`}
        onClick={() => setOpen((current) => !current)}
        className="text-xs font-medium text-stone underline-offset-4 hover:text-graphite hover:underline focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
      >
        {records.length} more
      </button>
      {open ? (
        <ul id={panelId} role="list" className="mt-1 grid gap-1">
          {records.map((record) => (
            <li key={record.id}>
              <Link
                href={record.href}
                className="block truncate border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground underline-offset-4 hover:bg-background hover:underline focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
              >
                {record.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
