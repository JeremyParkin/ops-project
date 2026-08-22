import { notFound } from "next/navigation";
import Link from "next/link";
import {
  addFieldDefinition,
  archiveEntity,
  createRecord,
  deleteEntity,
  createView,
  restoreEntity,
  deleteView,
  updateEntityMetadata,
  updateView,
} from "@/app/actions";
import { EntityNavigation } from "@/app/components/entity-navigation";
import { EntityRecordsTable } from "@/app/components/entity-records-table";
import { EntitySettingsForm } from "@/app/components/entity-settings-form";
import { EntityViewsPanel } from "@/app/components/entity-views-panel";
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
  getEntityRecord,
  listEntityRecords,
} from "@/lib/domain/record-repository";
import { evaluateEntityView } from "@/lib/domain/view-engine";
import {
  countViewReferencesByFieldId,
  listEntityViews,
} from "@/lib/domain/view-repository";
import {
  countWorkflowReferencesByFieldId,
  listWorkflows,
} from "@/lib/domain/workflow-repository";

export const dynamic = "force-dynamic";

type RelatedCreateParams = {
  prefillRelationFieldId?: string;
  originEntityTypeId?: string;
  originRecordId?: string;
};

async function getRelatedCreateMode({
  context,
  fields,
  entityType,
  params,
}: {
  context: { workspaceId: string; entityTypeId: string };
  fields: Awaited<ReturnType<typeof getEntityContext>>["fields"];
  entityType: Awaited<ReturnType<typeof getEntityContext>>["entityType"];
  params: RelatedCreateParams;
}) {
  const {
    prefillRelationFieldId,
    originEntityTypeId,
    originRecordId,
  } = params;

  if (
    entityType.archivedAt ||
    !prefillRelationFieldId ||
    !originEntityTypeId ||
    !originRecordId
  ) {
    return undefined;
  }

  const relationField = fields.find(
    (field) =>
      field.id === prefillRelationFieldId &&
      field.type === "relation" &&
      field.relatedEntityTypeId === originEntityTypeId,
  );

  if (!relationField) {
    return undefined;
  }

  try {
    const originContext = await getEntityContext({
      workspaceId: context.workspaceId,
      entityTypeId: originEntityTypeId,
    });
    const originRecord = await getEntityRecord({
      workspaceId: context.workspaceId,
      entityTypeId: originEntityTypeId,
      recordId: originRecordId,
      fields: originContext.fields,
    });

    if (originContext.entityType.archivedAt || originRecord.archivedAt) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return {
    initialValues: { [relationField.key]: originRecordId },
    cancelHref: `/entities/${originEntityTypeId}/records/${originRecordId}`,
    origin: {
      entityTypeId: originEntityTypeId,
      recordId: originRecordId,
    },
  };
}

function entityPageHref(
  entityTypeId: string,
  params: Array<string | false | "">,
) {
  const query = params.filter(Boolean).join("&");

  return query ? `/entities/${entityTypeId}?${query}` : `/entities/${entityTypeId}`;
}

async function loadEntityPageData({
  entityTypeId,
  showArchivedRecords,
  showArchivedEntities,
  showArchivedFields,
}: {
  entityTypeId: string;
  showArchivedRecords: boolean;
  showArchivedEntities: boolean;
  showArchivedFields: boolean;
}) {
  const context = {
    workspaceId: DEMO_WORKSPACE_ID,
    entityTypeId,
  };

  try {
    const [
      navigationEntityTypes,
      activeEntityTypes,
      allEntityTypes,
      entityContext,
      fieldManagementContext,
      allFieldContext,
      workflows,
      views,
    ] = await Promise.all([
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
      getEntityContext({
        ...context,
        includeArchivedFields: showArchivedFields,
      }),
      getEntityContext({
        ...context,
        includeArchivedFields: true,
      }),
      listWorkflows({ workspaceId: DEMO_WORKSPACE_ID }),
      listEntityViews(context),
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
      fieldManagementContext,
      allFields: allFieldContext.fields,
      workflowReferenceCountByFieldId: countWorkflowReferencesByFieldId({
        workflows,
        fieldDefinitionIds: fieldManagementContext.fields.map((field) => field.id),
      }),
      viewReferenceCountByFieldId: countViewReferencesByFieldId({
        views,
        fieldDefinitionIds: fieldManagementContext.fields.map((field) => field.id),
      }),
      views,
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
    showArchivedFields?: string;
    view?: string;
    prefillRelationFieldId?: string;
    originEntityTypeId?: string;
    originRecordId?: string;
  }>;
}) {
  const { entityTypeId } = await params;
  const {
    showArchived: showArchivedParam,
    showArchivedEntities: showArchivedEntitiesParam,
    showArchivedFields: showArchivedFieldsParam,
    view: viewParam,
    prefillRelationFieldId,
    originEntityTypeId,
    originRecordId,
  } = await searchParams;
  const showArchivedRecords = showArchivedParam === "true";
  const showArchivedEntities = showArchivedEntitiesParam === "true";
  const showArchivedFields = showArchivedFieldsParam === "true";
  const pageData = await loadEntityPageData({
    entityTypeId,
    showArchivedRecords,
    showArchivedEntities,
    showArchivedFields,
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
    fieldManagementContext,
    allFields,
    workflowReferenceCountByFieldId,
    viewReferenceCountByFieldId,
    views,
    records,
    relationLookups,
  } = pageData;
  const selectedView =
    viewParam === "all"
      ? undefined
      : viewParam
        ? views.find((view) => view.id === viewParam)
        : views.find((view) => view.isDefault);
  const evaluatedView = evaluateEntityView({
    selectedView,
    activeFields: fields,
    allFields,
    records,
  });
  const isArchivedEntity = Boolean(entityType.archivedAt);
  const entityNameById = Object.fromEntries(
    allEntityTypes.map((listedEntityType) => [
      listedEntityType.id,
      listedEntityType.name,
    ]),
  );
  const relatedCreateMode = await getRelatedCreateMode({
    context,
    entityType,
    fields,
    params: {
      prefillRelationFieldId,
      originEntityTypeId,
      originRecordId,
    },
  });
  const createEntityRecord = createRecord.bind(
    null,
    relatedCreateMode ? { ...context, relatedCreateOrigin: relatedCreateMode.origin } : context,
  );
  const addEntityField = addFieldDefinition.bind(null, context);
  const createEntityView = createView.bind(null, context);
  const updateEntityView = selectedView
    ? updateView.bind(null, { ...context, viewId: selectedView.id })
    : undefined;
  const deleteEntityView = selectedView
    ? deleteView.bind(null, { ...context, viewId: selectedView.id })
    : undefined;
  const updateEntity = updateEntityMetadata.bind(null, context);
  const archiveCurrentEntity = archiveEntity.bind(null, context);
  const restoreCurrentEntity = restoreEntity.bind(null, context);
  const deleteCurrentEntity = deleteEntity.bind(null, context);
  const archivedEntityQuery = showArchivedEntities
    ? "showArchivedEntities=true"
    : "";
  const archivedFieldsQuery = showArchivedFields
    ? "showArchivedFields=true"
    : "";
  const showArchivedRecordsHref = entityPageHref(entityType.id, [
    "showArchived=true",
    archivedEntityQuery,
    archivedFieldsQuery,
  ]);
  const hideArchivedRecordsHref = entityPageHref(entityType.id, [
    archivedEntityQuery,
    archivedFieldsQuery,
  ]);
  const showArchivedFieldsHref = entityPageHref(entityType.id, [
    "showArchivedFields=true",
    showArchivedRecords ? "showArchived=true" : "",
    archivedEntityQuery,
  ]);
  const hideArchivedFieldsHref = entityPageHref(entityType.id, [
    showArchivedRecords ? "showArchived=true" : "",
    archivedEntityQuery,
  ]);

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
          fields={fields}
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
              fields={fieldManagementContext.fields}
              entityNameById={entityNameById}
              workflowReferenceCountByFieldId={workflowReferenceCountByFieldId}
              viewReferenceCountByFieldId={viewReferenceCountByFieldId}
            />
            <div className="mx-auto -mt-6 w-full max-w-6xl">
              <Link
                href={
                  showArchivedFields
                    ? hideArchivedFieldsHref
                    : showArchivedFieldsHref
                }
                className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
              >
                {showArchivedFields
                  ? "Hide archived fields"
                  : "Show archived fields"}
              </Link>
            </div>
            <RecordCreateForm
              entityType={entityType}
              fields={fields}
              relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
              entityNameById={entityNameById}
              initialValues={relatedCreateMode?.initialValues}
              cancelHref={relatedCreateMode?.cancelHref}
              createRecordAction={createEntityRecord}
            />
          </>
        ) : null}
        {!isArchivedEntity ? (
          <EntityViewsPanel
            entityType={entityType}
            views={views}
            selectedView={selectedView}
            activeFields={fields}
            allFields={allFields}
            relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
            warnings={evaluatedView.warnings}
            invalidFilter={evaluatedView.invalidFilter}
            createViewAction={createEntityView}
            updateViewAction={updateEntityView}
            deleteViewAction={deleteEntityView}
          />
        ) : null}
        <EntityRecordsTable
          entityType={entityType}
          fields={evaluatedView.visibleFields}
          identityFields={fields}
          records={evaluatedView.records}
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
