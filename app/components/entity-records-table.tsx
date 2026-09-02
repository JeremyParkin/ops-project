import Link from "next/link";
import {
  archiveRecord,
  bulkArchiveRecords,
  bulkRestoreRecords,
  deleteRecord,
  restoreRecord,
  updateRecordField,
} from "@/app/actions";
import { ChoicePill } from "@/app/components/choice-pill";
import { EditableTableCell } from "@/app/components/editable-table-cell";
import { RecordBulkActionsBar } from "@/app/components/record-bulk-actions-bar";
import { RecordRowActions } from "@/app/components/record-row-actions";
import { RecordSelectionCheckbox } from "@/app/components/record-selection-checkbox";
import { RecordSelectionProvider } from "@/app/components/record-selection-context";
import { RecordSelectionHeaderCheckbox } from "@/app/components/record-selection-header-checkbox";
import { resolveChoiceOption } from "@/lib/domain/choice-display";
import type { ChoiceOptionsByFieldKey } from "@/lib/domain/choice-display";
import { linkifyText } from "@/lib/domain/text-linkification";
import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
  FieldValue,
} from "@/lib/domain/types";
import type {
  RelationLabelsByFieldKey,
  RelationOptionsByFieldKey,
} from "@/lib/domain/record-repository";
import { getRecordIdentityField } from "@/lib/domain/record-repository";

type EntityRecordsTableProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  identityFields?: FieldDefinition[];
  records: EntityRecord[];
  relationLabelsByFieldKey?: RelationLabelsByFieldKey;
  relationOptionsByFieldKey?: RelationOptionsByFieldKey;
  choiceOptionsByFieldKey?: ChoiceOptionsByFieldKey;
  recordEditPathBase?: string;
  recordActionContext?: {
    workspaceId: string;
    entityTypeId: string;
  };
  emptyState?: {
    title: string;
    description: string;
    // An optional resolving action (e.g. "Show archived records", "Clear
    // filters") rendered ahead of the standard Add/Import actions -- only
    // present for empty states caused by something the user can directly
    // undo, not a genuinely empty object.
    action?: { label: string; href: string };
  };
  // Click-to-sort column headers: only sortable, currently-visible fields
  // appear as keys. `sortHrefByFieldId` is the href a header click should
  // navigate to next (cycling none -> asc -> desc -> none);
  // `sortDirectionByFieldId` holds the field's *current* direction, for the
  // arrow indicator, and is only set for fields presently part of the sort.
  // `sortPositionByFieldId` is that field's 1-based position within the
  // active multi-column sort (Kinema supports sorting by more than one
  // field at once via Manage Views/quick-bar "Add Sort", even though a
  // header click always replaces the sort with just that one column) --
  // only position 1 (the primary sort) gets `aria-sort`; secondary/tertiary
  // positions get accessible text instead, since aria-sort has no standard
  // way to express "2nd of 3" on more than one header at a time.
  // `sortFieldCount` is the total number of active sort fields, used to
  // decide whether that secondary-position text is worth showing at all.
  sortHrefByFieldId?: Record<string, string>;
  sortDirectionByFieldId?: Record<string, "asc" | "desc">;
  sortPositionByFieldId?: Record<string, number>;
  sortFieldCount?: number;
};

function formatFieldValue(
  field: FieldDefinition,
  value: FieldValue | undefined,
  relationLabelsByFieldKey: RelationLabelsByFieldKey,
  choiceOptionsByFieldKey: ChoiceOptionsByFieldKey,
) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  switch (field.type) {
    case "text":
      return String(value);
    case "number":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    case "date":
      return String(value);
    case "boolean":
      return value === true ? "Yes" : "No";
    case "relation":
      return typeof value === "string"
        ? relationLabelsByFieldKey[field.key]?.[value] ?? `${value.slice(0, 8)}...`
        : "—";
    case "choice": {
      const option = resolveChoiceOption(choiceOptionsByFieldKey[field.key] ?? [], value);
      return option?.label ?? "Unknown option";
    }
  }
}

// Relation and choice both need a dropdown of options rather than a plain
// text/number/date/boolean input -- EditableTableCell branches on
// field.type itself for the actual control.
const INLINE_EDITABLE_FIELD_TYPES = new Set<FieldDefinition["type"]>([
  "text",
  "number",
  "date",
  "boolean",
  "choice",
  "relation",
]);

function formatTableCell(
  field: FieldDefinition,
  value: FieldValue | undefined,
  relationLabelsByFieldKey: RelationLabelsByFieldKey,
  choiceOptionsByFieldKey: ChoiceOptionsByFieldKey,
  // False for the identity-field column, which the row already wraps in its
  // own <Link> to the record -- a nested <a> there would be invalid HTML.
  linkifyPlainText = true,
) {
  if (field.type === "choice") {
    const option = resolveChoiceOption(choiceOptionsByFieldKey[field.key] ?? [], value);
    return option ? <ChoicePill option={option} /> : "—";
  }

  const formattedValue = formatFieldValue(
    field,
    value,
    relationLabelsByFieldKey,
    choiceOptionsByFieldKey,
  );

  if (field.type === "relation" && formattedValue !== "—") {
    return (
      <span className="inline-flex items-center border border-grit bg-chalk px-2 py-1 text-xs font-medium text-stone">
        {formattedValue}
      </span>
    );
  }

  if (field.type === "text" && linkifyPlainText && typeof value === "string" && value !== "") {
    const linkified = linkifyText(value);

    if (linkified.kind !== "plain") {
      return (
        <a
          href={linkified.href}
          target={linkified.kind === "url" ? "_blank" : undefined}
          rel={linkified.kind === "url" ? "noopener noreferrer" : undefined}
          className="underline-offset-4 hover:underline"
        >
          {linkified.text}
        </a>
      );
    }
  }

  return formattedValue;
}

export function EntityRecordsTable({
  entityType,
  fields,
  identityFields = fields,
  records,
  relationLabelsByFieldKey = {},
  relationOptionsByFieldKey = {},
  choiceOptionsByFieldKey = {},
  recordEditPathBase,
  recordActionContext,
  emptyState,
  sortHrefByFieldId = {},
  sortDirectionByFieldId = {},
  sortPositionByFieldId = {},
  sortFieldCount = 0,
}: EntityRecordsTableProps) {
  const identityField = getRecordIdentityField({
    entityType,
    fields: identityFields,
  });
  const identityFieldIsVisible = fields.some(
    (field) => field.id === identityField?.id,
  );

  if (records.length === 0 && emptyState) {
    return (
      <section className="mx-auto w-full max-w-6xl border border-dashed border-grit bg-chalk px-5 py-10 text-center">
        <h2 className="text-lg font-semibold text-graphite">{emptyState.title}</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-stone">
          {emptyState.description}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {emptyState.action ? (
            <Link
              href={emptyState.action.href}
              className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
            >
              {emptyState.action.label}
            </Link>
          ) : null}
          <Link
            href="#add-record"
            className={
              emptyState.action
                ? "inline-flex h-10 items-center justify-center border border-grit px-4 text-sm font-medium text-stone hover:bg-slab/5"
                : "inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
            }
          >
            Add {entityType.name}
          </Link>
          <Link
            href={`/entities/${entityType.id}/import`}
            className="inline-flex h-10 items-center justify-center border border-grit px-4 text-sm font-medium text-stone hover:bg-slab/5"
          >
            Import CSV
          </Link>
        </div>
      </section>
    );
  }

  const recordIds = records.map((record) => record.id);
  // Restoring only ever makes sense once at least one currently-rendered
  // row is archived -- true whenever "Show archived records" is on and the
  // object actually has any. In the default (active-only) view, every
  // selectable row is already active, so the bar never offers it there.
  const showRestoreAction = records.some((record) => record.archivedAt);

  return (
    // resetKey is the exact rendered id order: a filter/sort/
    // archived-toggle change (different ids or a different order) resets
    // selection -- see record-selection-context.tsx for why this is a
    // plain prop the provider reacts to internally, not a React `key`
    // (which would remount the bulk bar's own action-result state right as
    // a successful action's own revalidation changes this same value). A
    // pure column-visibility change doesn't affect `records`, so it
    // correctly leaves selection untouched.
    <RecordSelectionProvider resetKey={recordIds.join(",")}>
      <section className="mx-auto w-full max-w-6xl">
      <div className="overflow-hidden border border-grit bg-white">
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label={`${entityType.name} records table, scroll horizontally for more columns`}
        >
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-chalk text-xs uppercase tracking-wide text-stone">
              <tr>
                {recordActionContext ? (
                  <th scope="col" className="border-b border-grit px-4 py-3 font-medium">
                    <RecordSelectionHeaderCheckbox recordIds={recordIds} />
                  </th>
                ) : null}
                {fields.map((field) => {
                  const sortHref = sortHrefByFieldId[field.id];
                  const sortDirection = sortDirectionByFieldId[field.id];
                  const sortPosition = sortPositionByFieldId[field.id];
                  // aria-sort has no standard way to mark "2nd of N" on more
                  // than one header at once, so only the primary sort field
                  // gets it; a secondary/tertiary field gets accessible text
                  // instead (below) so the multi-sort state isn't silently
                  // dropped for assistive tech.
                  const isPrimarySort = sortPosition === 1;

                  return (
                    <th
                      key={field.id}
                      scope="col"
                      aria-sort={
                        isPrimarySort
                          ? sortDirection === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                      className="border-b border-grit px-4 py-3 font-medium"
                    >
                      {sortHref ? (
                        <Link
                          href={sortHref}
                          className="inline-flex items-center gap-1 hover:text-graphite"
                        >
                          {field.name}
                          <span aria-hidden="true">
                            {sortDirection === "asc"
                              ? "▲"
                              : sortDirection === "desc"
                                ? "▼"
                                : ""}
                          </span>
                          {sortDirection ? (
                            <span className="sr-only">
                              , sorted {sortDirection === "asc" ? "ascending" : "descending"}
                              {!isPrimarySort && sortFieldCount > 1
                                ? ` — sort ${sortPosition} of ${sortFieldCount}`
                                : ""}
                            </span>
                          ) : (
                            <span className="sr-only">, click to sort</span>
                          )}
                        </Link>
                      ) : (
                        field.name
                      )}
                    </th>
                  );
                })}
                {recordEditPathBase ? (
                  <th
                    scope="col"
                    className="border-b border-grit px-4 py-3 font-medium"
                  >
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-chalk text-graphite">
              {records.map((record) => {
                const actionContext = recordActionContext
                  ? {
                      ...recordActionContext,
                      recordId: record.id,
                    }
                  : undefined;
                const updateFieldAction = actionContext
                  ? updateRecordField.bind(null, actionContext)
                  : undefined;
                const recordEditHref = recordEditPathBase
                  ? `${recordEditPathBase}/${record.id}/edit`
                  : undefined;
                const recordLabel = identityField
                  ? formatFieldValue(
                      identityField,
                      record.values[identityField.key],
                      relationLabelsByFieldKey,
                      choiceOptionsByFieldKey,
                    )
                  : record.id;

                return (
                <tr
                  key={record.id}
                  className={record.archivedAt ? "bg-chalk text-stone" : ""}
                >
                  {recordActionContext ? (
                    <td className="px-4 py-3 align-middle">
                      <RecordSelectionCheckbox
                        recordId={record.id}
                        recordLabel={recordLabel}
                      />
                    </td>
                  ) : null}
                  {fields.map((field) => {
                    const cell = formatTableCell(
                      field,
                      record.values[field.key],
                      relationLabelsByFieldKey,
                      choiceOptionsByFieldKey,
                      field.id !== identityField?.id,
                    );
                    const inlineEditProps =
                      updateFieldAction &&
                      recordEditHref &&
                      !record.archivedAt &&
                      field.id !== identityField?.id &&
                      INLINE_EDITABLE_FIELD_TYPES.has(field.type)
                        ? { updateFieldAction, recordEditHref }
                        : undefined;

                    return (
                    <td key={field.id} className="px-4 py-3 align-middle">
                        {field.id === identityField?.id && recordEditPathBase ? (
                          <Link
                            href={`${recordEditPathBase}/${record.id}`}
                            className="font-medium text-graphite underline-offset-4 hover:underline"
                          >
                            {cell}
                          </Link>
                        ) : inlineEditProps ? (
                          <EditableTableCell
                            field={field}
                            value={record.values[field.key]}
                            displayValue={formatFieldValue(
                              field,
                              record.values[field.key],
                              relationLabelsByFieldKey,
                              choiceOptionsByFieldKey,
                            )}
                            choiceOptions={choiceOptionsByFieldKey[field.key] ?? []}
                            relationOptions={relationOptionsByFieldKey[field.key] ?? []}
                            recordEditHref={inlineEditProps.recordEditHref}
                            updateFieldAction={inlineEditProps.updateFieldAction}
                          />
                        ) : (
                          cell
                        )}
                      </td>
                    );
                  })}
                  {recordEditPathBase ? (
                    <td className="px-4 py-3 align-middle">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          {!identityFieldIsVisible ? (
                            <Link
                              href={`${recordEditPathBase}/${record.id}`}
                              className="text-sm font-medium text-graphite underline-offset-4 hover:underline"
                            >
                              Open
                            </Link>
                          ) : null}
                          <Link
                            href={`${recordEditPathBase}/${record.id}/edit`}
                            className="text-sm font-medium text-graphite underline-offset-4 hover:underline"
                          >
                            Edit
                          </Link>
                          {record.archivedAt ? (
                            <span className="border border-grit px-2 py-1 text-xs font-medium uppercase tracking-wide text-stone">
                              Archived
                            </span>
                          ) : null}
                        {actionContext ? (
                          <details className="text-sm">
                            <summary className="cursor-pointer font-medium text-stone underline-offset-4 hover:underline">
                              More actions
                            </summary>
                            <div className="mt-3 rounded-sm border border-grit bg-white p-3">
                              <RecordRowActions
                                isArchived={Boolean(record.archivedAt)}
                                archiveRecordAction={archiveRecord.bind(
                                  null,
                                  actionContext,
                                )}
                                restoreRecordAction={restoreRecord.bind(
                                  null,
                                  actionContext,
                                )}
                                deleteRecordAction={deleteRecord.bind(
                                  null,
                                  actionContext,
                                )}
                              />
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {recordActionContext ? (
        <RecordBulkActionsBar
          totalCount={recordIds.length}
          showRestoreAction={showRestoreAction}
          bulkArchiveAction={bulkArchiveRecords.bind(null, recordActionContext)}
          bulkRestoreAction={bulkRestoreRecords.bind(null, recordActionContext)}
        />
      ) : null}
      </section>
    </RecordSelectionProvider>
  );
}
