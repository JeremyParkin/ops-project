import { notFound } from "next/navigation";
import { updateWorkflow } from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkflowDefinitionForm } from "@/app/components/workflow-create-form";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import { getRelationLookups } from "@/lib/domain/record-repository";
import {
  createWorkflowFormStateFromDefinition,
} from "@/lib/domain/workflow-validation";
import { getWorkflow } from "@/lib/domain/workflow-repository";

export const dynamic = "force-dynamic";

async function getWorkflowEntityContexts() {
  const entityTypes = await listEntityTypes({ workspaceId: DEMO_WORKSPACE_ID });
  const entityContexts = await Promise.all(
    entityTypes.map(async (entityType) => {
      const context = await getEntityContext({
        workspaceId: DEMO_WORKSPACE_ID,
        entityTypeId: entityType.id,
        includeArchivedFields: true,
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

  return {
    entityTypes,
    entityContexts,
  };
}

async function loadEditWorkflowPageData(workflowId: string) {
  try {
    const [{ entityTypes, entityContexts }, workflow] = await Promise.all([
      getWorkflowEntityContexts(),
      getWorkflow({
        workspaceId: DEMO_WORKSPACE_ID,
        workflowId,
      }),
    ]);

    return {
      entityTypes,
      entityContexts,
      workflow,
    };
  } catch {
    return null;
  }
}

export default async function EditWorkflowPage({
  params,
}: {
  params: Promise<{
    workflowId: string;
  }>;
}) {
  const { workflowId } = await params;
  const pageData = await loadEditWorkflowPageData(workflowId);

  if (!pageData) {
    notFound();
  }

  const { entityTypes, entityContexts, workflow } = pageData;
  const sourceEntityContext = entityContexts.find(
    (context) => context.entityType.id === workflow.triggerEntityTypeId,
  );
  const entityNameById = Object.fromEntries(
    entityContexts.map((context) => [
      context.entityType.id,
      context.entityType.name,
    ]),
  );
  const updateWorkflowAction = updateWorkflow.bind(null, {
    workflowId: workflow.id,
  });

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <WorkspaceNavigation entityTypes={entityTypes} />
      <WorkflowDefinitionForm
        mode="edit"
        entityContexts={entityContexts}
        initialState={createWorkflowFormStateFromDefinition({
          workflow,
          sourceEntityContext,
          entityNameById,
        })}
        submitAction={updateWorkflowAction}
      />
    </main>
  );
}
