import { createEntityDefinition } from "@/app/actions";
import { EntityCreateForm } from "@/app/components/entity-create-form";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";

export const dynamic = "force-dynamic";

export default async function NewEntityPage({
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
  const [navigationEntityTypes, activeEntityTypes] = await Promise.all([
    listEntityTypes({
      workspaceId,
      includeArchived: showArchivedEntities,
    }),
    listEntityTypes({ workspaceId }),
  ]);

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <WorkspaceNavigation
        entityTypes={navigationEntityTypes}
        activeSection="create-entity"
        showArchivedEntities={showArchivedEntities}
      />
      <EntityCreateForm
        entityTypes={activeEntityTypes}
        createEntityDefinitionAction={createEntityDefinition}
      />
    </main>
  );
}
