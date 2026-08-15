import { createWorkflow } from "@/app/actions";
import { EntityNavigation } from "@/app/components/entity-navigation";
import { WorkflowCreateForm } from "@/app/components/workflow-create-form";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import { getRelationLookups } from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

export default async function NewWorkflowPage() {
  const entityTypes = await listEntityTypes({ workspaceId: DEMO_WORKSPACE_ID });
  const entityContexts = await Promise.all(
    entityTypes.map(async (entityType) => {
      const context = await getEntityContext({
        workspaceId: DEMO_WORKSPACE_ID,
        entityTypeId: entityType.id,
      });
      const relationLookups = await getRelationLookups({
        workspaceId: DEMO_WORKSPACE_ID,
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
      <EntityNavigation entityTypes={entityTypes} />
      <WorkflowCreateForm
        mode="create"
        entityContexts={entityContexts}
        submitAction={createWorkflow}
      />
    </main>
  );
}
