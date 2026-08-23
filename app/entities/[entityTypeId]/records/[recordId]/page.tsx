import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveRecord,
  deleteRecordFromDetail,
  restoreRecord,
} from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { RecordDetailView } from "@/app/components/record-detail-view";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import {
  getEntityRecord,
  getRelationLookups,
  listIncomingRelationsForRecord,
} from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

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
    const [relationLookups, incomingRelationGroups] = await Promise.all([
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
    ]);

    return {
      context,
      entityTypes,
      entityContext,
      record,
      relationLookups,
      incomingRelationGroups,
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
