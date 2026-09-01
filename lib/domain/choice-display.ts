import type { ChoiceOption, ChoiceOptionsByFieldId, FieldDefinition, FieldValue } from "./types";

export type ChoiceOptionsByFieldKey = Record<FieldDefinition["key"], ChoiceOption[]>;

// Re-keys a by-field-id options lookup (what the repository layer returns)
// to by-field-key, the shape record-display/edit UI components already use
// for relation lookups (RelationLabelsByFieldKey/RelationOptionsByFieldKey)
// -- record.values itself is keyed by field.key, not field.id.
export function toChoiceOptionsByFieldKey(
  fields: FieldDefinition[],
  choiceOptionsByFieldId: ChoiceOptionsByFieldId,
): ChoiceOptionsByFieldKey {
  const byFieldKey: ChoiceOptionsByFieldKey = {};

  for (const field of fields) {
    if (field.type === "choice") {
      byFieldKey[field.key] = choiceOptionsByFieldId[field.id] ?? [];
    }
  }

  return byFieldKey;
}

// Resolves a stored choice value (the option's id, or null/unset) against
// the field's full option list (active and archived both need to be
// searchable here -- a record may reference an archived option). Returns
// undefined for unset values and for a stale/foreign id that doesn't match
// any option on this field, so callers can render "Unknown option" rather
// than crash.
export function resolveChoiceOption(
  options: ChoiceOption[],
  value: FieldValue | undefined,
): ChoiceOption | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }

  return options.find((option) => option.id === value);
}

export function sortChoiceOptionsByPosition(options: ChoiceOption[]): ChoiceOption[] {
  return [...options].sort((left, right) => left.position - right.position);
}

export function activeChoiceOptions(options: ChoiceOption[]): ChoiceOption[] {
  return sortChoiceOptionsByPosition(options).filter((option) => !option.archivedAt);
}
