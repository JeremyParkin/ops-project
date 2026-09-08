"use client";

import { Fragment, useState, useTransition } from "react";
import { useUserDisplayPreferences } from "@/app/components/user-display-preferences";
import { loadMoreAdministrativeHistory } from "@/app/workspace-administrative-history-actions";
import { formatDisplayTimestamp } from "@/lib/domain/display-time";
import {
  administrativeHistoryActorLabel,
  administrativeHistoryDetailLabel,
  formatWorkspaceAdministrativeHistoryEvent,
} from "@/lib/domain/workspace-administrative-history-copy";
import type {
  WorkspaceAdministrativeHistoryCursor,
  WorkspaceAdministrativeHistoryEvent,
  WorkspaceAdministrativeHistoryFilters,
} from "@/lib/domain/workspace-administrative-history-repository";

const categories = ["Schema", "Access", "Organization", "People & Identity", "Sensitive Configuration", "Support / Impersonation"];
const datePresets = ["7", "30", "90", "all"];

function displayDetail(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not set";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "Available";
}

function HistoryRow({ event }: { event: WorkspaceAdministrativeHistoryEvent }) {
  const { timezone } = useUserDisplayPreferences();
  const copy = formatWorkspaceAdministrativeHistoryEvent(event);
  const detailEntries = Object.entries(event.details).filter(([, value]) => value !== null && value !== undefined);
  return (
    <li className="border-b border-grit py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-graphite">{copy.title}</p>
          <p className="mt-1 text-sm text-stone">{administrativeHistoryActorLabel(event)} · {copy.subject}</p>
        </div>
        <div className="shrink-0 text-right text-xs text-stone">
          <p>{event.category}</p>
          <time dateTime={event.occurredAt}>{formatDisplayTimestamp(event.occurredAt, { timeZone: timezone, style: "full" })}</time>
        </div>
      </div>
      <details className="group mt-2">
        <summary className="inline-flex cursor-pointer list-none text-sm font-medium text-graphite underline decoration-stone underline-offset-4 [&::-webkit-details-marker]:hidden">
          Details <span aria-hidden="true" className="ml-1 group-open:rotate-90">▸</span>
        </summary>
        <dl className="mt-3 grid gap-2 border-l-2 border-slab pl-3 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
          {detailEntries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-medium text-stone">{administrativeHistoryDetailLabel(key)}</dt>
              <dd className="min-w-0 break-words text-graphite">{displayDetail(value)}</dd>
            </div>
          ))}
          {event.correlationId ? <Fragment key="correlation"><dt className="font-medium text-stone">Related changes</dt><dd className="break-all text-graphite">{event.correlationId}</dd></Fragment> : null}
        </dl>
      </details>
    </li>
  );
}

export function WorkspaceAdministrativeHistoryClient({
  initialEvents,
  initialCursor,
  initialFilters,
  initialDatePreset,
}: {
  initialEvents: WorkspaceAdministrativeHistoryEvent[];
  initialCursor: WorkspaceAdministrativeHistoryCursor | null;
  initialFilters: WorkspaceAdministrativeHistoryFilters;
  initialDatePreset: string;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const loadMore = () => {
    if (!cursor) return;
    setLoadError(null);
    startTransition(async () => {
      try {
        const next = await loadMoreAdministrativeHistory(cursor, initialFilters);
        setEvents((current) => [...current, ...next.events]);
        setCursor(next.nextCursor);
      } catch {
        setLoadError("More history couldn’t be loaded. Try again.");
      }
    });
  };

  return (
    <>
      <form method="get" className="flex flex-wrap items-end gap-3 border-b border-grit pb-4">
        <label className="grid gap-1 text-sm text-graphite">
          <span className="font-medium">Category</span>
          <select name="category" defaultValue={initialFilters.category ?? ""} className="h-9 min-w-52 border border-grit bg-paper px-2">
            <option value="">All categories</option>
            {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm text-graphite">
          <span className="font-medium">Date range</span>
          <select name="days" defaultValue={initialDatePreset} className="h-9 min-w-36 border border-grit bg-paper px-2">
            {datePresets.map((days) => <option key={days} value={days}>{days === "all" ? "All available" : `Last ${days} days`}</option>)}
          </select>
        </label>
        <button type="submit" className="h-9 border border-graphite px-3 text-sm font-medium text-graphite hover:bg-slab">Apply filters</button>
        {initialFilters.category || initialFilters.startAt ? <a href="/settings/history" className="h-9 px-2 text-sm leading-9 text-stone underline">Clear filters</a> : null}
      </form>
      {events.length === 0 ? (
        <p className="py-8 text-sm text-stone">{initialFilters.category || initialFilters.startAt ? "No changes match these filters." : "No administrative changes have been recorded here yet."}</p>
      ) : (
        <ol className="divide-y-0" aria-label="Administrative history events">
          {events.map((event) => <HistoryRow key={event.eventId} event={event} />)}
        </ol>
      )}
      {cursor ? (
        <>
          {loadError ? <p role="alert" className="text-sm text-stone">{loadError}</p> : null}
          <button type="button" onClick={loadMore} disabled={isPending} className="self-start border border-graphite px-4 py-2 text-sm font-medium text-graphite hover:bg-slab disabled:cursor-wait disabled:opacity-60">
            {isPending ? "Loading…" : loadError ? "Try again" : "Load more"}
          </button>
        </>
      ) : null}
    </>
  );
}
