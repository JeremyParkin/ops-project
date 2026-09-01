import type { EntityRecord, FieldDefinition, FieldType, FieldValue } from "./types";
import { valuesAreEqual } from "./workflow-change-detection";
import type {
  WorkflowCondition,
  WorkflowConditionOperator,
  WorkflowTriggerType,
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
  // Choice/Select automation conditions are explicitly deferred for Phase
  // 9.2 (see the field-type plan's "explicit deferrals") -- no operators
  // offered yet, so a choice field simply won't appear as usable in a
  // workflow condition's field picker.
  choice: [],
};

// Transition operators compare the previous persisted value (from the
// original user edit event) against the current one. They only make sense
// for record_updated workflows, which are the only ones with a "previous".
const transitionOperators: WorkflowConditionOperator[] = [
  "changed",
  "changed_from",
  "changed_to",
  "changed_from_to",
];
const transitionOperatorSet = new Set(transitionOperators);

export function isTransitionConditionOperator(
  operator: WorkflowConditionOperator,
) {
  return transitionOperatorSet.has(operator);
}

const valueOperators = new Set<WorkflowConditionOperator>([
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "before",
  "after",
  "changed_to",
  "changed_from_to",
]);

const previousValueOperators = new Set<WorkflowConditionOperator>([
  "changed_from",
  "changed_from_to",
]);

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

export function getConditionOperatorsForFieldType(
  type: FieldType,
  triggerType: WorkflowTriggerType,
) {
  return triggerType === "record_updated"
    ? [...operatorsByFieldType[type], ...transitionOperators]
    : operatorsByFieldType[type];
}

export function conditionOperatorNeedsValue(
  operator: WorkflowConditionOperator,
) {
  return valueOperators.has(operator);
}

export function conditionOperatorNeedsPreviousValue(
  operator: WorkflowConditionOperator,
) {
  return previousValueOperators.has(operator);
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
  needsValue,
  rawValue,
}: {
  field: FieldDefinition;
  needsValue: boolean;
  rawValue: string;
}): { value?: FieldValue } | { error: string } {
  if (!needsValue) {
    return {};
  }

  if (rawValue === "") {
    return { error: `${field.name} condition needs a comparison value.` };
  }

  switch (field.type) {
    case "text":
    case "relation":
    case "choice":
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

async function validateConditionOperand({
  field,
  rawValue,
  validateRelationValue,
}: {
  field: FieldDefinition;
  rawValue: FieldValue | undefined;
  validateRelationValue: (
    field: FieldDefinition,
    recordId: string,
  ) => Promise<boolean>;
}): Promise<{ value?: FieldValue } | { error: string }> {
  const parsedValue = parseConditionValue({
    field,
    needsValue: true,
    rawValue: rawValue === null || rawValue === undefined ? "" : String(rawValue),
  });

  if ("error" in parsedValue) {
    return parsedValue;
  }

  if (
    field.type === "relation" &&
    typeof parsedValue.value === "string" &&
    !(await validateRelationValue(field, parsedValue.value))
  ) {
    return {
      error: `${field.name} condition references a record that is missing or archived.`,
    };
  }

  return parsedValue;
}

export async function validateWorkflowConditions({
  conditions,
  sourceFields,
  triggerType,
  watchedFieldDefinitionIds,
  validateRelationValue,
}: {
  conditions: WorkflowCondition[];
  sourceFields: FieldDefinition[];
  triggerType: WorkflowTriggerType;
  watchedFieldDefinitionIds: string[];
  validateRelationValue: (
    field: FieldDefinition,
    recordId: string,
  ) => Promise<boolean>;
}) {
  const fieldById = new Map(sourceFields.map((field) => [field.id, field]));
  const watchedFieldIdSet = new Set(watchedFieldDefinitionIds);

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

    const validOperators = getConditionOperatorsForFieldType(field.type, triggerType);

    if (!validOperators.includes(condition.operator)) {
      return {
        success: false as const,
        error: `${condition.operator} is not valid for ${field.name}.`,
      };
    }

    if (
      isTransitionConditionOperator(condition.operator) &&
      !watchedFieldIdSet.has(field.id)
    ) {
      return {
        success: false as const,
        error: `${field.name} must be a watched field to use a changed condition on it.`,
      };
    }

    if (conditionOperatorNeedsValue(condition.operator)) {
      const parsedValue = await validateConditionOperand({
        field,
        rawValue: condition.value,
        validateRelationValue,
      });

      if ("error" in parsedValue) {
        return {
          success: false as const,
          error: parsedValue.error,
        };
      }
    }

    if (conditionOperatorNeedsPreviousValue(condition.operator)) {
      const parsedPreviousValue = await validateConditionOperand({
        field,
        rawValue: condition.previousValue,
        validateRelationValue,
      });

      if ("error" in parsedPreviousValue) {
        return {
          success: false as const,
          error: parsedPreviousValue.error,
        };
      }
    }

    if (
      condition.operator === "changed_from_to" &&
      valuesAreEqual(condition.previousValue, condition.value)
    ) {
      return {
        success: false as const,
        error: `${field.name} changed-from-to condition needs different From and To values.`,
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

function evaluateTransitionCondition({
  operator,
  previousValue,
  currentValue,
  conditionValue,
  conditionPreviousValue,
}: {
  operator: WorkflowConditionOperator;
  previousValue: FieldValue | undefined;
  currentValue: FieldValue | undefined;
  conditionValue: FieldValue | undefined;
  conditionPreviousValue: FieldValue | undefined;
}) {
  const hasChanged = !valuesAreEqual(previousValue, currentValue);

  switch (operator) {
    case "changed":
      return hasChanged;
    case "changed_from":
      return (
        conditionPreviousValue !== undefined &&
        conditionPreviousValue !== null &&
        valuesAreEqual(previousValue, conditionPreviousValue) &&
        hasChanged
      );
    case "changed_to":
      return (
        conditionValue !== undefined &&
        conditionValue !== null &&
        valuesAreEqual(currentValue, conditionValue) &&
        hasChanged
      );
    case "changed_from_to":
      return (
        conditionPreviousValue !== undefined &&
        conditionPreviousValue !== null &&
        conditionValue !== undefined &&
        conditionValue !== null &&
        valuesAreEqual(previousValue, conditionPreviousValue) &&
        valuesAreEqual(currentValue, conditionValue)
      );
    default:
      return false;
  }
}

export function evaluateWorkflowConditions({
  conditions,
  sourceFields,
  sourceRecord,
  previousRecord,
}: {
  conditions: WorkflowCondition[];
  sourceFields: FieldDefinition[];
  sourceRecord: EntityRecord;
  previousRecord?: EntityRecord;
}) {
  const fieldById = new Map(sourceFields.map((field) => [field.id, field]));

  return conditions.every((condition) => {
    const field = fieldById.get(condition.sourceFieldDefinitionId);

    if (!field) {
      return false;
    }

    const sourceValue = sourceRecord.values[field.key];

    if (isTransitionConditionOperator(condition.operator)) {
      if (!previousRecord) {
        return false;
      }

      return evaluateTransitionCondition({
        operator: condition.operator,
        previousValue: previousRecord.values[field.key],
        currentValue: sourceValue,
        conditionValue: condition.value,
        conditionPreviousValue: condition.previousValue,
      });
    }

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
