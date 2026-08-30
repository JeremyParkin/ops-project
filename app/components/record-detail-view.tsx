import Link from "next/link";
import type { RecordFieldFormState } from "@/app/actions";
import { EditableTableCell } from "@/app/components/editable-table-cell";
import { RecordDetailActions } from "@/app/components/record-detail-actions";
import { PageHeader, SectionHeader } from "@/app/components/page-primitives";
import { ProcessSection, type ProcessSectionEntry } from "@/app/components/process-section";
import { RecordActivity } from "@/app/components/record-activity";
import type { RecordActivityEvent } from "@/lib/domain/activity-types";
import type {
  IncomingRelationGroup,
  RelationLabelsByFieldKey,
} from "@/lib/domain/record-repository";
import { getRecordIdentityField, getRecordLabel } from "@/lib/domain/record-repository";
import type { EntityRecord, EntityType, FieldDefinition, FieldValue } from "@/lib/domain/types";

// The collapsed Overview prioritizes populated fields over blank schema
// slots; "All fields" reveals the complete canonical-order list below it.
// Primitive and forward-relation fields share this one ordering -- a set
// relation is never ranked ahead of a populated primitive (or vice versa)
// purely because of its type; canonical FieldDefinition.position decides.
const OVERVIEW_FIELD_CAP = 6;
// Reverse-relation groups can hold arbitrarily many records; the preview
// shows the first few with the rest behind an expand.
const RELATED_PREVIEW_CAP = 5;

type UpdateFieldAction = (
  state: RecordFieldFormState,
  formData: FormData,
) => Promise<RecordFieldFormState>;

type RecordDetailViewProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  record: EntityRecord;
  relationLabelsByFieldKey: RelationLabelsByFieldKey;
  incomingRelationGroups: IncomingRelationGroup[];
  processSectionEntries: ProcessSectionEntry[];
  activityEvents: RecordActivityEvent[];
  editHref?: string;
  updateFieldAction?: UpdateFieldAction;
  archiveRecordAction: Parameters<typeof RecordDetailActions>[0]["archiveRecordAction"];
  restoreRecordAction: Parameters<typeof RecordDetailActions>[0]["restoreRecordAction"];
  deleteRecordAction: Parameters<typeof RecordDetailActions>[0]["deleteRecordAction"];
};

function formatPrimitiveValue(field: FieldDefinition, value: FieldValue) {
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

function hasFieldValue(value: FieldValue) {
  return value !== null && value !== undefined && value !== "";
}

function formatEntityGroupName(name: string) {
  return name.endsWith("s") ? name : `${name}s`;
}

function formatUpdatedAt(updatedAt: string) {
  const updatedDate = new Date(updatedAt);
  const diffMinutes = Math.round((Date.now() - updatedDate.getTime()) / 60_000);

  if (diffMinutes < 1) return "Updated just now";
  if (diffMinutes < 60) return `Updated ${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `Updated ${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `Updated ${diffDays} day${diffDays === 1 ? "" : "s"} ago`;

  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(updatedDate)}`;
}

function FieldRow({
  field,
  value,
  relationLabel,
  updateFieldAction,
  editHref,
}: {
  field: FieldDefinition;
  value: FieldValue;
  relationLabel?: string;
  updateFieldAction?: UpdateFieldAction;
  editHref?: string;
}) {
  return (
    <div className="grid gap-2 py-3 md:grid-cols-[minmax(12rem,18rem)_1fr]">
      <dt className="text-sm font-medium text-stone">{field.name}</dt>
      <dd className="text-sm text-graphite">
        {field.type === "relation" ? (
          relationLabel && typeof value === "string" && field.relatedEntityTypeId ? (
            <Link
              href={`/entities/${field.relatedEntityTypeId}/records/${value}`}
              className="inline-flex items-center border border-grit bg-chalk px-2 py-1 text-xs font-medium text-stone underline-offset-4 hover:underline"
            >
              {relationLabel}
            </Link>
          ) : (
            "—"
          )
        ) : updateFieldAction && editHref ? (
          <EditableTableCell
            field={field}
            value={value}
            displayValue={formatPrimitiveValue(field, value)}
            recordEditHref={editHref}
            updateFieldAction={updateFieldAction}
          />
        ) : (
          formatPrimitiveValue(field, value)
        )}
      </dd>
    </div>
  );
}

export function RecordDetailView({
  entityType,
  fields,
  record,
  relationLabelsByFieldKey,
  incomingRelationGroups,
  processSectionEntries,
  activityEvents,
  editHref,
  updateFieldAction,
  archiveRecordAction,
  restoreRecordAction,
  deleteRecordAction,
}: RecordDetailViewProps) {
  const orderedFields = [...fields].sort((left, right) => left.position - right.position);
  const recordLabel = getRecordLabel({ entityType, fields, record });
  const identityField = getRecordIdentityField({ entityType, fields });

  // Overview holds every non-identity field -- primitive or forward
  // relation -- in one canonically-ordered pool. Relation display/edit
  // behavior (read-only chip/link vs. inline-editable) is decided per row
  // by field.type, not by which section the field lives in.
  const overviewCandidateFields = orderedFields.filter(
    (field) => field.id !== identityField?.id,
  );

  const populatedOverviewFields = overviewCandidateFields.filter((field) =>
    hasFieldValue(record.values[field.key]),
  );
  const emptyOverviewFields = overviewCandidateFields.filter(
    (field) => !hasFieldValue(record.values[field.key]),
  );
  const overviewFields = [...populatedOverviewFields, ...emptyOverviewFields].slice(
    0,
    OVERVIEW_FIELD_CAP,
  );
  const hasMoreFields = overviewCandidateFields.length > overviewFields.length;

  function relationLabelFor(field: FieldDefinition) {
    const value = record.values[field.key];

    return typeof value === "string" ? relationLabelsByFieldKey[field.key]?.[value] : undefined;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow={entityType.name}
        title={recordLabel}
        description={formatUpdatedAt(record.updatedAt)}
        actions={<>
          {record.archivedAt ? (
            <span className="border border-grit px-2 py-1 text-xs font-medium uppercase tracking-wide text-stone">
              Archived
            </span>
          ) : null}
          <RecordDetailActions
            editHref={editHref}
            isArchived={Boolean(record.archivedAt)}
            archiveRecordAction={archiveRecordAction}
            restoreRecordAction={restoreRecordAction}
            deleteRecordAction={deleteRecordAction}
          />
        </>}
      />

      <section className="border border-grit bg-white p-5">
        <SectionHeader title="Overview" />
        {overviewCandidateFields.length === 0 ? (
          <p className="mt-5 text-sm text-stone">This object has no additional fields.</p>
        ) : (
          <>
            <dl className="mt-5 divide-y divide-chalk">
              {overviewFields.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  value={record.values[field.key]}
                  relationLabel={field.type === "relation" ? relationLabelFor(field) : undefined}
                  updateFieldAction={updateFieldAction}
                  editHref={editHref}
                />
              ))}
            </dl>
            {hasMoreFields ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium text-stone underline-offset-4 hover:underline">
                  All fields
                </summary>
                <dl className="mt-3 divide-y divide-chalk border-t border-chalk">
                  {overviewCandidateFields.map((field) => (
                    <FieldRow
                      key={field.id}
                      field={field}
                      value={record.values[field.key]}
                      relationLabel={field.type === "relation" ? relationLabelFor(field) : undefined}
                      updateFieldAction={updateFieldAction}
                      editHref={editHref}
                    />
                  ))}
                </dl>
              </details>
            ) : null}
          </>
        )}
      </section>

      {incomingRelationGroups.length > 0 ? (
        <section className="border border-grit bg-white p-5">
          <SectionHeader title="Related" />
          <div className="mt-5 grid gap-4">
            {incomingRelationGroups.map((group) => {
              const previewRecords = group.records.slice(0, RELATED_PREVIEW_CAP);
              const remainingRecords = group.records.slice(RELATED_PREVIEW_CAP);

              return (
                <div
                  key={`${group.sourceEntityType.id}:${group.relationField.id}`}
                  className="border border-grit p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-graphite">
                      {formatEntityGroupName(group.sourceEntityType.name)} via{" "}
                      {group.relationField.name}
                    </h3>
                    {!record.archivedAt ? (
                      <Link
                        href={`/entities/${group.sourceEntityType.id}?prefillRelationFieldId=${group.relationField.id}&originEntityTypeId=${entityType.id}&originRecordId=${record.id}#add-record`}
                        className="text-sm font-medium text-stone underline-offset-4 hover:underline"
                      >
                        Add {group.sourceEntityType.name}
                      </Link>
                    ) : null}
                  </div>
                  {group.records.length > 0 ? (
                    <>
                      <ul className="mt-2 divide-y divide-chalk border-y border-chalk">
                        {previewRecords.map((incomingRecord) => (
                          <li key={incomingRecord.id} className="py-2">
                            <Link
                              href={`/entities/${group.sourceEntityType.id}/records/${incomingRecord.id}`}
                              className="text-sm font-medium text-graphite underline-offset-4 hover:underline"
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
                      {remainingRecords.length > 0 ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-sm font-medium text-stone underline-offset-4 hover:underline">
                            {remainingRecords.length} more
                          </summary>
                          <ul className="mt-2 divide-y divide-chalk border-y border-chalk">
                            {remainingRecords.map((incomingRecord) => (
                              <li key={incomingRecord.id} className="py-2">
                                <Link
                                  href={`/entities/${group.sourceEntityType.id}/records/${incomingRecord.id}`}
                                  className="text-sm font-medium text-graphite underline-offset-4 hover:underline"
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
                        </details>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-stone">No related records yet.</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <ProcessSection entries={processSectionEntries} />

      <RecordActivity events={activityEvents} />
    </div>
  );
}
