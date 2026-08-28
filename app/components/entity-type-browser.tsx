"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { EntityType } from "@/lib/domain/types";

type EntityTypeBrowserProps = {
  entityTypes: EntityType[];
};

// Client-side name filter over an already-fetched, workspace-scoped list.
// This is a quick-jump/browse aid, not a search backend: it does not imply
// broader search capability than the rest of the app currently has.
export function EntityTypeBrowser({ entityTypes }: EntityTypeBrowserProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return entityTypes;
    }

    return entityTypes.filter((entityType) =>
      entityType.name.toLowerCase().includes(normalized),
    );
  }, [entityTypes, query]);

  return (
    <div>
      <label className="sr-only" htmlFor="object-search">
        Search business objects
      </label>
      <input
        id="object-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search business objects"
        className="mb-4 h-10 w-full max-w-sm border border-grit bg-paper px-3 text-sm text-graphite placeholder:text-stone"
      />
      {entityTypes.length === 0 ? (
        <p className="text-sm text-stone">No business objects yet.</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-stone">No business objects match &ldquo;{query}&rdquo;.</p>
      ) : (
        <ul className="divide-y divide-grit border border-grit bg-white">
          {filtered.map((entityType) => (
            <li key={entityType.id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <h3 className="font-medium text-graphite">
                  <Link href={`/entities/${entityType.id}`} className="underline-offset-4 hover:underline">
                    {entityType.name}
                  </Link>
                </h3>
                {entityType.archivedAt ? (
                  <p className="mt-1 text-xs font-medium uppercase tracking-wide text-stone">Archived</p>
                ) : null}
                {entityType.description ? (
                  <p className="mt-1 truncate text-sm text-stone">{entityType.description}</p>
                ) : null}
              </div>
              <Link
                href={`/entities/${entityType.id}`}
                className="shrink-0 border border-brass bg-brass px-3 py-2 text-xs font-medium text-graphite hover:bg-brass-deep hover:text-paper"
              >
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
