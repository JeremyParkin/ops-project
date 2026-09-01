import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { updateRecord } from "@/app/actions";
import { ObjectContextNav } from "@/app/components/object-context-nav";
import { WorkspacePageLayout } from "@/app/components/page-primitives";
import { RecordEditForm } from "@/app/components/record-edit-form";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listChoiceOptionsByFieldIds } from "@/lib/domain/choice-option-repository";
import { toChoiceOptionsByFieldKey } from "@/lib/domain/choice-display";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import {
  getEntityRecord,
  getRelationLookups,
} from "@/lib/domain/record-repository";
import { listEntityViews } from "@/lib/domain/view-repository";

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
    const [entityTypes, views, entityContext] = await Promise.all([
      listEntityTypes({ workspaceId }),
      listEntityViews({ workspaceId, entityTypeId }),
      getEntityContext(context),
    ]);
    const record = await getEntityRecord({
      ...context,
      recordId,
      fields: entityContext.fields,
    });
    const [relationLookups, choiceOptionsByFieldId] = await Promise.all([
      getRelationLookups({
        workspaceId,
        fields: entityContext.fields,
        currentRecord: record,
      }),
      listChoiceOptionsByFieldIds({
        workspaceId,
        fieldDefinitionIds: entityContext.fields
          .filter((field) => field.type === "choice")
          .map((field) => field.id),
      }),
    ]);

    return {
      context,
      entityTypes,
      views,
      entityContext,
      record,
      relationLookups,
      choiceOptionsByFieldId,
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
    views,
    entityContext: { entityType, fields },
    record,
    relationLookups,
    choiceOptionsByFieldId,
  } = pageData;
  const choiceOptionsByFieldKey = toChoiceOptionsByFieldKey(fields, choiceOptionsByFieldId);

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
        <RecordEditForm
          entityType={entityType}
          fields={fields}
          record={record}
          relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
          choiceOptionsByFieldKey={choiceOptionsByFieldKey}
          entityNameById={entityNameById}
          updateRecordAction={updateEntityRecord}
          returnTo={returnTo === "detail" ? "detail" : undefined}
        />
    </WorkspacePageLayout>
  );
}
