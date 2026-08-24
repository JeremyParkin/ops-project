import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveRecord,
  deleteRecordFromDetail,
  restoreRecord,
} from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import type { ProcessSectionEntry } from "@/app/components/process-section";
import { RecordDetailView } from "@/app/components/record-detail-view";
import { startProcessRunAction } from "@/app/process-actions";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import {
  getProcessRunWithSteps,
  listApplicableProcessTemplatesForEntityType,
  listProcessRunsForOrigin,
} from "@/lib/domain/process-repository";
import {
  getEntityRecord,
  getRelationLookups,
  listIncomingRelationsForRecord,
} from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

async function loadProcessSectionEntries({
  workspaceId,
  entityTypeId,
  recordId,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
}): Promise<ProcessSectionEntry[]> {
  const [applicableTemplates, runsForRecord] = await Promise.all([
    listApplicableProcessTemplatesForEntityType({ workspaceId, entityTypeId }),
    listProcessRunsForOrigin({
      workspaceId,
      originEntityTypeId: entityTypeId,
      originRecordId: recordId,
    }),
  ]);

  if (applicableTemplates.length === 0) {
    return [];
  }

  // runsForRecord is ordered newest-first, so the first match per template is
  // that template's latest run.
  const latestRunByTemplateId = new Map<string, (typeof runsForRecord)[number]>();

  runsForRecord.forEach((run) => {
    if (!latestRunByTemplateId.has(run.processTemplateId)) {
      latestRunByTemplateId.set(run.processTemplateId, run);
    }
  });

  return Promise.all(
    applicableTemplates.map(async (template) => {
      const latestRun = latestRunByTemplateId.get(template.id);
      const startProcessRunActionForTemplate = startProcessRunAction.bind(null, {
        workspaceId,
        processTemplateId: template.id,
        originEntityTypeId: entityTypeId,
        originRecordId: recordId,
      });

      if (!latestRun) {
        return {
          template,
          startProcessRunAction: startProcessRunActionForTemplate,
        };
      }

      const runWithSteps = await getProcessRunWithSteps({
        workspaceId,
        processRunId: latestRun.id,
      });
      const completed = runWithSteps.steps.filter(
        (step) => step.status === "completed",
      ).length;
      const activeSteps = runWithSteps.steps.filter(
        (step) => step.status === "active" && step.nodeType === "human_task",
      );
      const currentStep = activeSteps.length === 1 ? activeSteps[0] : undefined;

      return {
        template,
        latestRun,
        stepSummary: {
          completed,
          total: runWithSteps.steps.length,
          activeStepCount: activeSteps.length,
          currentStepName: currentStep?.name,
          currentStepAssigneeLabel: currentStep?.assigneeLabel,
          currentStepDueAt: currentStep?.dueAt,
        },
        startProcessRunAction: startProcessRunActionForTemplate,
      };
    }),
  );
}

async function loadRecordDetailPageData(
  workspaceId: string,
  entityTypeId: string,
  recordId: string,
) {
  const context = {
    workspaceId,
    entityTypeId,
  };

  try {
    const [entityTypes, entityContext] = await Promise.all([
      listEntityTypes({ workspaceId }),
      getEntityContext(context),
    ]);
    const record = await getEntityRecord({
      ...context,
      recordId,
      fields: entityContext.fields,
    });
    const [relationLookups, incomingRelationGroups, processSectionEntries] = await Promise.all([
      getRelationLookups({
        workspaceId,
        fields: entityContext.fields,
        currentRecord: record,
      }),
      listIncomingRelationsForRecord({
        workspaceId,
        targetEntityTypeId: entityTypeId,
        targetRecordId: recordId,
      }),
      loadProcessSectionEntries({ workspaceId, entityTypeId, recordId }),
    ]);

    return {
      context,
      entityTypes,
      entityContext,
      record,
      relationLookups,
      incomingRelationGroups,
      processSectionEntries,
    };
  } catch {
    return null;
  }
}

export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{
    entityTypeId: string;
    recordId: string;
  }>;
}) {
  const { entityTypeId, recordId } = await params;
  const { workspaceId } = await getActiveWorkspaceId();
  const pageData = await loadRecordDetailPageData(workspaceId, entityTypeId, recordId);

  if (!pageData) {
    notFound();
  }

  const {
    context,
    entityTypes,
    entityContext: { entityType, fields },
    record,
    relationLookups,
    incomingRelationGroups,
    processSectionEntries,
  } = pageData;
  const actionContext = {
    ...context,
    recordId: record.id,
  };

  return (
    <WorkspacePageLayout
      navigation={<WorkspaceNavigation
        entityTypes={entityTypes}
        activeEntityTypeId={entityType.id}
      />}
    >
        <Link
          href={`/entities/${entityType.id}`}
          className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
        >
          Back to {entityType.name}
        </Link>
        <RecordDetailView
          entityType={entityType}
          fields={fields}
          record={record}
          relationLabelsByFieldKey={relationLookups.labelsByFieldKey}
          incomingRelationGroups={incomingRelationGroups}
          processSectionEntries={record.archivedAt ? [] : processSectionEntries}
          editHref={
            entityType.archivedAt
              ? undefined
              : `/entities/${entityType.id}/records/${record.id}/edit?returnTo=detail`
          }
          archiveRecordAction={archiveRecord.bind(null, actionContext)}
          restoreRecordAction={restoreRecord.bind(null, actionContext)}
          deleteRecordAction={deleteRecordFromDetail.bind(null, actionContext)}
        />
    </WorkspacePageLayout>
  );
}
