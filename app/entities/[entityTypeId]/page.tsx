import { notFound } from "next/navigation";
import Link from "next/link";
import {
  addFieldDefinition,
  archiveEntity,
  createRecord,
  deleteEntity,
  restoreEntity,
  updateEntityMetadata,
} from "@/app/actions";
import { EntityNavigation } from "@/app/components/entity-navigation";
import { EntityRecordsTable } from "@/app/components/entity-records-table";
import { EntitySettingsForm } from "@/app/components/entity-settings-form";
import { FieldCreateForm } from "@/app/components/field-create-form";
import { FieldManagementList } from "@/app/components/field-management-list";
import { RecordCreateForm } from "@/app/components/record-create-form";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
import {
  getEntityContext,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import {
  getRelationLookups,
  listEntityRecords,
} from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

async function loadEntityPageData({
  entityTypeId,
  showArchivedRecords,
  showArchivedEntities,
}: {
  entityTypeId: string;
  showArchivedRecords: boolean;
  showArchivedEntities: boolean;
}) {
  const context = {
    workspaceId: DEMO_WORKSPACE_ID,
    entityTypeId,
  };

  try {
    const [navigationEntityTypes, activeEntityTypes, allEntityTypes, entityContext] =
      await Promise.all([
      listEntityTypes({
        workspaceId: DEMO_WORKSPACE_ID,
        includeArchived: showArchivedEntities,
      }),
      listEntityTypes({ workspaceId: DEMO_WORKSPACE_ID }),
      listEntityTypes({
        workspaceId: DEMO_WORKSPACE_ID,
        includeArchived: true,
      }),
      getEntityContext(context),
    ]);
    const [records, relationLookups] = await Promise.all([
      listEntityRecords({
        ...context,
        fields: entityContext.fields,
        includeArchived: showArchivedRecords,
      }),
      getRelationLookups({
        workspaceId: DEMO_WORKSPACE_ID,
        fields: entityContext.fields,
      }),
    ]);

    return {
      context,
      navigationEntityTypes,
      activeEntityTypes,
      allEntityTypes,
      entityContext,
      records,
      relationLookups,
    };
  } catch {
    return null;
  }
}

export default async function EntityPage({
  params,
  searchParams,
}: {
  params: Promise<{
    entityTypeId: string;
  }>;
  searchParams: Promise<{
    showArchived?: string;
    showArchivedEntities?: string;
  }>;
}) {
  const { entityTypeId } = await params;
  const {
    showArchived: showArchivedParam,
    showArchivedEntities: showArchivedEntitiesParam,
  } = await searchParams;
  const showArchivedRecords = showArchivedParam === "true";
  const showArchivedEntities = showArchivedEntitiesParam === "true";
  const pageData = await loadEntityPageData({
    entityTypeId,
    showArchivedRecords,
    showArchivedEntities,
  });

  if (!pageData) {
    notFound();
  }

  const {
    context,
    navigationEntityTypes,
    activeEntityTypes,
    allEntityTypes,
    entityContext: { entityType, fields },
    records,
    relationLookups,
  } = pageData;
  const isArchivedEntity = Boolean(entityType.archivedAt);
  const entityNameById = Object.fromEntries(
    allEntityTypes.map((listedEntityType) => [
      listedEntityType.id,
      listedEntityType.name,
    ]),
  );
  const createEntityRecord = createRecord.bind(null, context);
  const addEntityField = addFieldDefinition.bind(null, context);
  const updateEntity = updateEntityMetadata.bind(null, context);
  const archiveCurrentEntity = archiveEntity.bind(null, context);
  const restoreCurrentEntity = restoreEntity.bind(null, context);
  const deleteCurrentEntity = deleteEntity.bind(null, context);
  const archivedEntityQuery = showArchivedEntities
    ? "showArchivedEntities=true"
    : "";
  const showArchivedRecordsHref = `/entities/${entityType.id}?${[
    "showArchived=true",
    archivedEntityQuery,
  ]
    .filter(Boolean)
    .join("&")}`;
  const hideArchivedRecordsHref = showArchivedEntities
    ? `/entities/${entityType.id}?showArchivedEntities=true`
    : `/entities/${entityType.id}`;

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <EntityNavigation
        entityTypes={navigationEntityTypes}
        activeEntityTypeId={entityType.id}
        showArchivedEntities={showArchivedEntities}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        <EntitySettingsForm
          entityType={entityType}
          updateEntityMetadataAction={updateEntity}
          archiveEntityAction={archiveCurrentEntity}
          restoreEntityAction={restoreCurrentEntity}
          deleteEntityAction={deleteCurrentEntity}
        />
        {!isArchivedEntity ? (
          <>
            <FieldCreateForm
              entityTypes={activeEntityTypes}
              addFieldDefinitionAction={addEntityField}
            />
            <FieldManagementList
              workspaceId={context.workspaceId}
              entityTypeId={entityType.id}
              fields={fields}
              entityNameById={entityNameById}
            />
            <RecordCreateForm
              entityType={entityType}
              fields={fields}
              relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
              entityNameById={entityNameById}
              createRecordAction={createEntityRecord}
            />
          </>
        ) : null}
        <EntityRecordsTable
          entityType={entityType}
          fields={fields}
          records={records}
          relationLabelsByFieldKey={relationLookups.labelsByFieldKey}
          recordEditPathBase={
            isArchivedEntity ? undefined : `/entities/${entityType.id}/records`
          }
          recordActionContext={isArchivedEntity ? undefined : context}
        />
        <div className="mx-auto w-full max-w-6xl">
          <Link
            href={
              showArchivedRecords
                ? hideArchivedRecordsHref
                : showArchivedRecordsHref
            }
            className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
          >
            {showArchivedRecords ? "Hide archived records" : "Show archived records"}
          </Link>
        </div>
      </div>
    </main>
  );
}
