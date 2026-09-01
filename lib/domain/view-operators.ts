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

export const SORTABLE_FIELD_TYPES = new Set<FieldDefinition["type"]>([
  "text",
  "number",
  "date",
  "boolean",
]);
