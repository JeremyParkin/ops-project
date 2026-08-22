import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveRecord,
  deleteRecordFromDetail,
  restoreRecord,
} from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { RecordDetailView } from "@/app/components/record-detail-view";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
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

async function loadRecordDetailPageData(entityTypeId: string, recordId: string) {
  const context = {
    workspaceId: DEMO_WORKSPACE_ID,
    entityTypeId,
  };

  try {
    const [entityTypes, entityContext] = await Promise.all([
      listEntityTypes({ workspaceId: DEMO_WORKSPACE_ID }),
      getEntityContext(context),
    ]);
    const record = await getEntityRecord({
      ...context,
      recordId,
      fields: entityContext.fields,
    });
    const [relationLookups, incomingRelationGroups] = await Promise.all([
      getRelationLookups({
        workspaceId: DEMO_WORKSPACE_ID,
        fields: entityContext.fields,
        currentRecord: record,
      }),
      listIncomingRelationsForRecord({
        workspaceId: DEMO_WORKSPACE_ID,
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
  const pageData = await loadRecordDetailPageData(entityTypeId, recordId);

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
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <WorkspaceNavigation
        entityTypes={entityTypes}
        activeEntityTypeId={entityType.id}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-6">
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
      </div>
    </main>
  );
}
