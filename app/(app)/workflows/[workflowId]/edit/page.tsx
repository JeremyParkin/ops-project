import { notFound } from "next/navigation";
import { updateWorkflow } from "@/app/actions";
import { WorkflowDefinitionForm } from "@/app/components/workflow-create-form";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import { getRelationLookups } from "@/lib/domain/record-repository";
import { listProcessTemplates } from "@/lib/domain/process-repository";
import {
  createWorkflowFormStateFromDefinition,
} from "@/lib/domain/workflow-validation";
import { getWorkflow } from "@/lib/domain/workflow-repository";

export const dynamic = "force-dynamic";

async function getWorkflowEntityContexts(workspaceId: string) {
  const entityTypes = await listEntityTypes({ workspaceId });
  const entityContexts = await Promise.all(
    entityTypes.map(async (entityType) => {
      const context = await getEntityContext({
        workspaceId,
        entityTypeId: entityType.id,
        includeArchivedFields: true,
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

  return {
    entityContexts,
  };
}

async function loadEditWorkflowPageData(workspaceId: string, workflowId: string) {
  try {
    const [{ entityContexts }, workflow, processTemplates] = await Promise.all([
      getWorkflowEntityContexts(workspaceId),
      getWorkflow({
        workspaceId,
        workflowId,
      }),
      listProcessTemplates({ workspaceId, includeArchived: true }),
    ]);

    return {
      entityContexts,
      workflow,
      processTemplates,
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
  const { workspaceId } = await getActiveWorkspaceId();
  const pageData = await loadEditWorkflowPageData(workspaceId, workflowId);

  if (!pageData) {
    notFound();
  }

  const { entityContexts, workflow, processTemplates } = pageData;
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
    <WorkspacePageLayout>
      <WorkflowDefinitionForm
        mode="edit"
        entityContexts={entityContexts}
        processTemplates={processTemplates}
        initialState={createWorkflowFormStateFromDefinition({
          workflow,
          sourceEntityContext,
          entityNameById,
        })}
        submitAction={updateWorkflowAction}
      />
    </WorkspacePageLayout>
  );
}
