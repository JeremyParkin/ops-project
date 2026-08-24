import type { FieldDefinition, FieldType } from "./types";
import type { ProcessBranchConditionOperator } from "./process-types";

const operatorsByFieldType: Record<FieldType, ProcessBranchConditionOperator[]> = {
  text: ["equals", "not_equals", "contains", "not_contains", "is_set", "is_not_set"],
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

const operatorsNeedingValue = new Set<ProcessBranchConditionOperator>([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "before",
  "after",
]);

export const processConditionOperatorLabels: Record<ProcessBranchConditionOperator, string> = {
  equals: "Equals",
  not_equals: "Does Not Equal",
  contains: "Contains",
  not_contains: "Does Not Contain",
  greater_than: "Greater Than",
  greater_than_or_equal: "Greater Than Or Equal",
  less_than: "Less Than",
  less_than_or_equal: "Less Than Or Equal",
  before: "Before",
  after: "After",
  is_set: "Is Set",
  is_not_set: "Is Not Set",
};

export function getProcessConditionOperatorsForFieldType(type: FieldType) {
  return operatorsByFieldType[type];
}

export function processConditionOperatorNeedsValue(operator: ProcessBranchConditionOperator) {
  return operatorsNeedingValue.has(operator);
}

export function getProcessConditionDefaultOperator(field: FieldDefinition) {
  return operatorsByFieldType[field.type][0];
}
