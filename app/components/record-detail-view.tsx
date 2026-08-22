import Link from "next/link";
import { RecordDetailActions } from "@/app/components/record-detail-actions";
import type {
  IncomingRelationGroup,
  RelationLabelsByFieldKey,
} from "@/lib/domain/record-repository";
import { getRecordLabel } from "@/lib/domain/record-repository";
import type { EntityRecord, EntityType, FieldDefinition } from "@/lib/domain/types";

type RecordDetailViewProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  record: EntityRecord;
  relationLabelsByFieldKey: RelationLabelsByFieldKey;
  incomingRelationGroups: IncomingRelationGroup[];
  editHref?: string;
  archiveRecordAction: Parameters<typeof RecordDetailActions>[0]["archiveRecordAction"];
  restoreRecordAction: Parameters<typeof RecordDetailActions>[0]["restoreRecordAction"];
  deleteRecordAction: Parameters<typeof RecordDetailActions>[0]["deleteRecordAction"];
};

function formatPrimitiveValue(field: FieldDefinition, value: EntityRecord["values"][string]) {
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
      return "—";
  }
}

function formatEntityGroupName(name: string) {
  return name.endsWith("s") ? name : `${name}s`;
}

export function RecordDetailView({
  entityType,
  fields,
  record,
  relationLabelsByFieldKey,
  incomingRelationGroups,
  editHref,
  archiveRecordAction,
  restoreRecordAction,
  deleteRecordAction,
}: RecordDetailViewProps) {
  const orderedFields = [...fields].sort((left, right) => left.position - right.position);
  const recordLabel = getRecordLabel({ entityType, fields, record });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-4 border border-slate-200 bg-white p-5">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
              {entityType.name}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold text-slate-950">
                {recordLabel}
              </h1>
              {record.archivedAt ? (
                <span className="border border-slate-300 px-2 py-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Archived
                </span>
              ) : null}
            </div>
          </div>
          <RecordDetailActions
            editHref={editHref}
            isArchived={Boolean(record.archivedAt)}
            archiveRecordAction={archiveRecordAction}
            restoreRecordAction={restoreRecordAction}
            deleteRecordAction={deleteRecordAction}
          />
        </div>
      </div>

      <section className="border border-slate-200 bg-white p-5">
        <h2 className="text-xl font-semibold text-slate-950">Details</h2>
        <dl className="mt-5 divide-y divide-slate-100">
          {orderedFields.map((field) => {
            const value = record.values[field.key];
            const relationLabel =
              field.type === "relation" && typeof value === "string"
                ? relationLabelsByFieldKey[field.key]?.[value] ?? `${value.slice(0, 8)}...`
                : undefined;

            return (
              <div
                key={field.id}
                className="grid gap-2 py-3 md:grid-cols-[minmax(12rem,18rem)_1fr]"
              >
                <dt className="text-sm font-medium text-slate-600">{field.name}</dt>
                <dd className="text-sm text-slate-950">
                  {field.type === "relation" ? (
                    relationLabel && typeof value === "string" && field.relatedEntityTypeId ? (
                      <Link
                        href={`/entities/${field.relatedEntityTypeId}/records/${value}`}
                        className="inline-flex items-center border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-900 underline-offset-4 hover:underline"
                      >
                        {relationLabel}
                      </Link>
                    ) : (
                      "—"
                    )
                  ) : (
                    formatPrimitiveValue(field, value)
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      {incomingRelationGroups.length > 0 ? (
        <section className="border border-slate-200 bg-white p-5">
          <h2 className="text-xl font-semibold text-slate-950">
            Related Records
          </h2>
          <div className="mt-5 grid gap-6">
            {incomingRelationGroups.map((group) => (
              <div key={`${group.sourceEntityType.id}:${group.relationField.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-950">
                    {formatEntityGroupName(group.sourceEntityType.name)} via{" "}
                    {group.relationField.name}
                  </h3>
                  {!record.archivedAt ? (
                    <Link
                      href={`/entities/${group.sourceEntityType.id}?prefillRelationFieldId=${group.relationField.id}&originEntityTypeId=${entityType.id}&originRecordId=${record.id}#add-record`}
                      className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
                    >
                      Add {group.sourceEntityType.name}
                    </Link>
                  ) : null}
                </div>
                {group.records.length > 0 ? (
                  <ul className="mt-2 divide-y divide-slate-100 border-y border-slate-100">
                    {group.records.map((incomingRecord) => (
                      <li key={incomingRecord.id} className="py-2">
                        <Link
                          href={`/entities/${group.sourceEntityType.id}/records/${incomingRecord.id}`}
                          className="text-sm font-medium text-slate-950 underline-offset-4 hover:underline"
                        >
                          {getRecordLabel({
                            entityType: group.sourceEntityType,
                            fields: group.sourceFields,
                            record: incomingRecord,
                          })}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">No related records yet.</p>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
