import type { EntityRecord, FieldDefinition, FieldType, FieldValue } from "./types";
import type {
  WorkflowCondition,
  WorkflowConditionOperator,
} from "./workflow-types";

const operatorsByFieldType: Record<FieldType, WorkflowConditionOperator[]> = {
  text: ["equals", "not_equals", "is_set", "is_not_set"],
  number: [
    "equals",
    "not_equals",
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
    "is_set",
    "is_not_set",
  ],
  date: ["equals", "before", "after", "is_set", "is_not_set"],
  boolean: ["equals", "is_set", "is_not_set"],
  relation: ["equals", "not_equals", "is_set", "is_not_set"],
};

const valueOperators = new Set<WorkflowConditionOperator>([
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "before",
  "after",
]);

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

export function getConditionOperatorsForFieldType(type: FieldType) {
  return operatorsByFieldType[type];
}

export function conditionOperatorNeedsValue(
  operator: WorkflowConditionOperator,
) {
  return valueOperators.has(operator);
}

export function isValueSet(value: FieldValue | undefined) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim() !== "";
  }

  return true;
}

export function parseConditionValue({
  field,
  operator,
  rawValue,
}: {
  field: FieldDefinition;
  operator: WorkflowConditionOperator;
  rawValue: string;
}): { value?: FieldValue } | { error: string } {
  if (!conditionOperatorNeedsValue(operator)) {
    return {};
  }

  if (rawValue === "") {
    return { error: `${field.name} condition needs a comparison value.` };
  }

  switch (field.type) {
    case "text":
    case "relation":
      return { value: rawValue };
    case "number": {
      const value = Number(rawValue);

      if (Number.isNaN(value)) {
        return { error: `${field.name} condition value must be a number.` };
      }

      return { value };
    }
    case "date":
      if (!isValidDate(rawValue)) {
        return { error: `${field.name} condition value must be a valid date.` };
      }

      return { value: rawValue };
    case "boolean":
      if (rawValue === "true") {
        return { value: true };
      }

      if (rawValue === "false") {
        return { value: false };
      }

      return { error: `${field.name} condition value must be Yes or No.` };
  }
}

export async function validateWorkflowConditions({
  conditions,
  sourceFields,
  validateRelationValue,
}: {
  conditions: WorkflowCondition[];
  sourceFields: FieldDefinition[];
  validateRelationValue: (
    field: FieldDefinition,
    recordId: string,
  ) => Promise<boolean>;
}) {
  const fieldById = new Map(sourceFields.map((field) => [field.id, field]));

  for (const condition of conditions) {
    const field = fieldById.get(condition.sourceFieldDefinitionId);

    if (!field) {
      return {
        success: false as const,
        error: "Workflow condition references a trigger field that no longer exists.",
      };
    }

    if (field.archivedAt) {
      return {
        success: false as const,
        error: `Workflow condition references archived field ${field.name}.`,
      };
    }

    const validOperators = getConditionOperatorsForFieldType(field.type);

    if (!validOperators.includes(condition.operator)) {
      return {
        success: false as const,
        error: `${condition.operator} is not valid for ${field.name}.`,
      };
    }

    if (!conditionOperatorNeedsValue(condition.operator)) {
      continue;
    }

    const parsedValue = parseConditionValue({
      field,
      operator: condition.operator,
      rawValue:
        condition.value === null || condition.value === undefined
          ? ""
          : String(condition.value),
    });

    if ("error" in parsedValue) {
      return {
        success: false as const,
        error: parsedValue.error,
      };
    }

    if (
      field.type === "relation" &&
      typeof parsedValue.value === "string" &&
      !(await validateRelationValue(field, parsedValue.value))
    ) {
      return {
        success: false as const,
        error: `${field.name} condition references a record that is missing or archived.`,
      };
    }
  }

  return {
    success: true as const,
  };
}

function compareValues({
  field,
  operator,
  sourceValue,
  conditionValue,
}: {
  field: FieldDefinition;
  operator: WorkflowConditionOperator;
  sourceValue: FieldValue;
  conditionValue: FieldValue;
}) {
  switch (field.type) {
    case "text":
    case "date":
    case "relation":
      if (operator === "equals") {
        return sourceValue === conditionValue;
      }

      if (operator === "not_equals") {
        return sourceValue !== conditionValue;
      }

      if (field.type === "date" && operator === "before") {
        return String(sourceValue) < String(conditionValue);
      }

      if (field.type === "date" && operator === "after") {
        return String(sourceValue) > String(conditionValue);
      }

      return false;
    case "number":
      if (typeof sourceValue !== "number" || typeof conditionValue !== "number") {
        return false;
      }

      switch (operator) {
        case "equals":
          return sourceValue === conditionValue;
        case "not_equals":
          return sourceValue !== conditionValue;
        case "greater_than":
          return sourceValue > conditionValue;
        case "greater_than_or_equal":
          return sourceValue >= conditionValue;
        case "less_than":
          return sourceValue < conditionValue;
        case "less_than_or_equal":
          return sourceValue <= conditionValue;
        default:
          return false;
      }
    case "boolean":
      return operator === "equals" && sourceValue === conditionValue;
  }
}

export function evaluateWorkflowConditions({
  conditions,
  sourceFields,
  sourceRecord,
}: {
  conditions: WorkflowCondition[];
  sourceFields: FieldDefinition[];
  sourceRecord: EntityRecord;
}) {
  const fieldById = new Map(sourceFields.map((field) => [field.id, field]));

  return conditions.every((condition) => {
    const field = fieldById.get(condition.sourceFieldDefinitionId);

    if (!field) {
      return false;
    }

    const sourceValue = sourceRecord.values[field.key];
    const sourceValueIsSet = isValueSet(sourceValue);

    if (condition.operator === "is_set") {
      return sourceValueIsSet;
    }

    if (condition.operator === "is_not_set") {
      return !sourceValueIsSet;
    }

    if (!sourceValueIsSet) {
      return false;
    }

    if (condition.value === null || condition.value === undefined) {
      return false;
    }

    return compareValues({
      field,
      operator: condition.operator,
      sourceValue,
      conditionValue: condition.value,
    });
  });
}
