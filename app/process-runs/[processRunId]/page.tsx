import { notFound } from "next/navigation";
import { completeProcessStepRunAction } from "@/app/process-actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { ProcessRunDetailView } from "@/app/components/process-run-detail-view";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { getEntityContext, listEntityTypes } from "@/lib/domain/metadata-repository";
import { getProcessRunWithSteps } from "@/lib/domain/process-repository";
import { getEntityRecord, getRecordLabel } from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

async function loadProcessRunPageData(workspaceId: string, processRunId: string) {
  try {
    const [entityTypes, run] = await Promise.all([
      listEntityTypes({ workspaceId }),
      getProcessRunWithSteps({ workspaceId, processRunId }),
    ]);
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

    return {
      entityTypes,
      run,
      originLabel: getRecordLabel({ entityType, fields, record }),
      originHref: `/entities/${entityType.id}/records/${record.id}`,
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
  const pageData = await loadProcessRunPageData(workspaceId, processRunId);

  if (!pageData) {
    notFound();
  }

  const { entityTypes, run, originLabel, originHref } = pageData;

  return (
    <WorkspacePageLayout
      navigation={<WorkspaceNavigation entityTypes={entityTypes} activeSection="processes" />}
    >
      <ProcessRunDetailView
        run={run}
        originLabel={originLabel}
        originHref={originHref}
        currentUserId={user.id}
        completeProcessStepRunAction={completeProcessStepRunAction.bind(null, {
          workspaceId,
          processRunId,
        })}
      />
    </WorkspacePageLayout>
  );
}
