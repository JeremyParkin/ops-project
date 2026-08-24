import { notFound } from "next/navigation";
import { saveProcessTemplateAction } from "@/app/process-actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { ProcessTemplateForm } from "@/app/components/process-template-form";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { getEntityContext, listEntityTypes } from "@/lib/domain/metadata-repository";
import { getRelationLookups } from "@/lib/domain/record-repository";
import {
  getProcessTemplateWithSteps,
  listWorkspaceMemberIdentities,
} from "@/lib/domain/process-repository";
import type { ProcessTemplateFormState } from "@/lib/domain/process-validation";

export const dynamic = "force-dynamic";

async function loadEditPageData(workspaceId: string, processTemplateId: string) {
  try {
    const [entityTypes, template, members] = await Promise.all([
      listEntityTypes({ workspaceId, includeArchived: true }),
      getProcessTemplateWithSteps({ workspaceId, processTemplateId }),
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

    return { entityTypes, entityContexts, template, members };
  } catch {
    return null;
  }
}

export default async function EditProcessTemplatePage({
  params,
}: {
  params: Promise<{ processTemplateId: string }>;
}) {
  const { processTemplateId } = await params;
  const { workspaceId } = await getActiveWorkspaceId();
  const pageData = await loadEditPageData(workspaceId, processTemplateId);

  if (!pageData) {
    notFound();
  }

  const { entityTypes, entityContexts, template, members } = pageData;
  const updateProcessTemplate = saveProcessTemplateAction.bind(null, {
    workspaceId,
    processTemplateId,
  });
  const initialState: ProcessTemplateFormState = {
    success: false,
    message: "",
    errors: {},
    values: {
      name: template.name,
      description: template.description ?? "",
      appliesToEntityTypeId: template.appliesToEntityTypeId,
      steps: template.steps.map((step) => ({
        clientKey: step.id,
        nodeId: step.id,
        nodeType: step.nodeType,
        parallelGroupId: step.parallelGroupId ?? "",
        name: step.name,
        assigneeUserId: step.assigneeUserId ?? "",
        dueAmount: step.config.dueRule ? String(step.config.dueRule.amount) : "",
        dueUnit: step.config.dueRule?.unit ?? "days",
        routes: template.edges
          .filter((edge) => edge.sourceNodeId === step.id)
          .map((edge) => ({
            id: edge.id,
            targetStepKey: edge.targetNodeId,
            isDefault: edge.isDefault,
            isParallel: edge.isParallel,
            approvalOutcomeId: edge.approvalOutcomeId ?? "",
            approvalOutcomeLabel: edge.approvalOutcomeLabel ?? "",
            conditions: edge.conditionConfig ?? [],
          })),
      })),
    },
  };

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <WorkspaceNavigation entityTypes={entityTypes} activeSection="processes" />
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        {template.archivedAt ? (
          <section className="mx-auto w-full max-w-3xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            This process template is archived and read-only. Restore it from the{" "}
            <a href="/processes" className="underline underline-offset-4">
              Processes list
            </a>{" "}
            before editing.
          </section>
        ) : null}
        <ProcessTemplateForm
          entityContexts={entityContexts}
          members={members}
          saveProcessTemplateAction={updateProcessTemplate}
          initialState={initialState}
          isEditing
        />
      </div>
    </main>
  );
}
