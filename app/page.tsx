import Link from "next/link";
import { createWorkspaceStarterStructure } from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkspaceOnboarding } from "@/app/components/workspace-onboarding";
import {
  PageHeader,
  WorkspacePageLayout,
} from "@/app/components/page-primitives";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { countActiveEntityRecordsByEntityType } from "@/lib/domain/record-repository";
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
  const [allEntityTypes, views] = await Promise.all([
    listEntityTypes({
      workspaceId,
      includeArchived: true,
    }),
    listWorkspaceEntityViews({ workspaceId }),
  ]);
  const entityTypes = showArchivedEntities
    ? allEntityTypes
    : allEntityTypes.filter((entityType) => !entityType.archivedAt);
  const isNewWorkspace = allEntityTypes.length === 0;
  const recordCounts = await countActiveEntityRecordsByEntityType({
    workspaceId,
    entityTypeIds: entityTypes.map((entityType) => entityType.id),
  });
  const viewsByEntityTypeId = new Map<string, typeof views>();

  views.forEach((view) => {
    const entityViews = viewsByEntityTypeId.get(view.entityTypeId) ?? [];
    entityViews.push(view);
    viewsByEntityTypeId.set(view.entityTypeId, entityViews);
  });

  return (
    <WorkspacePageLayout
      navigation={<WorkspaceNavigation
        entityTypes={entityTypes}
        activeSection="home"
        showArchivedEntities={showArchivedEntities}
      />}
    >
        <PageHeader eyebrow="Workspace" title="Home" />

        {isNewWorkspace ? (
          <WorkspaceOnboarding
            createWorkspaceStarterStructureAction={createWorkspaceStarterStructure}
          />
        ) : entityTypes.length > 0 ? (
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
                  className="flex min-h-52 flex-col border border-slate-200 bg-white p-5"
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
                  <p className="mt-3 text-sm text-slate-600">
                    {recordCounts.get(entityType.id) ?? 0} active record
                    {(recordCounts.get(entityType.id) ?? 0) === 1 ? "" : "s"}
                  </p>
                  <div className="mt-auto flex flex-wrap gap-2 pt-5">
                    <Link
                      href={
                        showArchivedEntities
                          ? `/entities/${entityType.id}?showArchivedEntities=true`
                          : `/entities/${entityType.id}`
                      }
                      className="border border-slate-950 bg-slate-950 px-3 py-2 text-xs font-medium text-white underline-offset-4 hover:bg-slate-800 hover:underline"
                    >
                      Open
                    </Link>
                    {!entityType.archivedAt ? (
                      <Link
                        href={`/entities/${entityType.id}#add-record`}
                        className="border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 underline-offset-4 hover:bg-slate-50 hover:underline"
                      >
                        Add {entityType.name}
                      </Link>
                    ) : null}
                    <Link
                      href={`/entities/${entityType.id}?view=all`}
                      className="border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 underline-offset-4 hover:bg-slate-50 hover:underline"
                    >
                      All Records
                    </Link>
                    {savedViewShortcuts.map((view) => (
                      <Link
                        key={view.id}
                        href={`/entities/${entityType.id}?view=${view.id}`}
                        className="border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 underline-offset-4 hover:bg-slate-50 hover:underline"
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
              Your workspace has archived entities. Manage them from Workspace setup to restore
              one or create a new entity.
            </p>
          </section>
        )}
    </WorkspacePageLayout>
  );
}
