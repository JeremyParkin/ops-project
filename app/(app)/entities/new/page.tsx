import { createEntityDefinition } from "@/app/actions";
import { EntityCreateForm } from "@/app/components/entity-create-form";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";

export const dynamic = "force-dynamic";

export default async function NewEntityPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const activeEntityTypes = await listEntityTypes({ workspaceId });

  return (
    <WorkspacePageLayout>
      <EntityCreateForm
        entityTypes={activeEntityTypes}
        createEntityDefinitionAction={createEntityDefinition}
      />
    </WorkspacePageLayout>
  );
}
