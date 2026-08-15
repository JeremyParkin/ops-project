import { createEntityDefinition } from "@/app/actions";
import { EntityCreateForm } from "@/app/components/entity-create-form";
import { EntityNavigation } from "@/app/components/entity-navigation";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
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
  const showArchivedEntities = showArchivedEntitiesParam === "true";
  const [navigationEntityTypes, activeEntityTypes] = await Promise.all([
    listEntityTypes({
      workspaceId: DEMO_WORKSPACE_ID,
      includeArchived: showArchivedEntities,
    }),
    listEntityTypes({ workspaceId: DEMO_WORKSPACE_ID }),
  ]);

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <EntityNavigation
        entityTypes={navigationEntityTypes}
        showArchivedEntities={showArchivedEntities}
      />
      <EntityCreateForm
        entityTypes={activeEntityTypes}
        createEntityDefinitionAction={createEntityDefinition}
      />
    </main>
  );
}
