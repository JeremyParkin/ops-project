import Link from "next/link";
import { createWorkspaceStarterStructure } from "@/app/actions";
import { HomeAttentionSummary } from "@/app/components/home-attention-summary";
import { WorkspaceOnboarding } from "@/app/components/workspace-onboarding";
import {
  PageHeader,
  WorkspacePageLayout,
} from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { listMyWorkItems } from "@/lib/domain/process-repository";
import { countActiveEntityRecordsByEntityType } from "@/lib/domain/record-repository";
import { getManagedPeopleContext, getManagedWorkPortfolio } from "@/lib/domain/manager-portfolio-repository";

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
  const [allEntityTypes, permissions] = await Promise.all([
    listEntityTypes({
      workspaceId,
      includeArchived: true,
    }),
    getWorkspacePermissionContext(workspaceId),
  ]);
  const entityTypes = showArchivedEntities
    ? allEntityTypes
    : allEntityTypes.filter((entityType) => !entityType.archivedAt);
  const isNewWorkspace = allEntityTypes.length === 0;

  if (isNewWorkspace) {
    return (
      <WorkspacePageLayout>
        <PageHeader eyebrow="Workspace" title="Home" />
        <WorkspaceOnboarding
          createWorkspaceStarterStructureAction={createWorkspaceStarterStructure}
        />
      </WorkspacePageLayout>
    );
  }

  const canViewManagerPortfolio = Boolean(permissions?.capabilities.has("operations.view"));
  const [recordCounts, myWorkSummary, managedPeople] = await Promise.all([
    countActiveEntityRecordsByEntityType({
      workspaceId,
      entityTypeIds: entityTypes.map((entityType) => entityType.id),
    }),
    listMyWorkItems({ workspaceId }),
    canViewManagerPortfolio ? getManagedPeopleContext({ workspaceId }) : Promise.resolve([]),
  ]);
  const teamOverdueCount = managedPeople.length
    ? (
        await getManagedWorkPortfolio({
          workspaceId,
          people: managedPeople,
          filter: { kind: "all" },
        })
      ).overdue.length
    : 0;

  return (
    <WorkspacePageLayout>
      <PageHeader eyebrow="Workspace" title="Home" />

      <HomeAttentionSummary summary={myWorkSummary} />

      {managedPeople.length > 0 ? (
        <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-4">
          <p className="text-sm text-stone">
            {teamOverdueCount > 0 ? (
              <>
                <span className="font-semibold text-graphite">{teamOverdueCount}</span>{" "}
                overdue item{teamOverdueCount === 1 ? "" : "s"} across your team.{" "}
              </>
            ) : (
              "Your team has no overdue work right now. "
            )}
            <Link
              href="/team-work"
              className="font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
            >
              View Team Work
            </Link>
          </p>
        </section>
      ) : null}

      {entityTypes.length > 0 ? (
        <section className="mx-auto w-full max-w-6xl">
          <h2 className="mb-3 text-lg font-semibold text-graphite">Business objects</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {entityTypes.map((entityType) => (
              <section
                key={entityType.id}
                aria-labelledby={`workspace-entity-${entityType.id}`}
                className="flex min-h-40 flex-col border border-grit bg-white p-5"
              >
                <Link
                  href={
                    showArchivedEntities
                      ? `/entities/${entityType.id}?showArchivedEntities=true`
                      : `/entities/${entityType.id}`
                  }
                  className="block text-graphite underline-offset-4 hover:underline"
                >
                  <h3
                    id={`workspace-entity-${entityType.id}`}
                    className="text-xl font-semibold"
                  >
                    {entityType.name}
                  </h3>
                  {entityType.description ? (
                    <p className="mt-2 text-sm text-stone">{entityType.description}</p>
                  ) : null}
                </Link>
                {entityType.archivedAt ? (
                  <p className="mt-2 text-xs font-medium uppercase tracking-wide text-stone">
                    Archived
                  </p>
                ) : null}
                <p className="mt-3 text-sm text-stone">
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
                    className="border border-brass bg-brass px-3 py-2 text-xs font-medium text-graphite underline-offset-4 hover:bg-brass-deep hover:text-paper hover:underline"
                  >
                    Open
                  </Link>
                  {!entityType.archivedAt ? (
                    <Link
                      href={`/entities/${entityType.id}#add-record`}
                      className="border border-grit px-3 py-2 text-xs font-medium text-stone underline-offset-4 hover:bg-slab/5 hover:underline"
                    >
                      Add {entityType.name}
                    </Link>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </section>
      ) : (
        <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
          <h2 className="text-xl font-semibold text-graphite">No active business objects yet.</h2>
          <p className="mt-2 text-sm text-stone">
            Your workspace has archived business objects. Check with your workspace admin to
            restore one or create a new one.
          </p>
        </section>
      )}
    </WorkspacePageLayout>
  );
}
