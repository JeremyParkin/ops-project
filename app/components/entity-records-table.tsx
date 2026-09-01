import Link from "next/link";
import {
  archiveRecord,
  deleteRecord,
  restoreRecord,
  updateRecordField,
} from "@/app/actions";
import { EditableTableCell } from "@/app/components/editable-table-cell";
import { RecordRowActions } from "@/app/components/record-row-actions";
import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
  FieldValue,
} from "@/lib/domain/types";
import type { RelationLabelsByFieldKey } from "@/lib/domain/record-repository";
import { getRecordIdentityField } from "@/lib/domain/record-repository";

type EntityRecordsTableProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  identityFields?: FieldDefinition[];
  records: EntityRecord[];
  relationLabelsByFieldKey?: RelationLabelsByFieldKey;
  recordEditPathBase?: string;
  recordActionContext?: {
    workspaceId: string;
    entityTypeId: string;
  };
  emptyState?: {
    title: string;
    description: string;
  };
  // Click-to-sort column headers: only sortable, currently-visible fields
  // appear as keys. `sortHrefByFieldId` is the href a header click should
  // navigate to next (cycling none -> asc -> desc -> none);
  // `sortDirectionByFieldId` holds the field's *current* direction, for the
  // arrow indicator, and is only set for fields presently part of the sort.
  sortHrefByFieldId?: Record<string, string>;
  sortDirectionByFieldId?: Record<string, "asc" | "desc">;
};

function formatFieldValue(
  field: FieldDefinition,
  value: FieldValue | undefined,
  relationLabelsByFieldKey: RelationLabelsByFieldKey,
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
  }
}

const INLINE_EDITABLE_FIELD_TYPES = new Set<FieldDefinition["type"]>([
  "text",
  "number",
  "date",
  "boolean",
]);

function formatTableCell(
  field: FieldDefinition,
  value: FieldValue | undefined,
  relationLabelsByFieldKey: RelationLabelsByFieldKey,
) {
  const formattedValue = formatFieldValue(
    field,
    value,
    relationLabelsByFieldKey,
  );

  if (field.type !== "relation" || formattedValue === "—") {
    return formattedValue;
  }

  return (
    <span className="inline-flex items-center border border-grit bg-chalk px-2 py-1 text-xs font-medium text-stone">
      {formattedValue}
    </span>
  );
}

export function EntityRecordsTable({
  entityType,
  fields,
  identityFields = fields,
  records,
  relationLabelsByFieldKey = {},
  recordEditPathBase,
  recordActionContext,
  emptyState,
  sortHrefByFieldId = {},
  sortDirectionByFieldId = {},
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
          <Link
            href="#add-record"
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
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

  return (
    <section className="mx-auto w-full max-w-6xl">
      <div className="overflow-hidden border border-grit bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-chalk text-xs uppercase tracking-wide text-stone">
              <tr>
                {fields.map((field) => {
                  const sortHref = sortHrefByFieldId[field.id];
                  const sortDirection = sortDirectionByFieldId[field.id];

                  return (
                    <th
                      key={field.id}
                      scope="col"
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

                return (
                <tr
                  key={record.id}
                  className={record.archivedAt ? "bg-chalk text-stone" : ""}
                >
                  {fields.map((field) => {
                    const cell = formatTableCell(
                      field,
                      record.values[field.key],
                      relationLabelsByFieldKey,
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
                            )}
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
    </section>
  );
}
