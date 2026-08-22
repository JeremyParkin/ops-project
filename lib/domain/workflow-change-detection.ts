import type { EntityRecord, FieldDefinition, FieldValue } from "./types";

function canonicalValue(value: FieldValue | undefined) {
  return value === null || value === undefined ? undefined : value;
}

// Null and undefined both mean "unset" and compare equal; every other value
// (including 0, false, and "") is a real, distinct value.
export function valuesAreEqual(
  left: FieldValue | undefined,
  right: FieldValue | undefined,
) {
  return canonicalValue(left) === canonicalValue(right);
}

export function getChangedFieldDefinitionIds({
  fields,
  previousRecord,
  nextRecord,
}: {
  fields: FieldDefinition[];
  previousRecord: EntityRecord;
  nextRecord: EntityRecord;
}) {
  return fields
    .filter(
      (field) =>
        !valuesAreEqual(
          previousRecord.values[field.key],
          nextRecord.values[field.key],
        ),
    )
    .map((field) => field.id);
}

export function watchedFieldsChanged({
  watchedFieldDefinitionIds,
  changedFieldDefinitionIds,
}: {
  watchedFieldDefinitionIds: string[];
  changedFieldDefinitionIds: string[];
}) {
  const changedFieldIds = new Set(changedFieldDefinitionIds);

  return watchedFieldDefinitionIds.some((fieldId) => changedFieldIds.has(fieldId));
}
