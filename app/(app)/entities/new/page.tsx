import { redirect } from "next/navigation";
import { createEntityDefinition } from "@/app/actions";
import { EntityCreateForm } from "@/app/components/entity-create-form";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";

export const dynamic = "force-dynamic";

export default async function NewEntityPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const permissions = await getWorkspacePermissionContext(workspaceId);

  if (!permissions?.capabilities.has("schema.manage")) {
    redirect("/");
  }

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
