import { createWorkflow } from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkflowCreateForm } from "@/app/components/workflow-create-form";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import { getRelationLookups } from "@/lib/domain/record-repository";
import { listProcessTemplates } from "@/lib/domain/process-repository";

export const dynamic = "force-dynamic";

export default async function NewWorkflowPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const [entityTypes, processTemplates] = await Promise.all([
    listEntityTypes({ workspaceId }),
    listProcessTemplates({ workspaceId, includeArchived: true }),
  ]);
  const entityContexts = await Promise.all(
    entityTypes.map(async (entityType) => {
      const context = await getEntityContext({
        workspaceId,
        entityTypeId: entityType.id,
      });
      const relationLookups = await getRelationLookups({
        workspaceId,
        fields: context.fields,
      });

      return {
        ...context,
        relationOptionsByFieldId: Object.fromEntries(
          context.fields.map((field) => [
            field.id,
            relationLookups.optionsByFieldKey[field.key] ?? [],
          ]),
        ),
      };
    }),
  );

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <WorkspaceNavigation entityTypes={entityTypes} />
      <WorkflowCreateForm
        mode="create"
        entityContexts={entityContexts}
        processTemplates={processTemplates}
        submitAction={createWorkflow}
      />
    </main>
  );
}
