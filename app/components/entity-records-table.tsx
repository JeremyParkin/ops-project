import Link from "next/link";
import {
  archiveRecord,
  deleteRecord,
  restoreRecord,
} from "@/app/actions";
import { RecordRowActions } from "@/app/components/record-row-actions";
import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
  FieldValue,
} from "@/lib/domain/types";
import type { RelationLabelsByFieldKey } from "@/lib/domain/record-repository";

type EntityRecordsTableProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  records: EntityRecord[];
  relationLabelsByFieldKey?: RelationLabelsByFieldKey;
  recordEditPathBase?: string;
  recordActionContext?: {
    workspaceId: string;
    entityTypeId: string;
  };
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
    <span className="inline-flex items-center border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-900">
      {formattedValue}
    </span>
  );
}

export function EntityRecordsTable({
  entityType,
  fields,
  records,
  relationLabelsByFieldKey = {},
  recordEditPathBase,
  recordActionContext,
}: EntityRecordsTableProps) {
  const orderedFields = [...fields].sort((left, right) => {
    return left.position - right.position;
  });

  return (
    <section className="mx-auto w-full max-w-6xl">
      <div className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Entity Type
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-950">
          {entityType.name}
        </h1>
      </div>

      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                {orderedFields.map((field) => (
                  <th
                    key={field.id}
                    scope="col"
                    className="border-b border-slate-200 px-4 py-3 font-medium"
                  >
                    {field.name}
                  </th>
                ))}
                {recordEditPathBase ? (
                  <th
                    scope="col"
                    className="border-b border-slate-200 px-4 py-3 font-medium"
                  >
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-800">
              {records.map((record) => {
                const actionContext = recordActionContext
                  ? {
                      ...recordActionContext,
                      recordId: record.id,
                    }
                  : undefined;

                return (
                <tr
                  key={record.id}
                  className={record.archivedAt ? "bg-slate-50 text-slate-500" : ""}
                >
                  {orderedFields.map((field) => (
                    <td key={field.id} className="px-4 py-3">
                      {formatTableCell(
                        field,
                        record.values[field.key],
                        relationLabelsByFieldKey,
                      )}
                    </td>
                  ))}
                  {recordEditPathBase ? (
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-3">
                          <Link
                            href={`${recordEditPathBase}/${record.id}/edit`}
                            className="text-sm font-medium text-slate-950 underline-offset-4 hover:underline"
                          >
                            Edit
                          </Link>
                          {record.archivedAt ? (
                            <span className="border border-slate-300 px-2 py-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                              Archived
                            </span>
                          ) : null}
                        </div>
                        {actionContext ? (
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
