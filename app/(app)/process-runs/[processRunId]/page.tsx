import { notFound } from "next/navigation";
import {
  completeProcessStepRunAction,
  createProcessStepRunCommentAction,
  decideProcessApprovalAction,
  retryProcessActionStepAction,
  tombstoneProcessStepRunCommentAction,
} from "@/app/process-actions";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { ProcessRunDetailView } from "@/app/components/process-run-detail-view";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { getEntityContext } from "@/lib/domain/metadata-repository";
import { getProcessRunWithSteps } from "@/lib/domain/process-repository";
import {
  listProcessStepRunCommentMentionCandidates,
  listProcessStepRunComments,
} from "@/lib/domain/process-step-run-comment-repository";
import { getEntityRecord, getRecordLabel } from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

async function loadProcessRunPageData(workspaceId: string, processRunId: string) {
  try {
    const run = await getProcessRunWithSteps({ workspaceId, processRunId });
    const { entityType, fields } = await getEntityContext({
      workspaceId,
      entityTypeId: run.originEntityTypeId,
    });
    const record = await getEntityRecord({
      workspaceId,
      entityTypeId: run.originEntityTypeId,
      recordId: run.originRecordId,
      fields,
    });
    const discussionStepIds = run.steps
      .filter((step) => step.nodeType === "human_task" || step.nodeType === "approval")
      .map((step) => step.id);
    const [stepCommentEntries, mentionCandidates] = await Promise.all([
      Promise.all(
        discussionStepIds.map(async (stepRunId) => [
          stepRunId,
          await listProcessStepRunComments({
            workspaceId,
            processRunId: run.id,
            processStepRunId: stepRunId,
          }).catch(() => []),
        ] as const),
      ),
      listProcessStepRunCommentMentionCandidates({ workspaceId }).catch(() => []),
    ]);

    return {
      run,
      originLabel: getRecordLabel({ entityType, fields, record }),
      originHref: `/entities/${entityType.id}/records/${record.id}`,
      isOriginRecordArchived: Boolean(record.archivedAt),
      stepCommentsByStepRunId: Object.fromEntries(stepCommentEntries),
      mentionCandidates,
    };
  } catch {
    return null;
  }
}

export default async function ProcessRunPage({
  params,
}: {
  params: Promise<{ processRunId: string }>;
}) {
  const { processRunId } = await params;
  const { workspaceId, user } = await getActiveWorkspaceId();
  const [pageData, permissions, impersonation] = await Promise.all([
    loadProcessRunPageData(workspaceId, processRunId),
    getWorkspacePermissionContext(workspaceId),
    resolveImpersonationContext(workspaceId),
  ]);

  if (!pageData) {
    notFound();
  }

  const {
    run,
    originLabel,
    originHref,
    isOriginRecordArchived,
    stepCommentsByStepRunId,
    mentionCandidates,
  } = pageData;

  return (
    <WorkspacePageLayout>
      <ProcessRunDetailView
        run={run}
        originLabel={originLabel}
        originHref={originHref}
        currentUserId={user.id}
        canManageIntegrations={
          !impersonation.isImpersonating && (permissions?.capabilities.has("workspace.manage_integrations") ?? false)
        }
        publicAppUrl={process.env.KINEMA_PUBLIC_APP_URL ?? ""}
        stepCommentsByStepRunId={stepCommentsByStepRunId}
        mentionCandidates={mentionCandidates}
        isOriginRecordArchived={isOriginRecordArchived}
        createProcessStepRunCommentAction={createProcessStepRunCommentAction.bind(null, {
          workspaceId,
          processRunId,
        })}
        tombstoneProcessStepRunCommentAction={tombstoneProcessStepRunCommentAction.bind(null, {
          workspaceId,
          processRunId,
        })}
        completeProcessStepRunAction={completeProcessStepRunAction.bind(null, {
          workspaceId,
          processRunId,
        })}
        decideProcessApprovalAction={decideProcessApprovalAction.bind(null, {
          workspaceId,
          processRunId,
        })}
        retryProcessActionStepAction={retryProcessActionStepAction.bind(null, {
          workspaceId,
          processRunId,
        })}
      />
    </WorkspacePageLayout>
  );
}
