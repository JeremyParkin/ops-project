import type { EntityType, FieldDefinition } from "./types";

const fieldTypeLabels = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Boolean",
  relation: "Relation",
  choice: "Choice",
};

export function getWorkflowFieldLabel({
  entityType,
  field,
  entityNameById = {},
}: {
  entityType: EntityType;
  field: FieldDefinition;
  entityNameById?: Record<string, string>;
}) {
  const typeLabel =
    field.type === "relation" && field.relatedEntityTypeId
      ? `Relation to ${entityNameById[field.relatedEntityTypeId] ?? "entity"}`
      : fieldTypeLabels[field.type];
  const archivedLabel = field.archivedAt ? ", archived" : "";

  return `${entityType.name} → ${field.name} (${typeLabel}, field ${field.position}${archivedLabel})`;
}
