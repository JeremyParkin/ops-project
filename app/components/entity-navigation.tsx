import Link from "next/link";
import { signOut, switchActiveWorkspace } from "@/app/auth-actions";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import type { EntityType } from "@/lib/domain/types";

type WorkspaceNavigationProps = {
  entityTypes: EntityType[];
  activeEntityTypeId?: string;
  activeSection?: "home" | "my-work" | "workflows" | "processes" | "create-entity";
  showArchivedEntities?: boolean;
};

function navigationLinkClass(isActive: boolean) {
  return `px-3 py-2 text-sm font-medium ${
    isActive
      ? "bg-brass text-graphite"
      : "text-grit hover:bg-slab hover:text-chalk"
  }`;
}

export async function WorkspaceNavigation({
  entityTypes,
  activeEntityTypeId,
  activeSection,
  showArchivedEntities = false,
}: WorkspaceNavigationProps) {
  const { memberships, workspaceId } = await getActiveWorkspaceId();
  const homeHref = showArchivedEntities ? "/?showArchivedEntities=true" : "/";
  const createEntityHref = showArchivedEntities
    ? "/entities/new?showArchivedEntities=true"
    : "/entities/new";
  const archiveToggleHref = activeEntityTypeId
    ? showArchivedEntities
      ? `/entities/${activeEntityTypeId}`
      : `/entities/${activeEntityTypeId}?showArchivedEntities=true`
    : activeSection === "home"
      ? showArchivedEntities
        ? "/"
        : "/?showArchivedEntities=true"
      : showArchivedEntities
        ? "/entities/new"
        : "/entities/new?showArchivedEntities=true";

  return (
    <aside className="w-full self-start bg-graphite p-4 lg:sticky lg:top-5 lg:w-64">
      <Link href={homeHref} className="mb-5 block">
        <img
          src="/branding/kinema-L1-brass-white-text.svg"
          alt="Kinema"
          className="h-8 w-auto"
        />
      </Link>
      {memberships.length > 1 ? (
        <form action={switchActiveWorkspace} className="mb-4 flex gap-2">
          <label className="sr-only" htmlFor="active-workspace">
            Active workspace
          </label>
          <select
            id="active-workspace"
            name="workspaceId"
            defaultValue={workspaceId}
            className="min-w-0 flex-1 border border-grit bg-paper px-2 py-1.5 text-sm text-graphite"
          >
            {memberships.map((membership) => (
              <option key={membership.workspaceId} value={membership.workspaceId}>
                {membership.workspaceName}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="border border-grit px-2 text-sm font-medium text-chalk hover:bg-slab"
          >
            Switch
          </button>
        </form>
      ) : null}
      <form action="/search" method="get" className="mb-5 flex gap-2">
        <label className="sr-only" htmlFor="workspace-record-search">
          Search records
        </label>
        <input
          id="workspace-record-search"
          name="q"
          type="search"
          className="min-w-0 flex-1 border border-grit bg-paper px-2 py-1.5 text-sm text-graphite placeholder:text-stone"
          placeholder="Search records"
        />
        <button
          type="submit"
          className="border border-grit px-2 py-1.5 text-sm font-medium text-chalk hover:bg-slab"
        >
          Search
        </button>
      </form>
      <nav className="flex flex-col gap-1" aria-label="Workspace navigation">
        <Link href={homeHref} className={navigationLinkClass(activeSection === "home")}>
          Home
        </Link>
        <Link href="/my-work" className={navigationLinkClass(activeSection === "my-work")}>
          My Work
        </Link>
      </nav>
      <div className="my-5 border-t border-slab" />
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-grit">
        Entities
      </div>
      <nav className="flex flex-col gap-1" aria-label="Entity navigation">
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
              className={navigationLinkClass(isActive)}
            >
              <span className="flex items-center justify-between gap-3">
                <span>{entityType.name}</span>
                {entityType.archivedAt ? (
                  <span
                    className={`text-xs uppercase tracking-wide ${
                      isActive ? "text-graphite/70" : "text-grit"
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
      <div className="mt-4 border-t border-slab pt-4">
        <details
          open={
            activeSection === "workflows" ||
            activeSection === "processes" ||
            activeSection === "create-entity"
          }
        >
          <summary className="cursor-pointer text-sm font-semibold text-chalk">
            Workspace setup
          </summary>
          <nav className="mt-2 flex flex-col gap-1" aria-label="Workspace setup">
            <Link
              href="/workflows"
              className={navigationLinkClass(activeSection === "workflows")}
            >
              Workflows
            </Link>
            <Link
              href="/processes"
              className={navigationLinkClass(activeSection === "processes")}
            >
              Processes
            </Link>
            <Link
              href={createEntityHref}
              className={navigationLinkClass(activeSection === "create-entity")}
            >
              Create entity
            </Link>
            <Link
              href={archiveToggleHref}
              className="px-3 py-2 text-sm font-medium text-grit hover:bg-slab hover:text-chalk"
            >
              {showArchivedEntities ? "Hide archived entities" : "Archived entities"}
            </Link>
          </nav>
        </details>
        <form action={signOut} className="mt-3">
          <button
            type="submit"
            className="text-sm font-medium text-grit underline-offset-4 hover:text-chalk hover:underline"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
