import type { FieldDefinition } from "./types";
import type { ViewFilterOperator } from "./view-types";

// Single source of truth for which filter operators apply to each field
// type, and which field types can be sorted. view-engine.ts (evaluation),
// view-validation.ts (server-side form validation), and the view/quick-bar
// UI components all read from here so the three never drift apart.
export const FILTER_OPERATORS_BY_FIELD_TYPE: Record<
  FieldDefinition["type"],
  ViewFilterOperator[]
> = {
  text: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "is_set",
    "is_not_set",
  ],
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
  // V1: is / is not / is empty / is not empty only -- reusing the same
  // equals/not_equals/is_set/is_not_set operators every other type already
  // has (just with Choice-appropriate wording, see
  // CHOICE_FILTER_OPERATOR_LABELS below), not new operator values. "is any
  // of"/"is none of" were deliberately deferred: they'd need widening
  // ViewFilter.value from a scalar to an array, which touches the filter
  // engine, validation, and both view UIs -- real surgery on infrastructure
  // that just shipped, for marginal V1 value over single-value equality.
  choice: ["equals", "not_equals", "is_set", "is_not_set"],
};

export const FILTER_OPERATOR_LABELS: Record<ViewFilterOperator, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  greater_than: "greater than",
  greater_than_or_equal: "greater than or equal",
  less_than: "less than",
  less_than_or_equal: "less than or equal",
  before: "before",
  after: "after",
  is_set: "is set",
  is_not_set: "is not set",
};

// Choice-specific wording for the same four operators ("is" reads better
// than "equals" for a single-select value). Only overrides the operators
// Choice actually offers; every other field type keeps FILTER_OPERATOR_LABELS.
export const CHOICE_FILTER_OPERATOR_LABELS: Partial<Record<ViewFilterOperator, string>> = {
  equals: "is",
  not_equals: "is not",
  is_set: "is not empty",
  is_not_set: "is empty",
};

export function filterOperatorLabel(
  fieldType: FieldDefinition["type"],
  operator: ViewFilterOperator,
): string {
  if (fieldType === "choice") {
    return CHOICE_FILTER_OPERATOR_LABELS[operator] ?? FILTER_OPERATOR_LABELS[operator];
  }

  return FILTER_OPERATOR_LABELS[operator];
}

// Choice is sortable, but not by comparing raw option-id strings
// lexicographically -- see compareChoiceOptionPositions in view-engine.ts,
// which every sort call site uses instead of the generic scalar comparator
// whenever field.type === "choice".
export const SORTABLE_FIELD_TYPES = new Set<FieldDefinition["type"]>([
  "text",
  "number",
  "date",
  "boolean",
  "choice",
]);
