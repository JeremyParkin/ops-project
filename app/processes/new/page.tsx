import { saveProcessTemplateAction } from "@/app/process-actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { ProcessTemplateForm } from "@/app/components/process-template-form";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { getEntityContext, listEntityTypes } from "@/lib/domain/metadata-repository";
import { getRelationLookups } from "@/lib/domain/record-repository";
import { listWorkspaceMemberIdentities } from "@/lib/domain/process-repository";
import { initialProcessTemplateFormState } from "@/lib/domain/process-validation";

export const dynamic = "force-dynamic";

export default async function NewProcessTemplatePage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const [entityTypes, members] = await Promise.all([
    listEntityTypes({ workspaceId }),
    listWorkspaceMemberIdentities({ workspaceId }),
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
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <WorkspaceNavigation entityTypes={entityTypes} activeSection="processes" />
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        <ProcessTemplateForm
          entityContexts={entityContexts}
          members={members}
          saveProcessTemplateAction={createProcessTemplate}
          initialState={initialProcessTemplateFormState}
          isEditing={false}
        />
      </div>
    </main>
  );
}
