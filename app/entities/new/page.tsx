import { createEntityDefinition } from "@/app/actions";
import { EntityCreateForm } from "@/app/components/entity-create-form";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
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
    <WorkspacePageLayout
      navigation={<WorkspaceNavigation
        entityTypes={navigationEntityTypes}
        activeSection="create-entity"
        showArchivedEntities={showArchivedEntities}
      />}
    >
      <EntityCreateForm
        entityTypes={activeEntityTypes}
        createEntityDefinitionAction={createEntityDefinition}
      />
    </WorkspacePageLayout>
  );
}
