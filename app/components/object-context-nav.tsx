import Link from "next/link";
import type { EntityType } from "@/lib/domain/types";
import type { EntityView } from "@/lib/domain/view-types";

type ObjectContextNavProps = {
  entityType: EntityType;
  views: EntityView[];
  selectedView?: EntityView;
  highlightAll?: boolean;
};

function railLinkClass(isActive: boolean) {
  return `block px-3 py-2 text-sm font-medium ${
    isActive ? "bg-brass text-graphite" : "text-stone hover:bg-chalk hover:text-graphite"
  }`;
}

// Contextual navigation for a single business object: saved Views are
// presented as ways of seeing the object (matching the object page's own
// nav), not as configuration. Editing/creating a view happens in-page via
// the "Manage views" section this links into, not here.
export function ObjectContextNav({
  entityType,
  views,
  selectedView,
  highlightAll = true,
}: ObjectContextNavProps) {
  return (
    <aside
      className="w-full shrink-0 self-start lg:sticky lg:top-5 lg:w-56"
      aria-label={`${entityType.name} navigation`}
    >
      <p className="mb-2 truncate text-xs font-semibold uppercase tracking-wide text-stone">
        {entityType.name}
      </p>
      <nav className="flex flex-col gap-1">
        <Link
          href={`/entities/${entityType.id}?view=all`}
          aria-current={highlightAll && !selectedView ? "page" : undefined}
          className={railLinkClass(highlightAll && !selectedView)}
        >
          All {entityType.name}
        </Link>
        {views.map((view) => (
          <Link
            key={view.id}
            href={`/entities/${entityType.id}?view=${view.id}`}
            aria-current={selectedView?.id === view.id ? "page" : undefined}
            className={railLinkClass(selectedView?.id === view.id)}
          >
            {view.name}
            {view.isDefault ? " · Default" : ""}
          </Link>
        ))}
      </nav>
      <div className="mt-2 border-t border-grit pt-2">
        <Link
          href={`/entities/${entityType.id}?view=all&newView=true#manage-views`}
          className="block px-3 py-2 text-sm font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
        >
          + New view
        </Link>
      </div>
    </aside>
  );
}
