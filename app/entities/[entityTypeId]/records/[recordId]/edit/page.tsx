import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { updateRecord } from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { RecordEditForm } from "@/app/components/record-edit-form";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import {
  getEntityRecord,
  getRelationLookups,
} from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

async function loadRecordEditPageData(
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
    const relationLookups = await getRelationLookups({
      workspaceId,
      fields: entityContext.fields,
      currentRecord: record,
    });

    return {
      context,
      entityTypes,
      entityContext,
      record,
      relationLookups,
    };
  } catch {
    return null;
  }
}

export default async function RecordEditPage({
  params,
  searchParams,
}: {
  params: Promise<{
    entityTypeId: string;
    recordId: string;
  }>;
  searchParams: Promise<{
    returnTo?: string;
  }>;
}) {
  const { entityTypeId, recordId } = await params;
  const { returnTo } = await searchParams;
  const { workspaceId } = await getActiveWorkspaceId();
  const pageData = await loadRecordEditPageData(workspaceId, entityTypeId, recordId);

  if (!pageData) {
    notFound();
  }

  const {
    context,
    entityTypes,
    entityContext: { entityType, fields },
    record,
    relationLookups,
  } = pageData;

  if (entityType.archivedAt) {
    redirect(`/entities/${entityType.id}`);
  }

  const entityNameById = Object.fromEntries(
    entityTypes.map((listedEntityType) => [
      listedEntityType.id,
      listedEntityType.name,
    ]),
  );
  const updateEntityRecord = updateRecord.bind(null, {
    ...context,
    recordId: record.id,
  });

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
        <RecordEditForm
          entityType={entityType}
          fields={fields}
          record={record}
          relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
          entityNameById={entityNameById}
          updateRecordAction={updateEntityRecord}
          returnTo={returnTo === "detail" ? "detail" : undefined}
        />
    </WorkspacePageLayout>
  );
}
