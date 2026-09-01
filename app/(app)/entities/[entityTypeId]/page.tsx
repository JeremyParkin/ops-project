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
import { EntityRecordsTable } from "@/app/components/entity-records-table";
import { EntitySettingsForm } from "@/app/components/entity-settings-form";
import { EntityViewQuickBar } from "@/app/components/entity-view-quickbar";
import { EntityViewsPanel } from "@/app/components/entity-views-panel";
import { FieldCreateForm } from "@/app/components/field-create-form";
import { FieldManagementList } from "@/app/components/field-management-list";
import { ObjectContextNav } from "@/app/components/object-context-nav";
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
  entityRecordExists,
  getRelationLookups,
  getEntityRecord,
  listEntityRecords,
} from "@/lib/domain/record-repository";
import {
  evaluateViewState,
  getDefaultColumnFieldDefinitionIds,
} from "@/lib/domain/view-engine";
import { SORTABLE_FIELD_TYPES } from "@/lib/domain/view-operators";
import {
  cycleSortForField,
  hasPendingViewParams,
  isSameViewState,
  rawSearchParamsToUrlSearchParams,
  searchParamsToFormData,
  serializeViewState,
  withViewStateParams,
  type RawSearchParams,
} from "@/lib/domain/view-query-state";
import { validateViewFormData } from "@/lib/domain/view-validation";
import type { ViewFilter, ViewSort } from "@/lib/domain/view-types";
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
  showArchivedFields,
}: {
  workspaceId: string;
  entityTypeId: string;
  showArchivedRecords: boolean;
  showArchivedFields: boolean;
}) {
  const context = {
    workspaceId,
    entityTypeId,
  };

  try {
    const [
      activeEntityTypes,
      allEntityTypes,
      entityContext,
      fieldManagementContext,
      allFieldContext,
      workflows,
      views,
    ] = await Promise.all([
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
  searchParams: Promise<
    {
      showArchived?: string;
      showArchivedFields?: string;
      view?: string;
      newView?: string;
      prefillRelationFieldId?: string;
      originEntityTypeId?: string;
      originRecordId?: string;
      manage?: string;
      saveView?: string;
    } & RawSearchParams
  >;
}) {
  const { entityTypeId } = await params;
  const rawSearchParams = await searchParams;
  const {
    showArchived: showArchivedParam,
    showArchivedFields: showArchivedFieldsParam,
    view: viewParam,
    newView: newViewParam,
    prefillRelationFieldId,
    originEntityTypeId,
    originRecordId,
    manage: manageParam,
    saveView: saveViewParam,
  } = rawSearchParams;
  const showArchivedRecords = showArchivedParam === "true";
  const showArchivedFields = showArchivedFieldsParam === "true";
  const { workspaceId } = await getActiveWorkspaceId();
  const [pageData, permissions] = await Promise.all([
    loadEntityPageData({
      workspaceId,
      entityTypeId,
      showArchivedRecords,
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

  // Unsaved quick-bar filter/sort/column edits are encoded as URL params
  // (see lib/domain/view-query-state.ts) using the same field names the
  // Manage Views form submits, so they can be read with the exact same
  // validateViewFormData used for saved-view submissions -- no separate
  // "pending state" model. When present, they fully override the selected
  // view's own filters/sorts/columns for this render; nothing is written to
  // the database until the user explicitly saves or updates a view.
  const fallbackFilters = selectedView?.filters ?? [];
  const fallbackSorts = selectedView?.sorts ?? [];
  const fallbackColumnIds =
    selectedView?.columnFieldDefinitionIds ?? getDefaultColumnFieldDefinitionIds(fields);

  let effectiveFilters: ViewFilter[];
  let effectiveSorts: ViewSort[];
  let effectiveColumnIds: string[];

  if (hasPendingViewParams(rawSearchParams)) {
    const pendingFormData = searchParamsToFormData(rawSearchParams);
    const pendingValidation = await validateViewFormData({
      activeFields: fields,
      allFields,
      formData: pendingFormData,
      validateRelationValue: async (field, recordId) => {
        if (!field.relatedEntityTypeId) {
          return false;
        }

        return entityRecordExists({
          workspaceId,
          entityTypeId: field.relatedEntityTypeId,
          recordId,
          includeArchived: true,
        });
      },
    });
    effectiveFilters = pendingValidation.values.filters;
    effectiveSorts = pendingValidation.values.sorts;
    effectiveColumnIds = pendingValidation.values.columnFieldDefinitionIds;
  } else {
    effectiveFilters = fallbackFilters;
    effectiveSorts = fallbackSorts;
    effectiveColumnIds = fallbackColumnIds;
  }

  // The quick bar always re-serializes a *full* {filters, sorts, columns}
  // snapshot on every edit (see serializeViewState), so URL pending-param
  // presence alone would still read as "unsaved changes" even after e.g.
  // cycling a sort back to none with columns untouched. Compare against the
  // fallback state instead, so the banner only shows when something is
  // actually different.
  const hasPendingViewEdits = !isSameViewState(
    { filters: effectiveFilters, sorts: effectiveSorts, columnFieldDefinitionIds: effectiveColumnIds },
    { filters: fallbackFilters, sorts: fallbackSorts, columnFieldDefinitionIds: fallbackColumnIds },
  );

  const evaluatedViewState = evaluateViewState({
    filters: effectiveFilters,
    sorts: effectiveSorts,
    columnFieldDefinitionIds: effectiveColumnIds,
    activeFields: fields,
    allFields,
    records,
  });
  const evaluatedView = { ...evaluatedViewState, selectedView };

  const currentSearchParams = rawSearchParamsToUrlSearchParams(rawSearchParams);
  const sortHrefByFieldId: Record<string, string> = {};
  const sortDirectionByFieldId: Record<string, "asc" | "desc"> = {};
  evaluatedView.visibleFields
    .filter((field) => SORTABLE_FIELD_TYPES.has(field.type))
    .forEach((field) => {
      const nextSorts = cycleSortForField({
        currentSorts: effectiveSorts,
        fieldId: field.id,
      });
      const nextParams = withViewStateParams(
        currentSearchParams,
        serializeViewState({
          filters: effectiveFilters,
          sorts: nextSorts,
          columnFieldDefinitionIds: effectiveColumnIds,
        }),
      );
      sortHrefByFieldId[field.id] = `/entities/${entityTypeId}?${nextParams.toString()}`;
    });
  effectiveSorts.forEach((sort) => {
    sortDirectionByFieldId[sort.fieldDefinitionId] = sort.direction;
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
  const archivedFieldsQuery = showArchivedFields
    ? "showArchivedFields=true"
    : "";
  const showArchivedRecordsHref = entityPageHref(entityType.id, [
    "showArchived=true",
    archivedFieldsQuery,
  ]);
  const hideArchivedRecordsHref = entityPageHref(entityType.id, [
    archivedFieldsQuery,
  ]);
  const showArchivedFieldsHref = entityPageHref(entityType.id, [
    "showArchivedFields=true",
    showArchivedRecords ? "showArchived=true" : "",
  ]);
  const hideArchivedFieldsHref = entityPageHref(entityType.id, [
    showArchivedRecords ? "showArchived=true" : "",
  ]);
  const manageEntityHref = entityPageHref(entityType.id, [
    "manage=true",
    showArchivedRecords ? "showArchived=true" : "",
    archivedFieldsQuery,
  ]);
  const recordsHref = entityPageHref(entityType.id, [
    showArchivedRecords ? "showArchived=true" : "",
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
      contextNav={
        !isArchivedEntity && !isManaging ? (
          <ObjectContextNav entityType={entityType} views={views} selectedView={selectedView} />
        ) : undefined
      }
    >
        <PageHeader
          eyebrow={entityType.name}
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
            openManageByDefault={
              newViewParam === "true" || (saveViewParam === "true" && hasPendingViewEdits)
            }
            pendingOverride={
              hasPendingViewEdits
                ? {
                    filters: effectiveFilters,
                    sorts: effectiveSorts,
                    columnFieldDefinitionIds: effectiveColumnIds,
                  }
                : undefined
            }
          />
        ) : null}
        {!isArchivedEntity && !isManaging ? (
          <EntityViewQuickBar
            activeFields={fields}
            relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
            effectiveFilters={effectiveFilters}
            effectiveSorts={effectiveSorts}
            effectiveColumnIds={effectiveColumnIds}
            hasPendingEdits={hasPendingViewEdits}
            selectedViewName={selectedView?.name}
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
          emptyState={isArchivedEntity || isManaging ? undefined : emptyState}
          sortHrefByFieldId={sortHrefByFieldId}
          sortDirectionByFieldId={sortDirectionByFieldId}
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
