import { notFound, redirect } from "next/navigation";
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
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { EntityRecordsTable } from "@/app/components/entity-records-table";
import { EntitySettingsForm } from "@/app/components/entity-settings-form";
import { EntityViewsPanel } from "@/app/components/entity-views-panel";
import { FieldCreateForm } from "@/app/components/field-create-form";
import { FieldManagementList } from "@/app/components/field-management-list";
import { RecordCreateForm } from "@/app/components/record-create-form";
import {
  PageHeader,
  WorkspacePageLayout,
} from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
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
  workspaceId,
  entityTypeId,
  showArchivedRecords,
  showArchivedEntities,
  showArchivedFields,
}: {
  workspaceId: string;
  entityTypeId: string;
  showArchivedRecords: boolean;
  showArchivedEntities: boolean;
  showArchivedFields: boolean;
}) {
  const context = {
    workspaceId,
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
        workspaceId,
        includeArchived: showArchivedEntities,
      }),
      listEntityTypes({ workspaceId }),
      listEntityTypes({
        workspaceId,
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
      listWorkflows({ workspaceId }),
      listEntityViews(context),
    ]);
    const [records, relationLookups] = await Promise.all([
      listEntityRecords({
        ...context,
        fields: entityContext.fields,
        includeArchived: showArchivedRecords,
      }),
      getRelationLookups({
        workspaceId,
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
    manage?: string;
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
    manage: manageParam,
  } = await searchParams;
  const showArchivedRecords = showArchivedParam === "true";
  const showArchivedEntities = showArchivedEntitiesParam === "true";
  const showArchivedFields = showArchivedFieldsParam === "true";
  const { workspaceId } = await getActiveWorkspaceId();
  const [pageData, permissions] = await Promise.all([
    loadEntityPageData({
      workspaceId,
      entityTypeId,
      showArchivedRecords,
      showArchivedEntities,
      showArchivedFields,
    }),
    getWorkspacePermissionContext(workspaceId),
  ]);
  const canManageSchema = Boolean(permissions?.capabilities.has("schema.manage"));

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
  // Schema-management content (settings/field forms) is only ever shown to a
  // canManageSchema caller. Archived entities used to force isManaging on
  // for everyone who could merely view them; that's now capability-gated
  // too, so an unauthorized viewer of an archived entity gets the plain
  // read-only records view instead of admin forms it can't submit anyway.
  const isManaging = (manageParam === "true" || isArchivedEntity) && canManageSchema;
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
  const manageEntityHref = entityPageHref(entityType.id, [
    "manage=true",
    showArchivedRecords ? "showArchived=true" : "",
    archivedEntityQuery,
    archivedFieldsQuery,
  ]);
  const recordsHref = entityPageHref(entityType.id, [
    showArchivedRecords ? "showArchived=true" : "",
    archivedEntityQuery,
  ]);

  // Canonicalize away from an explicit ?manage=true rather than merely
  // hiding the management controls: a schema.manage-less caller who
  // requests it directly lands on the same URL an authorized "Return to
  // records" click would use, not a partial/hidden management page.
  if (manageParam === "true" && !canManageSchema) {
    redirect(recordsHref);
  }

  const emptyState =
    evaluatedView.records.length === 0
      ? selectedView && records.length > 0
        ? {
            title: `No records match ${selectedView.name}.`,
            description: "Try another view or add a record that matches this view.",
          }
        : {
            title: `No ${entityType.name.toLowerCase()} records yet.`,
            description: `Add the first ${entityType.name.toLowerCase()} to get started.`,
          }
      : undefined;

  return (
    <WorkspacePageLayout
      navigation={<WorkspaceNavigation
        entityTypes={navigationEntityTypes}
        activeEntityTypeId={entityType.id}
        showArchivedEntities={showArchivedEntities}
      />}
    >
        <PageHeader
          eyebrow="Business object"
          title={entityType.name}
          description={entityType.description}
          actions={!isArchivedEntity && canManageSchema ? (
            <Link
              href={isManaging ? recordsHref : manageEntityHref}
              className="inline-flex h-10 items-center justify-center border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              {isManaging ? "Return to records" : "Manage"}
            </Link>
          ) : undefined}
        />
        {isManaging ? (
          <EntitySettingsForm
            entityType={entityType}
            fields={fields}
            updateEntityMetadataAction={updateEntity}
            archiveEntityAction={archiveCurrentEntity}
            restoreEntityAction={restoreCurrentEntity}
            deleteEntityAction={deleteCurrentEntity}
          />
        ) : null}
        {isManaging && !isArchivedEntity ? (
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
            <div className="mx-auto -mt-6 w-full max-w-6xl bg-white">
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
          </>
        ) : null}
        {!isArchivedEntity && !isManaging ? (
          <EntityViewsPanel
            entityType={entityType}
            views={views}
            selectedView={selectedView}
            recordCount={evaluatedView.records.length}
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
        {!isArchivedEntity && !isManaging ? (
          <RecordCreateForm
            entityType={entityType}
            fields={fields}
            relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
            entityNameById={entityNameById}
            initialValues={relatedCreateMode?.initialValues}
            cancelHref={relatedCreateMode?.cancelHref}
            createRecordAction={createEntityRecord}
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
          emptyState={isArchivedEntity ? undefined : emptyState}
        />
        <div className="mx-auto w-full max-w-6xl bg-white">
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
    </WorkspacePageLayout>
  );
}
