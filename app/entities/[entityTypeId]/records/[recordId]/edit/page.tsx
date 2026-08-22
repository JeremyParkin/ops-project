import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { updateRecord } from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { RecordEditForm } from "@/app/components/record-edit-form";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import {
  getEntityRecord,
  getRelationLookups,
} from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

async function loadRecordEditPageData(entityTypeId: string, recordId: string) {
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
    const relationLookups = await getRelationLookups({
      workspaceId: DEMO_WORKSPACE_ID,
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
  const pageData = await loadRecordEditPageData(entityTypeId, recordId);

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
        <RecordEditForm
          entityType={entityType}
          fields={fields}
          record={record}
          relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
          entityNameById={entityNameById}
          updateRecordAction={updateEntityRecord}
          returnTo={returnTo === "detail" ? "detail" : undefined}
        />
      </div>
    </main>
  );
}
