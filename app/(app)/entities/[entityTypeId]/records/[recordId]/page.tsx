import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveRecord,
  createRecordComment,
  createRecordInputRequest,
  deleteRecordFromDetail,
  cancelRecordInputRequest,
  respondRecordInputRequest,
  restoreRecord,
  tombstoneRecordComment,
  updateRecordField,
} from "@/app/actions";
import { ObjectContextNav } from "@/app/components/object-context-nav";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import type { ProcessSectionEntry } from "@/app/components/process-section";
import { RecordDetailView } from "@/app/components/record-detail-view";
import {
  createRecurrenceRuleAction,
  setRecurrenceRuleActiveAction,
  startProcessRunAction,
  updateRecurrenceRuleAction,
} from "@/app/process-actions";
import { getActiveWorkspaceId, getCurrentUser, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { listRecordActivity } from "@/lib/domain/activity-repository";
import { listChoiceOptionsByFieldIds } from "@/lib/domain/choice-option-repository";
import { toChoiceOptionsByFieldKey } from "@/lib/domain/choice-display";
import {
  listRecordCommentMentionCandidates,
  listRecordComments,
} from "@/lib/domain/record-comment-repository";
import {
  listRecordInputRequestRecipientCandidates,
  listRecordInputRequests,
} from "@/lib/domain/record-input-request-repository";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { getEntityContext } from "@/lib/domain/metadata-repository";
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
import { getWorkspaceTimezone, listRecurrenceRulesForOrigin } from "@/lib/domain/recurrence-repository";
import { listEntityViews } from "@/lib/domain/view-repository";

export const dynamic = "force-dynamic";

async function loadProcessSectionEntries({
  workspaceId,
  entityTypeId,
  recordId,
  canManageAutomation,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  canManageAutomation: boolean;
}): Promise<ProcessSectionEntry[]> {
  const [applicableTemplates, runsForRecord, recurrenceRules, workspaceTimezone] = await Promise.all([
    listApplicableProcessTemplatesForEntityType({ workspaceId, entityTypeId }),
    listProcessRunsForOrigin({
      workspaceId,
      originEntityTypeId: entityTypeId,
      originRecordId: recordId,
    }),
    // Recurrence is configuration -- only worth loading for a caller who can
    // actually see/use it. Ordinary workers never fetch or render it.
    canManageAutomation
      ? listRecurrenceRulesForOrigin({
          workspaceId,
          originEntityTypeId: entityTypeId,
          originRecordId: recordId,
        })
      : Promise.resolve([]),
    canManageAutomation ? getWorkspaceTimezone({ workspaceId }) : Promise.resolve(""),
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
  const recurrenceRuleByTemplateId = new Map(
    recurrenceRules.map((rule) => [rule.processTemplateId, rule]),
  );

  return Promise.all(
    applicableTemplates.map(async (template) => {
      const latestRun = latestRunByTemplateId.get(template.id);
      const startProcessRunActionForTemplate = startProcessRunAction.bind(null, {
        workspaceId,
        processTemplateId: template.id,
        originEntityTypeId: entityTypeId,
        originRecordId: recordId,
      });
      const rule = recurrenceRuleByTemplateId.get(template.id);
      const recurrence = canManageAutomation
        ? {
            rule,
            workspaceTimezone,
            createAction: createRecurrenceRuleAction.bind(null, {
              workspaceId,
              processTemplateId: template.id,
              originEntityTypeId: entityTypeId,
              originRecordId: recordId,
            }),
            updateAction: updateRecurrenceRuleAction.bind(null, {
              workspaceId,
              recurrenceRuleId: rule?.id ?? "",
              originEntityTypeId: entityTypeId,
              originRecordId: recordId,
            }),
            setActiveAction: setRecurrenceRuleActiveAction.bind(null, {
              workspaceId,
              recurrenceRuleId: rule?.id ?? "",
              originEntityTypeId: entityTypeId,
              originRecordId: recordId,
            }),
          }
        : undefined;

      if (!latestRun) {
        return {
          template,
          startProcessRunAction: startProcessRunActionForTemplate,
          recurrence,
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
        recurrence,
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
    const [views, entityContext, permissions] = await Promise.all([
      listEntityViews({ workspaceId, entityTypeId }),
      getEntityContext(context),
      getWorkspacePermissionContext(workspaceId),
    ]);
    const canManageAutomation = permissions?.capabilities.has("automation.manage") ?? false;
    const record = await getEntityRecord({
      ...context,
      recordId,
      fields: entityContext.fields,
    });
    const [
      relationLookups,
      choiceOptionsByFieldId,
      incomingRelationGroups,
      processSectionEntries,
      activityEvents,
      comments,
      mentionCandidates,
      inputRequests,
      inputRequestRecipientCandidates,
    ] = await Promise.all([
      getRelationLookups({
        workspaceId,
        fields: entityContext.fields,
        currentRecord: record,
        restrictToCurrentRecordValues: true,
      }),
      listChoiceOptionsByFieldIds({
        workspaceId,
        fieldDefinitionIds: entityContext.fields
          .filter((field) => field.type === "choice")
          .map((field) => field.id),
      }),
      listIncomingRelationsForRecord({
        workspaceId,
        targetEntityTypeId: entityTypeId,
        targetRecordId: recordId,
      }),
      loadProcessSectionEntries({ workspaceId, entityTypeId, recordId, canManageAutomation }),
      // Historical record context, not a configuration/operate surface --
      // unlike processSectionEntries, this is not gated or zeroed for an
      // archived record: viewing durable past events implies no write
      // capability and invites no new action. Caught independently: this
      // whole function's outer try/catch turns ANY failure into a 404, and
      // Activity is additive context, not core record data -- a failure
      // here (including the entirely expected one while migration 0065 is
      // written but not yet applied) must never take down the record page
      // itself, only leave its own section looking empty.
      listRecordActivity({ workspaceId, entityTypeId, recordId }).catch(() => []),
      listRecordComments({ workspaceId, entityTypeId, recordId }).catch(() => []),
      listRecordCommentMentionCandidates({ workspaceId }).catch(() => []),
      listRecordInputRequests({ workspaceId, entityTypeId, recordId }).catch(() => []),
      listRecordInputRequestRecipientCandidates({ workspaceId }).catch(() => []),
    ]);
    const impersonation = await resolveImpersonationContext(workspaceId);
    const currentUserId = impersonation.isImpersonating
      ? impersonation.effectiveUserId
      : (await getCurrentUser())?.id;
    const canCancelAnyInputRequest =
      !impersonation.isImpersonating &&
      Boolean(
        permissions?.capabilities.has("workspace.manage_members") &&
          permissions.capabilities.has("workspace.manage_roles"),
      );

    return {
      context,
      views,
      entityContext,
      record,
      relationLookups,
      choiceOptionsByFieldId,
      incomingRelationGroups,
      processSectionEntries,
      activityEvents,
      comments,
      mentionCandidates,
      inputRequests,
      inputRequestRecipientCandidates,
      currentUserId,
      canCancelAnyInputRequest,
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
    views,
    entityContext: { entityType, fields },
    record,
    relationLookups,
    choiceOptionsByFieldId,
    incomingRelationGroups,
    processSectionEntries,
    activityEvents,
    comments,
    mentionCandidates,
    inputRequests,
    inputRequestRecipientCandidates,
    currentUserId,
    canCancelAnyInputRequest,
  } = pageData;
  const choiceOptionsByFieldKey = toChoiceOptionsByFieldKey(fields, choiceOptionsByFieldId);
  const actionContext = {
    ...context,
    recordId: record.id,
  };
  const editHref =
    entityType.archivedAt
      ? undefined
      : `/entities/${entityType.id}/records/${record.id}/edit?returnTo=detail`;
  const updateFieldAction =
    entityType.archivedAt || record.archivedAt
      ? undefined
      : updateRecordField.bind(null, actionContext);

  return (
    <WorkspacePageLayout
      contextNav={
        <ObjectContextNav entityType={entityType} views={views} highlightAll={false} />
      }
    >
        <Link
          href={`/entities/${entityType.id}`}
          className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
        >
          ← {entityType.name}
        </Link>
        <RecordDetailView
          entityType={entityType}
          fields={fields}
          record={record}
          relationLabelsByFieldKey={relationLookups.labelsByFieldKey}
          choiceOptionsByFieldKey={choiceOptionsByFieldKey}
          incomingRelationGroups={incomingRelationGroups}
          processSectionEntries={record.archivedAt ? [] : processSectionEntries}
          activityEvents={activityEvents}
          comments={comments}
          mentionCandidates={mentionCandidates}
          inputRequests={inputRequests}
          inputRequestRecipientCandidates={inputRequestRecipientCandidates}
          currentUserId={currentUserId}
          canCancelAnyInputRequest={canCancelAnyInputRequest}
          editHref={editHref}
          updateFieldAction={updateFieldAction}
          createCommentAction={createRecordComment.bind(null, actionContext)}
          tombstoneCommentAction={tombstoneRecordComment.bind(null, actionContext)}
          createInputRequestAction={createRecordInputRequest.bind(null, actionContext)}
          respondInputRequestAction={respondRecordInputRequest.bind(null, actionContext)}
          cancelInputRequestAction={cancelRecordInputRequest.bind(null, actionContext)}
          archiveRecordAction={archiveRecord.bind(null, actionContext)}
          restoreRecordAction={restoreRecord.bind(null, actionContext)}
          deleteRecordAction={deleteRecordFromDetail.bind(null, actionContext)}
        />
    </WorkspacePageLayout>
  );
}
