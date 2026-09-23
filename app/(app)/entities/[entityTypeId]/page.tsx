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
  updateEntityTypeQualityReviewLifecycle,
  updateEntityTypeQualityReviewPresentation,
  updateEntityTypeSensitiveAccess,
  updateView,
} from "@/app/actions";
import {
  deactivateEntityTypeWork,
  saveEntityTypeWorkConfiguration,
} from "@/app/work-actions";
import { EntityRecordsTable } from "@/app/components/entity-records-table";
import { EntityBoardView } from "@/app/components/entity-board-view";
import { EntitySettingsForm } from "@/app/components/entity-settings-form";
import { EntityTypeQualityReviewForm } from "@/app/components/entity-type-quality-review-form";
import { EntityTypeQualityReviewPresentationForm } from "@/app/components/entity-type-quality-review-presentation-form";
import { EntityTypeSensitiveAccessForm } from "@/app/components/entity-type-sensitive-access-form";
import { EntityTypeWorkSettingsForm } from "@/app/components/entity-type-work-settings-form";
import { EntityViewQuickBar } from "@/app/components/entity-view-quickbar";
import { EntityViewsPanel } from "@/app/components/entity-views-panel";
import { FieldCreateForm } from "@/app/components/field-create-form";
import { FieldManagementList } from "@/app/components/field-management-list";
import { ObjectContextNav } from "@/app/components/object-context-nav";
import { RecordCreateForm } from "@/app/components/record-create-form";
import {
  CollapsibleSection,
  PageHeader,
  WorkspacePageLayout,
} from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import {
  getEntityContext,
  getEntityTypeQualityReviewConfig,
  getEntityTypeQualityReviewPresentationConfig,
  getEntityTypeSensitiveAccessConfig,
  listEntityTypes,
} from "@/lib/domain/metadata-repository";
import { getPersonEntityTypeId } from "@/lib/domain/person-link-repository";
import {
  getEntityTypeWorkSettingsConfig,
  type EntityTypeWorkSettingsConfig,
} from "@/lib/domain/work-repository";
import {
  countEntityRecords,
  entityRecordExists,
  getRelationLookups,
  getWorkspaceMemberLookups,
  getEntityRecord,
  listEntityRecords,
  workspaceMemberExists,
} from "@/lib/domain/record-repository";
import { choiceOptionExists, listChoiceOptionsByFieldIds } from "@/lib/domain/choice-option-repository";
import { toChoiceOptionsByFieldKey } from "@/lib/domain/choice-display";
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
  withoutViewStateParams,
  withViewStateParams,
  type RawSearchParams,
} from "@/lib/domain/view-query-state";
import { validateViewFormData } from "@/lib/domain/view-validation";
import { resolveTableEmptyState } from "@/lib/domain/table-empty-state";
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
      personEntityTypeId,
      sensitiveAccessConfig,
      qualityReviewConfig,
      qualityReviewPresentationConfig,
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
      getPersonEntityTypeId({ workspaceId }),
      getEntityTypeSensitiveAccessConfig(context),
      getEntityTypeQualityReviewConfig(context),
      getEntityTypeQualityReviewPresentationConfig(context),
    ]);
    const [records, choiceOptionsByFieldId] = await Promise.all([
      listEntityRecords({
        ...context,
        fields: entityContext.fields,
        includeArchived: showArchivedRecords,
      }),
      listChoiceOptionsByFieldIds({
        workspaceId,
        fieldDefinitionIds: allFieldContext.fields
          .filter((field) => field.type === "choice")
          .map((field) => field.id),
      }),
    ]);
    // Needs `records` as input (to keep each row's own archived relation
    // selection in its dropdown, see getRelationLookups' currentRecords), so
    // this can't join the Promise.all above.
    const relationLookups = await getRelationLookups({
      workspaceId,
      fields: entityContext.fields,
      currentRecords: records,
    });
    const workspaceMemberLookups = await getWorkspaceMemberLookups({
      workspaceId,
      fields: entityContext.fields,
      currentRecords: records,
    });

    return {
      context,
      activeEntityTypes,
      allEntityTypes,
      entityContext,
      fieldManagementContext,
      allFields: allFieldContext.fields,
      choiceOptionsByFieldId,
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
      workspaceMemberLookups,
      personEntityTypeId,
      sensitiveAccessConfig,
      qualityReviewConfig,
      qualityReviewPresentationConfig,
    };
  } catch {
    return null;
  }
}

const DEFAULT_WORK_SETTINGS_CONFIG: EntityTypeWorkSettingsConfig = {
  workEnabled: false,
  assignmentFieldId: null,
  dueFieldId: null,
  statusFieldId: null,
  completionOptionIds: [],
};

// get_entity_type_work_settings_authorized is schema.manage-gated by design
// (builder configuration, not a worker-facing surface -- see 0147) -- unlike
// sensitiveAccessConfig/qualityReviewConfig, which read directly off
// entity_types and are visible to any workspace member. Fetching it
// unconditionally inside loadEntityPageData's own Promise.all previously
// threw for every non-schema.manage viewer, failing the whole page (a real
// regression caught by the full E2E gate, not merely a narrower Work
// Settings issue) -- so this is fetched separately, only once canManageSchema
// is known, and skipped entirely (not merely try/caught) for callers who can
// never see the section it feeds. A genuine fetch failure for an authorized
// caller is deliberately NOT swallowed into the same default here: silently
// showing "Not configured" to an actual builder whose object really is
// configured/active would be exactly the kind of untruthful state this
// slice exists to eliminate -- it should surface as a real error instead.
async function loadWorkSettingsConfig({
  context,
  canManageSchema,
}: {
  context: { workspaceId: string; entityTypeId: string };
  canManageSchema: boolean;
}): Promise<EntityTypeWorkSettingsConfig> {
  if (!canManageSchema) {
    return DEFAULT_WORK_SETTINGS_CONFIG;
  }

  return getEntityTypeWorkSettingsConfig(context);
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
  const canOperateRecords = Boolean(permissions?.capabilities.has("records.operate"));

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
    choiceOptionsByFieldId,
    workflowReferenceCountByFieldId,
    viewReferenceCountByFieldId,
    views,
    records,
    relationLookups,
    workspaceMemberLookups,
    personEntityTypeId,
    sensitiveAccessConfig,
    qualityReviewConfig,
    qualityReviewPresentationConfig,
  } = pageData;
  const workSettingsConfig = await loadWorkSettingsConfig({ context, canManageSchema });
  const choiceOptionsByFieldKey = toChoiceOptionsByFieldKey(allFields, choiceOptionsByFieldId);
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
      validateChoiceValue: async (field, optionId) =>
        choiceOptionExists({
          workspaceId,
          fieldDefinitionId: field.id,
          optionId,
        }),
      validateWorkspaceMemberValue: async (_field, userId) =>
        workspaceMemberExists({
          workspaceId,
          userId,
          includeDeactivated: true,
        }),
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
    choiceOptionsByFieldId,
  });
  const evaluatedView = { ...evaluatedViewState, selectedView };
  const presentation = selectedView?.presentation;
  const configuredPresentationMode =
    presentation?.mode === "board" || presentation?.mode === "calendar"
      ? presentation.mode
      : "table";
  const boardField =
    presentation?.mode === "board"
      ? fields.find((candidate) => candidate.id === presentation.config.choiceFieldDefinitionId)
      : undefined;
  const presentationWarnings: string[] = [];
  let invalidPresentation = false;

  if (presentation?.mode === "invalid") {
    presentationWarnings.push(presentation.reason);
    invalidPresentation = true;
  } else if (presentation?.mode === "board") {
    if (!boardField || boardField.type !== "choice" || boardField.archivedAt) {
      presentationWarnings.push("Board presentation references a Choice field that is archived, missing, or incompatible.");
      invalidPresentation = true;
    }
  } else if (presentation?.mode === "calendar") {
    const field = fields.find((candidate) => candidate.id === presentation.config.dateFieldDefinitionId);

    if (!field || field.type !== "date" || field.archivedAt) {
      presentationWarnings.push("Calendar presentation references a Date field that is archived, missing, or incompatible.");
      invalidPresentation = true;
    }
  }
  const viewWarnings = [...evaluatedView.warnings, ...presentationWarnings];

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
  // 1-based position within effectiveSorts -- Kinema supports multi-column
  // sorts (via the quick bar/Manage Views "Add Sort", not the single-column
  // header-click cycling above), so a header's accessible sort state needs
  // to distinguish the primary sort field from any secondary ones sharing
  // the sortDirectionByFieldId map.
  const sortPositionByFieldId: Record<string, number> = {};
  effectiveSorts.forEach((sort, index) => {
    sortDirectionByFieldId[sort.fieldDefinitionId] = sort.direction;
    sortPositionByFieldId[sort.fieldDefinitionId] = index + 1;
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
  const updateSensitiveAccess = updateEntityTypeSensitiveAccess.bind(null, context);
  const updateQualityReviewLifecycle = updateEntityTypeQualityReviewLifecycle.bind(null, context);
  const updateQualityReviewPresentation = updateEntityTypeQualityReviewPresentation.bind(null, context);
  const saveWorkConfiguration = saveEntityTypeWorkConfiguration.bind(null, context);
  const deactivateWork = deactivateEntityTypeWork.bind(null, context);
  const archiveCurrentEntity = archiveEntity.bind(null, context);
  const restoreCurrentEntity = restoreEntity.bind(null, context);
  const deleteCurrentEntity = deleteEntity.bind(null, context);
  const archivedFieldsQuery = showArchivedFields
    ? "showArchivedFields=true"
    : "";
  // Each carries manage=true when currently managing, so toggling archived
  // visibility from the Manage view doesn't silently drop the caller back
  // to the plain records view.
  const managingQuery = isManaging ? "manage=true" : "";
  const showArchivedRecordsHref = entityPageHref(entityType.id, [
    "showArchived=true",
    archivedFieldsQuery,
    managingQuery,
  ]);
  const hideArchivedRecordsHref = entityPageHref(entityType.id, [
    archivedFieldsQuery,
    managingQuery,
  ]);
  const showArchivedFieldsHref = entityPageHref(entityType.id, [
    "showArchivedFields=true",
    showArchivedRecords ? "showArchived=true" : "",
    managingQuery,
  ]);
  const hideArchivedFieldsHref = entityPageHref(entityType.id, [
    showArchivedRecords ? "showArchived=true" : "",
    managingQuery,
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

  // Each action link is built from currentSearchParams so it only changes
  // what it needs to (archived visibility, or the pending filter) and
  // preserves everything else -- view selection, manage mode, other params
  // -- unchanged.
  const showArchivedPreservingContextParams = new URLSearchParams(currentSearchParams);
  showArchivedPreservingContextParams.set("showArchived", "true");
  const showArchivedPreservingContextHref = `/entities/${entityTypeId}?${showArchivedPreservingContextParams.toString()}`;
  const clearFiltersHref = `/entities/${entityTypeId}?${withoutViewStateParams(currentSearchParams).toString()}`;

  // Only fetched when it's actually needed to distinguish "no records yet"
  // from "all records archived" -- see resolveTableEmptyState.
  const totalRecordCount =
    evaluatedView.records.length === 0 && records.length === 0 && !showArchivedRecords
      ? await countEntityRecords({ workspaceId, entityTypeId: entityType.id })
      : undefined;

  const emptyState = resolveTableEmptyState({
    entityName: entityType.name,
    evaluatedRecordCount: evaluatedView.records.length,
    activeRecordCount: records.length,
    totalRecordCount,
    showArchivedRecords,
    hasPendingViewEdits,
    selectedViewName: selectedView?.name,
    showArchivedHref: showArchivedPreservingContextHref,
    clearFiltersHref,
  });

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
          <CollapsibleSection
            title="Sensitive people data"
            description="Restrict who can see records of this object to the person it's about, their manager, and a designated reviewer -- instead of the whole workspace."
            defaultOpen={sensitiveAccessConfig.peopleSensitive}
          >
            <EntityTypeSensitiveAccessForm
              entityTypeId={entityType.id}
              personTypeDesignated={Boolean(personEntityTypeId)}
              relationFieldsTargetingPersonType={fields.filter(
                (field) => field.type === "relation" && field.relatedEntityTypeId === personEntityTypeId && !field.archivedAt,
              )}
              config={sensitiveAccessConfig}
              action={updateSensitiveAccess}
            />
          </CollapsibleSection>
        ) : null}
        {isManaging && !isArchivedEntity ? (
          <CollapsibleSection
            title="Quality Review"
            description="Give this object a Draft/Finalized state: only the designated reviewer can create and edit a review while it's a draft, and once finalized it becomes read-only history."
            defaultOpen={qualityReviewConfig.qualityReview}
          >
            <EntityTypeQualityReviewForm
              entityTypeId={entityType.id}
              prerequisitesMet={
                sensitiveAccessConfig.peopleSensitive &&
                Boolean(sensitiveAccessConfig.subjectPersonFieldId) &&
                Boolean(sensitiveAccessConfig.authorPersonFieldId) &&
                sensitiveAccessConfig.authorCanView
              }
              choiceFields={fields.filter((field) => field.type === "choice" && !field.archivedAt)}
              optionsByFieldId={choiceOptionsByFieldId}
              config={qualityReviewConfig}
              action={updateQualityReviewLifecycle}
            />
            {qualityReviewConfig.qualityReview ? (
              <EntityTypeQualityReviewPresentationForm
                entityTypeId={entityType.id}
                dateFields={fields.filter((field) => field.type === "date" && !field.archivedAt)}
                choiceFields={fields.filter((field) => field.type === "choice" && !field.archivedAt)}
                config={qualityReviewPresentationConfig}
                action={updateQualityReviewPresentation}
              />
            ) : null}
          </CollapsibleSection>
        ) : null}
        {isManaging && !isArchivedEntity ? (
          <CollapsibleSection
            title="Work settings"
            description="Make this object's records eligible for My Work and assignment notifications."
            defaultOpen={workSettingsConfig.workEnabled || Boolean(workSettingsConfig.assignmentFieldId)}
          >
            <EntityTypeWorkSettingsForm
              entityTypeId={entityType.id}
              workspaceMemberFields={fields.filter((field) => field.type === "workspace_member" && !field.archivedAt)}
              dateFields={fields.filter((field) => field.type === "date" && !field.archivedAt)}
              choiceFields={fields.filter((field) => field.type === "choice" && !field.archivedAt)}
              optionsByFieldId={choiceOptionsByFieldId}
              config={workSettingsConfig}
              saveAction={saveWorkConfiguration}
              deactivateAction={deactivateWork}
            />
          </CollapsibleSection>
        ) : null}
        {isManaging && !isArchivedEntity ? (
          <FieldManagementList
            workspaceId={context.workspaceId}
            entityTypeId={entityType.id}
            fields={fieldManagementContext.fields}
            entityNameById={entityNameById}
            workflowReferenceCountByFieldId={workflowReferenceCountByFieldId}
            viewReferenceCountByFieldId={viewReferenceCountByFieldId}
            choiceOptionsByFieldId={choiceOptionsByFieldId}
            activeEntityTypes={activeEntityTypes}
            addFieldForm={
              <FieldCreateForm
                entityTypes={activeEntityTypes}
                addFieldDefinitionAction={addEntityField}
              />
            }
          />
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
            workspaceMemberOptionsByFieldKey={workspaceMemberLookups.optionsByFieldKey}
            choiceOptionsByFieldKey={choiceOptionsByFieldKey}
            warnings={viewWarnings}
            invalidFilter={evaluatedView.invalidFilter || invalidPresentation}
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
            workspaceMemberOptionsByFieldKey={workspaceMemberLookups.optionsByFieldKey}
            choiceOptionsByFieldKey={choiceOptionsByFieldKey}
            effectiveFilters={effectiveFilters}
            effectiveSorts={effectiveSorts}
            effectiveColumnIds={effectiveColumnIds}
            hasPendingEdits={hasPendingViewEdits}
            selectedViewName={selectedView?.name}
            presentationMode={configuredPresentationMode}
          />
        ) : null}
        {!isArchivedEntity && !isManaging ? (
          <RecordCreateForm
            entityType={entityType}
            fields={fields}
            relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
            workspaceMemberOptionsByFieldKey={workspaceMemberLookups.optionsByFieldKey}
            choiceOptionsByFieldKey={choiceOptionsByFieldKey}
            entityNameById={entityNameById}
            initialValues={relatedCreateMode?.initialValues}
            cancelHref={relatedCreateMode?.cancelHref}
            createRecordAction={createEntityRecord}
          />
        ) : null}
        {invalidPresentation && !isArchivedEntity && !isManaging ? (
          <section className="mx-auto w-full max-w-6xl border border-amber-300 bg-amber-50 px-5 py-10 text-center">
            <h2 className="text-lg font-semibold text-amber-950">View needs repair.</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-amber-900">
              This saved view references invalid presentation configuration and cannot be rendered until it is repaired.
            </p>
          </section>
        ) : !isArchivedEntity && !isManaging && configuredPresentationMode === "board" && boardField ? (
          <EntityBoardView
            entityType={entityType}
            fields={fields}
            records={evaluatedView.records}
            boardField={boardField}
            choiceOptions={choiceOptionsByFieldId[boardField.id] ?? []}
            recordActionContext={canOperateRecords ? context : undefined}
            emptyState={emptyState}
          />
        ) : !isArchivedEntity && !isManaging && configuredPresentationMode === "calendar" ? (
          <section className="mx-auto w-full max-w-6xl border border-dashed border-grit bg-chalk px-5 py-10 text-center">
            <h2 className="text-lg font-semibold text-graphite">
              Calendar view configured
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-stone">
              This saved view is configured for calendar, but that renderer is not available in this implementation slice yet.
            </p>
          </section>
        ) : (
          <EntityRecordsTable
            entityType={entityType}
            fields={evaluatedView.visibleFields}
            identityFields={fields}
            records={evaluatedView.records}
            relationLabelsByFieldKey={relationLookups.labelsByFieldKey}
            relationOptionsByFieldKey={relationLookups.optionsByFieldKey}
            workspaceMemberLabelsByFieldKey={workspaceMemberLookups.labelsByFieldKey}
            workspaceMemberOptionsByFieldKey={workspaceMemberLookups.optionsByFieldKey}
            choiceOptionsByFieldKey={choiceOptionsByFieldKey}
            recordEditPathBase={
              isArchivedEntity ? undefined : `/entities/${entityType.id}/records`
            }
            recordActionContext={isArchivedEntity ? undefined : context}
            emptyState={isArchivedEntity || isManaging ? undefined : emptyState}
            sortHrefByFieldId={sortHrefByFieldId}
            sortDirectionByFieldId={sortDirectionByFieldId}
            sortPositionByFieldId={sortPositionByFieldId}
            sortFieldCount={effectiveSorts.length}
          />
        )}
        {isManaging && !isArchivedEntity ? (
          // Both archive-visibility toggles grouped immediately below the
          // field-preview/table block they affect, rather than "Show
          // archived fields" sitting up by Manage Fields while "Show
          // archived records" sat below the table (dogfood). Each link's
          // text still names exactly what it shows/hides; hrefs/behavior
          // are unchanged from before this relocation.
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1">
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
        ) : !isManaging ? (
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
        ) : null}
    </WorkspacePageLayout>
  );
}
