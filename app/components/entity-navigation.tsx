import Link from "next/link";
import type { EntityType } from "@/lib/domain/types";

type EntityNavigationProps = {
  entityTypes: EntityType[];
  activeEntityTypeId?: string;
  showArchivedEntities?: boolean;
};

export function EntityNavigation({
  entityTypes,
  activeEntityTypeId,
  showArchivedEntities = false,
}: EntityNavigationProps) {
  return (
    <aside className="w-full border border-slate-200 bg-white p-4 lg:w-64">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Entities
        </h2>
        <Link
          href="/entities/new"
          className="text-sm font-medium text-slate-950 underline-offset-4 hover:underline"
        >
          New
        </Link>
      </div>
      <nav className="flex flex-col gap-1">
        {entityTypes.map((entityType) => {
          const isActive = entityType.id === activeEntityTypeId;

          return (
            <Link
              key={entityType.id}
              href={
                showArchivedEntities
                  ? `/entities/${entityType.id}?showArchivedEntities=true`
                  : `/entities/${entityType.id}`
              }
              className={`px-3 py-2 text-sm ${
                isActive
                  ? "bg-slate-950 text-white"
                  : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              <span className="flex items-center justify-between gap-3">
                <span>{entityType.name}</span>
                {entityType.archivedAt ? (
                  <span
                    className={`text-xs uppercase tracking-wide ${
                      isActive ? "text-slate-200" : "text-slate-400"
                    }`}
                  >
                    Archived
                  </span>
                ) : null}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="mt-4 border-t border-slate-100 pt-4">
        <Link
          href="/workflows"
          className="mb-3 block text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
        >
          Workflows
        </Link>
        <Link
          href={
            activeEntityTypeId
              ? showArchivedEntities
                ? `/entities/${activeEntityTypeId}`
                : `/entities/${activeEntityTypeId}?showArchivedEntities=true`
              : showArchivedEntities
                ? "/entities/new"
                : "/entities/new?showArchivedEntities=true"
          }
          className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
        >
          {showArchivedEntities ? "Hide archived entities" : "Show archived entities"}
        </Link>
      </div>
    </aside>
  );
}
