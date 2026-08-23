import Link from "next/link";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { listWorkspaceEntityViews } from "@/lib/domain/view-repository";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    showArchivedEntities?: string;
  }>;
}) {
  const { showArchivedEntities: showArchivedEntitiesParam } =
    await searchParams;
  const { workspaceId } = await getActiveWorkspaceId();
  const showArchivedEntities = showArchivedEntitiesParam === "true";
  const [entityTypes, views] = await Promise.all([
    listEntityTypes({
      workspaceId,
      includeArchived: showArchivedEntities,
    }),
    listWorkspaceEntityViews({ workspaceId }),
  ]);
  const viewsByEntityTypeId = new Map<string, typeof views>();

  views.forEach((view) => {
    const entityViews = viewsByEntityTypeId.get(view.entityTypeId) ?? [];
    entityViews.push(view);
    viewsByEntityTypeId.set(view.entityTypeId, entityViews);
  });

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <WorkspaceNavigation
        entityTypes={entityTypes}
        activeSection="home"
        showArchivedEntities={showArchivedEntities}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Workspace
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-950">Home</h1>
        </section>

        {entityTypes.length > 0 ? (
          <section className="mx-auto grid w-full max-w-6xl gap-4 md:grid-cols-2 xl:grid-cols-3">
            {entityTypes.map((entityType) => {
              const entityViews = viewsByEntityTypeId.get(entityType.id) ?? [];
              const defaultView = entityViews.find((view) => view.isDefault);
              const additionalViews = entityViews
                .filter((view) => view.id !== defaultView?.id)
                .slice(0, 2);
              const savedViewShortcuts = [
                ...(defaultView ? [defaultView] : []),
                ...additionalViews,
              ];

              return (
                <section
                  key={entityType.id}
                  aria-labelledby={`workspace-entity-${entityType.id}`}
                  className="border border-slate-200 bg-white p-5"
                >
                  <Link
                    href={
                      showArchivedEntities
                        ? `/entities/${entityType.id}?showArchivedEntities=true`
                        : `/entities/${entityType.id}`
                    }
                    className="block text-slate-950 underline-offset-4 hover:underline"
                  >
                    <h2
                      id={`workspace-entity-${entityType.id}`}
                      className="text-xl font-semibold"
                    >
                      {entityType.name}
                    </h2>
                    {entityType.description ? (
                      <p className="mt-2 text-sm text-slate-600">{entityType.description}</p>
                    ) : null}
                  </Link>
                  {entityType.archivedAt ? (
                    <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                      Archived
                    </p>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link
                      href={`/entities/${entityType.id}?view=all`}
                      className="border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 underline-offset-4 hover:underline"
                    >
                      All Records
                    </Link>
                    {savedViewShortcuts.map((view) => (
                      <Link
                        key={view.id}
                        href={`/entities/${entityType.id}?view=${view.id}`}
                        className="border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 underline-offset-4 hover:underline"
                      >
                        {view.name}
                        {view.isDefault ? " · Default" : ""}
                      </Link>
                    ))}
                  </div>
                </section>
              );
            })}
          </section>
        ) : (
          <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
            <h2 className="text-xl font-semibold text-slate-950">No active entities yet.</h2>
            <p className="mt-2 text-sm text-slate-600">
              Create an entity to start defining records and workflows.
            </p>
            <Link
              href="/entities/new"
              className="mt-4 inline-flex h-10 items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white"
            >
              Create Entity
            </Link>
          </section>
        )}
      </div>
    </main>
  );
}
