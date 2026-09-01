import type { EntityRecord, FieldDefinition, FieldValue } from "./types";
import {
  FILTER_OPERATORS_BY_FIELD_TYPE,
  SORTABLE_FIELD_TYPES,
} from "./view-operators";
import type {
  EntityView,
  EvaluatedView,
  ViewFilter,
  ViewFilterOperator,
  ViewSort,
} from "./view-types";
import type { RelationLabelsByFieldKey } from "./record-repository";

const filterOperatorsByFieldType = FILTER_OPERATORS_BY_FIELD_TYPE;
const sortFieldTypes = SORTABLE_FIELD_TYPES;

export function viewFilterNeedsValue(operator: ViewFilterOperator) {
  return operator !== "is_set" && operator !== "is_not_set";
}

export function isViewValueSet(value: FieldValue | undefined) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim() !== "";
  }

  return true;
}

function compareScalarValues(
  left: FieldValue | undefined,
  right: FieldValue | undefined,
) {
  const leftSet = isViewValueSet(left);
  const rightSet = isViewValueSet(right);

  if (!leftSet && !rightSet) {
    return 0;
  }

  if (!leftSet) {
    return 1;
  }

  if (!rightSet) {
    return -1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }

  return String(left).localeCompare(String(right), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function filterMatchesValue({
  field,
  filter,
  value,
}: {
  field: FieldDefinition;
  filter: ViewFilter;
  value: FieldValue | undefined;
}) {
  if (filter.operator === "is_set") {
    return isViewValueSet(value);
  }

  if (filter.operator === "is_not_set") {
    return !isViewValueSet(value);
  }

  if (!isViewValueSet(value)) {
    return false;
  }

  switch (field.type) {
    case "text": {
      const actual = String(value).toLocaleLowerCase();
      const expected = String(filter.value ?? "").toLocaleLowerCase();

      switch (filter.operator) {
        case "equals":
          return actual === expected;
        case "not_equals":
          return actual !== expected;
        case "contains":
          return actual.includes(expected);
        case "not_contains":
          return !actual.includes(expected);
        default:
          return false;
      }
    }
    case "number":
      if (typeof value !== "number" || typeof filter.value !== "number") {
        return false;
      }

      switch (filter.operator) {
        case "equals":
          return value === filter.value;
        case "not_equals":
          return value !== filter.value;
        case "greater_than":
          return value > filter.value;
        case "greater_than_or_equal":
          return value >= filter.value;
        case "less_than":
          return value < filter.value;
        case "less_than_or_equal":
          return value <= filter.value;
        default:
          return false;
      }
    case "date":
      if (typeof value !== "string" || typeof filter.value !== "string") {
        return false;
      }

      switch (filter.operator) {
        case "equals":
          return value === filter.value;
        case "before":
          return value < filter.value;
        case "after":
          return value > filter.value;
        default:
          return false;
      }
    case "boolean":
      return filter.operator === "equals" && value === filter.value;
    case "relation":
      if (typeof value !== "string" || typeof filter.value !== "string") {
        return false;
      }

      return filter.operator === "equals"
        ? value === filter.value
        : filter.operator === "not_equals"
          ? value !== filter.value
          : false;
  }
}

function getFieldReferenceWarning(fieldId: string, kind: string) {
  return `${kind} references a field that is archived or no longer exists: ${fieldId}`;
}

export function getViewReferencedFieldIds(view: EntityView) {
  return new Set([
    ...view.filters.map((filter) => filter.fieldDefinitionId),
    ...view.sorts.map((sort) => sort.fieldDefinitionId),
    ...view.columnFieldDefinitionIds,
  ]);
}

export function getDefaultColumnFieldDefinitionIds(fields: FieldDefinition[]) {
  return [...fields]
    .sort((left, right) => left.position - right.position)
    .map((field) => field.id);
}

export type ViewStateEvaluationResult = {
  records: EntityRecord[];
  visibleFields: FieldDefinition[];
  warnings: string[];
  invalidFilter: boolean;
};

// The pure evaluation core shared by evaluateEntityView (a saved view, or
// the implicit All Records view) and any caller that needs to evaluate an
// arbitrary, not-necessarily-saved filters/sorts/columns combination -- for
// example unsaved quick-bar state layered on top of a view (see
// view-query-state.ts). Reusing this instead of a parallel implementation
// keeps stale-reference handling (fail-closed filters, degrade-with-warning
// sorts/columns) identical for saved and unsaved state.
export function evaluateViewState({
  filters,
  sorts,
  columnFieldDefinitionIds,
  activeFields,
  allFields,
  records,
}: {
  filters: ViewFilter[];
  sorts: ViewSort[];
  columnFieldDefinitionIds: FieldDefinition["id"][];
  activeFields: FieldDefinition[];
  allFields: FieldDefinition[];
  records: EntityRecord[];
}): ViewStateEvaluationResult {
  const activeFieldById = new Map(activeFields.map((field) => [field.id, field]));
  const allFieldById = new Map(allFields.map((field) => [field.id, field]));

  const warnings: string[] = [];
  let invalidFilter = false;
  const validFilters: Array<{ filter: ViewFilter; field: FieldDefinition }> = [];
  const validSorts: Array<{ sort: ViewSort; field: FieldDefinition }> = [];
  const visibleFields = columnFieldDefinitionIds.flatMap((fieldId) => {
    const field = activeFieldById.get(fieldId);

    if (!field) {
      warnings.push(getFieldReferenceWarning(fieldId, "Column"));
      return [];
    }

    return [field];
  });

  filters.forEach((filter) => {
    const field = activeFieldById.get(filter.fieldDefinitionId);

    if (!field) {
      const archivedOrMissing = allFieldById.get(filter.fieldDefinitionId);
      warnings.push(
        archivedOrMissing?.archivedAt
          ? `Filter references archived field ${archivedOrMissing.name}.`
          : getFieldReferenceWarning(filter.fieldDefinitionId, "Filter"),
      );
      invalidFilter = true;
      return;
    }

    const validOperators = filterOperatorsByFieldType[field.type];

    if (!validOperators.includes(filter.operator)) {
      warnings.push(`${filter.operator} is not valid for ${field.name}.`);
      invalidFilter = true;
      return;
    }

    validFilters.push({ filter, field });
  });

  sorts.forEach((sort) => {
    const field = activeFieldById.get(sort.fieldDefinitionId);

    if (!field) {
      warnings.push(getFieldReferenceWarning(sort.fieldDefinitionId, "Sort"));
      return;
    }

    if (!sortFieldTypes.has(field.type)) {
      warnings.push(`${field.name} cannot be sorted in table views.`);
      return;
    }

    validSorts.push({ sort, field });
  });

  const filteredRecords = invalidFilter
    ? []
    : records.filter((record) =>
        validFilters.every(({ filter, field }) =>
          filterMatchesValue({
            field,
            filter,
            value: record.values[field.key],
          }),
        ),
      );

  const sortedRecords = [...filteredRecords].sort((left, right) => {
    for (const { sort, field } of validSorts) {
      const result = compareScalarValues(
        left.values[field.key],
        right.values[field.key],
      );

      if (result !== 0) {
        return sort.direction === "asc" ? result : -result;
      }
    }

    return left.id.localeCompare(right.id);
  });

  return {
    records: sortedRecords,
    visibleFields,
    warnings,
    invalidFilter,
  };
}

export function evaluateEntityView({
  selectedView,
  activeFields,
  allFields,
  records,
}: {
  selectedView?: EntityView;
  activeFields: FieldDefinition[];
  allFields: FieldDefinition[];
  records: EntityRecord[];
  relationLabelsByFieldKey?: RelationLabelsByFieldKey;
}): EvaluatedView {
  if (!selectedView) {
    return {
      kind: "all",
      records,
      visibleFields: [...activeFields].sort(
        (left, right) => left.position - right.position,
      ),
      warnings: [],
      invalidFilter: false,
    };
  }

  const result = evaluateViewState({
    filters: selectedView.filters,
    sorts: selectedView.sorts,
    columnFieldDefinitionIds: selectedView.columnFieldDefinitionIds,
    activeFields,
    allFields,
    records,
  });

  return {
    kind: "saved",
    selectedView,
    ...result,
  };
}
