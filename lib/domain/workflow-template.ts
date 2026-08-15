import type { EntityRecord, EntityType, FieldDefinition, FieldValue } from "./types";
import { getWorkflowFieldLabel } from "./workflow-field-labels";

export type TemplatePart =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "field";
      sourceFieldDefinitionId: string;
    };

const canonicalTokenPattern = /\{\{field:([^{}]+)\}\}/g;
const friendlyTokenPattern = /\{([^{}]+)\}/g;

export function getFriendlyFieldToken(
  entityType: EntityType,
  field: FieldDefinition,
  entityNameById: Record<string, string> = {},
) {
  return `{${getWorkflowFieldLabel({ entityType, field, entityNameById })}}`;
}

export function parseCanonicalTemplate(template: string):
  | {
      success: true;
      parts: TemplatePart[];
    }
  | {
      success: false;
      error: string;
    } {
  const parts: TemplatePart[] = [];
  let lastIndex = 0;

  for (const match of template.matchAll(canonicalTokenPattern)) {
    const [token, sourceFieldDefinitionId] = match;
    const index = match.index ?? 0;

    if (index > lastIndex) {
      const textValue = template.slice(lastIndex, index);

      if (textValue.includes("{") || textValue.includes("}")) {
        return {
          success: false,
          error: "Template contains malformed field placeholder syntax.",
        };
      }

      parts.push({
        type: "text",
        value: textValue,
      });
    }

    if (!sourceFieldDefinitionId.trim()) {
      return {
        success: false,
        error: "Template contains an empty field placeholder.",
      };
    }

    parts.push({
      type: "field",
      sourceFieldDefinitionId: sourceFieldDefinitionId.trim(),
    });
    lastIndex = index + token.length;
  }

  if (lastIndex < template.length) {
    const textValue = template.slice(lastIndex);

    if (textValue.includes("{") || textValue.includes("}")) {
      return {
        success: false,
        error: "Template contains malformed field placeholder syntax.",
      };
    }

    parts.push({
      type: "text",
      value: textValue,
    });
  }

  const reconstructed = parts
    .map((part) =>
      part.type === "text"
        ? part.value
        : `{{field:${part.sourceFieldDefinitionId}}}`,
    )
    .join("");

  if (reconstructed !== template) {
    return {
      success: false,
      error: "Template contains malformed field placeholder syntax.",
    };
  }

  return {
    success: true,
    parts,
  };
}

export function canonicalTemplateToFriendly({
  template,
  sourceEntityType,
  sourceFields,
  entityNameById = {},
}: {
  template: string;
  sourceEntityType: EntityType;
  sourceFields: FieldDefinition[];
  entityNameById?: Record<string, string>;
}) {
  const fieldById = new Map(sourceFields.map((field) => [field.id, field]));
  const parsed = parseCanonicalTemplate(template);

  if (!parsed.success) {
    return template;
  }

  return parsed.parts
    .map((part) => {
      if (part.type === "text") {
        return part.value;
      }

      const field = fieldById.get(part.sourceFieldDefinitionId);

      return field
        ? getFriendlyFieldToken(sourceEntityType, field, entityNameById)
        : "{Unknown Field}";
    })
    .join("");
}

export function friendlyTemplateToCanonical({
  template,
  sourceEntityType,
  sourceFields,
  entityNameById = {},
}: {
  template: string;
  sourceEntityType: EntityType;
  sourceFields: FieldDefinition[];
  entityNameById?: Record<string, string>;
}):
  | {
      success: true;
      canonicalTemplate: string;
      referencedSourceFieldIds: string[];
    }
  | {
      success: false;
      error: string;
    } {
  const labels = new Map<string, FieldDefinition[]>();

  sourceFields.forEach((field) => {
    const label = getWorkflowFieldLabel({
      entityType: sourceEntityType,
      field,
      entityNameById,
    });
    labels.set(label, [...(labels.get(label) ?? []), field]);
  });

  const referencedSourceFieldIds: string[] = [];
  let canonicalTemplate = "";
  let lastIndex = 0;

  for (const match of template.matchAll(friendlyTokenPattern)) {
    const [token, label] = match;
    const index = match.index ?? 0;
    const matchingFields = labels.get(label.trim()) ?? [];
    const textValue = template.slice(lastIndex, index);

    if (textValue.includes("{") || textValue.includes("}")) {
      return {
        success: false,
        error:
          "Template contains malformed placeholder syntax. Insert fields using the available source-field buttons.",
      };
    }

    canonicalTemplate += textValue;

    if (matchingFields.length === 0) {
      return {
        success: false,
        error: `Template references unknown field placeholder ${token}.`,
      };
    }

    if (matchingFields.length > 1) {
      return {
        success: false,
        error: `Template placeholder ${token} is ambiguous because multiple source fields share that label.`,
      };
    }

    const fieldId = matchingFields[0].id;
    referencedSourceFieldIds.push(fieldId);
    canonicalTemplate += `{{field:${fieldId}}}`;
    lastIndex = index + token.length;
  }

  const trailingText = template.slice(lastIndex);

  if (trailingText.includes("{") || trailingText.includes("}")) {
    return {
      success: false,
      error:
        "Template contains malformed placeholder syntax. Insert fields using the available source-field buttons.",
    };
  }

  canonicalTemplate += trailingText;

  return {
    success: true,
    canonicalTemplate,
    referencedSourceFieldIds,
  };
}

function formatTemplateValue({
  field,
  value,
  resolveRelationLabel,
}: {
  field: FieldDefinition;
  value: FieldValue | undefined;
  resolveRelationLabel: (
    field: FieldDefinition,
    recordId: string,
  ) => string | Promise<string>;
}) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  switch (field.type) {
    case "text":
      return String(value);
    case "number":
      return String(value);
    case "date":
      return String(value);
    case "boolean":
      return value === true ? "Yes" : "No";
    case "relation":
      return typeof value === "string" ? resolveRelationLabel(field, value) : "";
  }
}

export async function renderWorkflowTemplate({
  template,
  sourceFields,
  sourceRecord,
  resolveRelationLabel,
}: {
  template: string;
  sourceFields: FieldDefinition[];
  sourceRecord: EntityRecord;
  resolveRelationLabel: (
    field: FieldDefinition,
    recordId: string,
  ) => string | Promise<string>;
}) {
  const parsed = parseCanonicalTemplate(template);

  if (!parsed.success) {
    throw new Error(parsed.error);
  }

  const fieldById = new Map(sourceFields.map((field) => [field.id, field]));

  const renderedParts = await Promise.all(
    parsed.parts.map(async (part) => {
      if (part.type === "text") {
        return part.value;
      }

      const field = fieldById.get(part.sourceFieldDefinitionId);

      if (!field) {
        throw new Error("Workflow template references a source field that no longer exists.");
      }

      return formatTemplateValue({
        field,
        value: sourceRecord.values[field.key],
        resolveRelationLabel,
      });
    }),
  );

  return renderedParts.join("");
}
