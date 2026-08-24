"use client";

import { useSyncExternalStore } from "react";

function formatDueAt(dueAt: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(dueAt));
}

export function ProcessDueAt({ dueAt, prefix = "Due" }: { dueAt: string; prefix?: string }) {
  // The server has no user timezone. Delay local formatting until hydration
  // so the browser is the single source for this absolute timestamp's display.
  const isHydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return (
    <span>
      {prefix} <time dateTime={dueAt}>{isHydrated ? formatDueAt(dueAt) : "date"}</time>
    </span>
  );
}
