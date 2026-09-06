import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveRecord,
  createRecordComment,
  createRecordInputRequest,
  deleteRecordFromDetail,
  cancelRecordInputRequest,
  finalizeQualityReviewRecord,
  linkPersonAction,
  reopenQualityReviewRecord,
  respondRecordInputRequest,
  restoreRecord,
  tombstoneRecordComment,
  unlinkPersonAction,
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
import { getQualityReviewRecordContext, listPersonQualityReviews } from "@/lib/domain/quality-review-repository";
import {
  getPersonEntityTypeId,
  getPersonLink,
  listUnlinkedWorkspaceMemberIdentities,
} from "@/lib/domain/person-link-repository";
import {
  getProcessRunWithSteps,
  listApplicableProcessTemplatesForEntityType,
  listProcessRunsForOrigin,
  listWorkspaceMemberIdentities,
} from "@/lib/domain/process-repository";
import {
  getEntityRecord,
  getRelationLookups,
  listIncomingRelationsForRecord,
  withoutQualityReviewSubjectGroups,
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
    const [views, entityContext, permissions, personEntityTypeId] = await Promise.all([
      listEntityViews({ workspaceId, entityTypeId }),
      getEntityContext(context),
      getWorkspacePermissionContext(workspaceId),
      getPersonEntityTypeId({ workspaceId }),
    ]);
    const isPersonRecord = personEntityTypeId === entityTypeId;
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

    // Governance authority for Reopen: real actor, never the effective/
    // impersonated identity, exactly like every other governance-only
    // control in this app (canCancelAnyInputRequest, person-link
    // management) -- an impersonated identity's own capabilities never
    // qualify.
    const hasQualityReviewGovernanceAuthority =
      !impersonation.isImpersonating && (permissions?.capabilities.has("people_data.view_all") ?? false);
    const qualityReviewContext = await getQualityReviewRecordContext({
      workspaceId,
      entityTypeId,
      recordId,
      effectiveUserId: currentUserId,
    });

    // Identity is visible to any workspace viewer of a Person-type record;
    // only workspace.manage_members holders (and never while impersonating,
    // matching every other administrative control in this app) ever see
    // Link/Unlink themselves.
    const canManagePersonLinks =
      !impersonation.isImpersonating && (permissions?.capabilities.has("workspace.manage_members") ?? false);
    let personLinkedEmail: string | undefined;
    let personLinkCandidates: Awaited<ReturnType<typeof listWorkspaceMemberIdentities>> = [];
    let personReviewHistory: Awaited<ReturnType<typeof listPersonQualityReviews>> | undefined;
    // Presentation-only dedup (12.3.2): the Quality Review subject relation
    // group is redundant with Review History on a Person's own page --
    // suppressed here, never in listIncomingRelationsForRecord itself, so
    // every other record type's generic Related is completely unaffected.
    let visibleIncomingRelationGroups = incomingRelationGroups;
    if (isPersonRecord) {
      visibleIncomingRelationGroups = withoutQualityReviewSubjectGroups(incomingRelationGroups);
      const [personLink, reviewHistory] = await Promise.all([
        getPersonLink({ workspaceId, entityRecordId: recordId }),
        listPersonQualityReviews({ workspaceId, personRecordId: recordId }),
      ]);
      personReviewHistory = reviewHistory;
      if (personLink) {
        const identities = await listWorkspaceMemberIdentities({ workspaceId });
        personLinkedEmail = identities.find((identity) => identity.userId === personLink.userId)?.email;
      } else if (canManagePersonLinks) {
        personLinkCandidates = await listUnlinkedWorkspaceMemberIdentities({ workspaceId });
      }
    }

    return {
      context,
      views,
      entityContext,
      record,
      relationLookups,
      choiceOptionsByFieldId,
      incomingRelationGroups: visibleIncomingRelationGroups,
      processSectionEntries,
      activityEvents,
      comments,
      mentionCandidates,
      inputRequests,
      inputRequestRecipientCandidates,
      currentUserId,
      qualityReviewContext,
      hasQualityReviewGovernanceAuthority,
      isPersonRecord,
      personReviewHistory,
      personLinkedEmail,
      canManagePersonLinks,
      personLinkCandidates,
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
    qualityReviewContext,
    hasQualityReviewGovernanceAuthority,
    canCancelAnyInputRequest,
    isPersonRecord,
    personReviewHistory,
    personLinkedEmail,
    canManagePersonLinks,
    personLinkCandidates,
  } = pageData;
  const choiceOptionsByFieldKey = toChoiceOptionsByFieldKey(fields, choiceOptionsByFieldId);
  const actionContext = {
    ...context,
    recordId: record.id,
  };
  // A Finalized Quality Review is read-only for everyone through the
  // generic edit surface -- no editHref, no inline Save -- regardless of
  // who is viewing; correction is always Reopen, then an ordinary Draft
  // edit, never a generic Save that quietly works on finalized content. A
  // Draft is only ordinarily editable by its designated Reviewer -- a
  // privileged non-Reviewer viewer (who can see it via the read override)
  // must not be shown an Edit affordance that would just be rejected;
  // their path is the existing governed Reviewer-reassignment flow, not
  // this generic edit surface.
  const isFinalizedQualityReview = qualityReviewContext.isQualityReviewType && qualityReviewContext.isFinalized;
  const isDraftQualityReviewNotReviewer =
    qualityReviewContext.isQualityReviewType && qualityReviewContext.isDraft && !qualityReviewContext.isReviewer;
  const editHref =
    entityType.archivedAt || isFinalizedQualityReview || isDraftQualityReviewNotReviewer
      ? undefined
      : `/entities/${entityType.id}/records/${record.id}/edit?returnTo=detail`;
  const updateFieldAction =
    entityType.archivedAt || record.archivedAt || isFinalizedQualityReview || isDraftQualityReviewNotReviewer
      ? undefined
      : updateRecordField.bind(null, actionContext);
  const canFinalizeQualityReview =
    qualityReviewContext.isQualityReviewType && qualityReviewContext.isDraft && qualityReviewContext.isReviewer;
  const canReopenQualityReview =
    qualityReviewContext.isQualityReviewType && qualityReviewContext.isFinalized && hasQualityReviewGovernanceAuthority;

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
          isPersonRecord={isPersonRecord}
          personReviewHistory={personReviewHistory}
          personLinkedEmail={personLinkedEmail}
          canManagePersonLinks={canManagePersonLinks}
          personLinkCandidates={personLinkCandidates}
          linkPersonAction={linkPersonAction.bind(null, actionContext)}
          unlinkPersonAction={unlinkPersonAction.bind(null, actionContext)}
          editHref={editHref}
          updateFieldAction={updateFieldAction}
          qualityReviewStatus={
            qualityReviewContext.isQualityReviewType
              ? {
                  isFinalized: qualityReviewContext.isFinalized,
                  finalizeAction: canFinalizeQualityReview
                    ? finalizeQualityReviewRecord.bind(null, actionContext)
                    : undefined,
                  reopenAction: canReopenQualityReview
                    ? reopenQualityReviewRecord.bind(null, actionContext)
                    : undefined,
                }
              : undefined
          }
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
