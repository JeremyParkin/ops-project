"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { CollapsibleSection } from "@/app/components/page-primitives";
import { formatActivityEvent } from "@/lib/domain/activity-copy";
import type { RecordActivityEvent } from "@/lib/domain/activity-types";

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function ActivityTimestamp({ value }: { value: string }) {
  // No user timezone on the server -- delay local formatting until
  // hydration, matching NotificationTimestamp/ProcessDueAt's pattern.
  const isHydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return <time dateTime={value}>{isHydrated ? formatTimestamp(value) : ""}</time>;
}

// Read-only, compact, newest-first -- no controls, no pagination (v1 caps
// at 20 server-side). Deliberately renders even when empty ("No activity
// yet.") rather than being hidden like ProcessSection, per the honesty
// principle: an old record with no durable events gets an honest empty
// timeline, never a fabricated one.
export function RecordActivity({ events }: { events: RecordActivityEvent[] }) {
  return (
    <CollapsibleSection title="Activity">
      {events.length === 0 ? (
        <p className="mt-4 text-sm text-stone">No activity yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-chalk">
          {events.map((event) => {
            const copy = formatActivityEvent(event);
            const body = (
              <>
                <span className="text-sm text-graphite">{copy.title}</span>
                <span className="mt-0.5 block text-xs text-stone">
                  <ActivityTimestamp value={event.createdAt} />
                  {copy.meta ? ` · ${copy.meta}` : ""}
                </span>
              </>
            );

            return (
              <li key={event.id} className="flex items-start gap-2.5 py-2.5">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slab/40"
                />
                <div className="min-w-0 flex-1">
                  {copy.href ? (
                    <Link href={copy.href} className="hover:underline">
                      {body}
                    </Link>
                  ) : (
                    <div>{body}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </CollapsibleSection>
  );
}
