import { saveProcessTemplateAction } from "@/app/process-actions";
import { ProcessTemplateForm } from "@/app/components/process-template-form";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { getEntityContext, listEntityTypes } from "@/lib/domain/metadata-repository";
import { getRelationLookups } from "@/lib/domain/record-repository";
import { listProcessTemplates, listWorkspaceMemberIdentities } from "@/lib/domain/process-repository";
import { initialProcessTemplateFormState } from "@/lib/domain/process-validation";

export const dynamic = "force-dynamic";

export default async function NewProcessTemplatePage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const [entityTypes, members, processTemplates] = await Promise.all([
    listEntityTypes({ workspaceId }),
    listWorkspaceMemberIdentities({ workspaceId }),
    listProcessTemplates({ workspaceId }),
  ]);
  const entityContexts = await Promise.all(
    entityTypes.map(async (entityType) => {
      const context = await getEntityContext({ workspaceId, entityTypeId: entityType.id });
      const relationLookups = await getRelationLookups({
        workspaceId,
        fields: context.fields,
      });

      return {
        entityType,
        fields: context.fields,
        relationOptionsByFieldId: Object.fromEntries(
          context.fields
            .filter((field) => field.type === "relation")
            .map((field) => [field.id, relationLookups.optionsByFieldKey[field.key] ?? []]),
        ),
      };
    }),
  );
  const createProcessTemplate = saveProcessTemplateAction.bind(null, { workspaceId });

  return (
    <WorkspacePageLayout>
      <ProcessTemplateForm
        entityContexts={entityContexts}
        members={members}
        processTemplates={processTemplates.map((template) => ({ id: template.id, name: template.name }))}
        saveProcessTemplateAction={createProcessTemplate}
        initialState={initialProcessTemplateFormState}
        isEditing={false}
      />
    </WorkspacePageLayout>
  );
}
