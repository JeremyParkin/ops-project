import type { ViewFilter, ViewSort } from "./view-types";

// URL query-param encoding for *unsaved* quick-bar filter/sort/column edits.
// Deliberately reuses the exact field-name convention the Manage Views POST
// form already sends (filterField:<i>, filterOperator:<i>, filterValue:<i>,
// sortField:<i>, sortDirection:<i>, columnFieldDefinitionId) so the same
// values can be handed straight to validateViewFormData -- no parallel
// parsing/validation model for "pending" state.
//
// Once any of these keys is present in the URL, it is treated as a full
// snapshot of {filters, sorts, columns} that overrides the selected view's
// own persisted state entirely (not merged field-by-field). Callers that
// write these params must therefore always serialize the complete current
// state, not just the one row that changed.
const FILTER_FIELD_PREFIX = "filterField:";
const FILTER_OPERATOR_PREFIX = "filterOperator:";
const FILTER_VALUE_PREFIX = "filterValue:";
const SORT_FIELD_PREFIX = "sortField:";
const SORT_DIRECTION_PREFIX = "sortDirection:";
const COLUMN_KEY = "columnFieldDefinitionId";

export type RawSearchParams = Record<string, string | string[] | undefined>;

function isPendingViewParamKey(key: string) {
  return (
    key.startsWith(FILTER_FIELD_PREFIX) ||
    key.startsWith(FILTER_OPERATOR_PREFIX) ||
    key.startsWith(FILTER_VALUE_PREFIX) ||
    key.startsWith(SORT_FIELD_PREFIX) ||
    key.startsWith(SORT_DIRECTION_PREFIX) ||
    key === COLUMN_KEY
  );
}

export function hasPendingViewParams(rawSearchParams: RawSearchParams): boolean {
  return Object.keys(rawSearchParams).some(isPendingViewParamKey);
}

export function rawSearchParamsToUrlSearchParams(
  rawSearchParams: RawSearchParams,
): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(rawSearchParams)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => params.append(key, entry));
    } else {
      params.append(key, value);
    }
  }

  return params;
}

export function searchParamsToFormData(rawSearchParams: RawSearchParams): FormData {
  const formData = new FormData();

  for (const [key, value] of Object.entries(rawSearchParams)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => formData.append(key, entry));
    } else {
      formData.append(key, value);
    }
  }

  return formData;
}

// Serializes a full {filters, sorts, columns} snapshot into flat query
// entries using the same field names validateViewFormData reads.
export function serializeViewState({
  filters,
  sorts,
  columnFieldDefinitionIds,
}: {
  filters: ViewFilter[];
  sorts: ViewSort[];
  columnFieldDefinitionIds: string[];
}): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  filters.forEach((filter, index) => {
    entries.push([`${FILTER_FIELD_PREFIX}${index}`, filter.fieldDefinitionId]);
    entries.push([`${FILTER_OPERATOR_PREFIX}${index}`, filter.operator]);

    if (filter.value !== undefined) {
      entries.push([`${FILTER_VALUE_PREFIX}${index}`, String(filter.value)]);
    }
  });

  sorts.forEach((sort, index) => {
    entries.push([`${SORT_FIELD_PREFIX}${index}`, sort.fieldDefinitionId]);
    entries.push([`${SORT_DIRECTION_PREFIX}${index}`, sort.direction]);
  });

  columnFieldDefinitionIds.forEach((fieldId) => {
    entries.push([COLUMN_KEY, fieldId]);
  });

  return entries;
}

// Replaces any pending view-state params already in `currentSearch` with
// `entries`, leaving every other param (view, showArchived, manage, ...)
// untouched. Passing an empty `entries` array clears pending state entirely.
export function withViewStateParams(
  currentSearch: URLSearchParams,
  entries: Array<[string, string]>,
): URLSearchParams {
  const next = new URLSearchParams(currentSearch);

  [...next.keys()]
    .filter(isPendingViewParamKey)
    .forEach((key) => next.delete(key));

  entries.forEach(([key, value]) => next.append(key, value));

  return next;
}

// Strips pending view-state params (and the "open the save prompt" flag)
// from a URLSearchParams, e.g. once a quick edit has been persisted into a
// saved view and no longer needs to override it.
export function withoutViewStateParams(currentSearch: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(currentSearch);

  [...next.keys()]
    .filter((key) => isPendingViewParamKey(key) || key === "saveView")
    .forEach((key) => next.delete(key));

  return next;
}

// Whether the *effective* filters/sorts/columns (whatever produced them --
// a saved view, its defaults, or pending URL overrides) actually differ from
// the fallback state they'd have with no pending edits at all. Presence of
// pending URL keys alone isn't enough: the quick bar always re-serializes a
// full {filters, sorts, columns} snapshot on every edit (see
// serializeViewState), so cycling a sort back to "none" still leaves
// unrelated columnFieldDefinitionId params in the URL even though nothing
// is actually different from the saved/default state anymore.
export function isSameViewState(
  a: { filters: ViewFilter[]; sorts: ViewSort[]; columnFieldDefinitionIds: string[] },
  b: { filters: ViewFilter[]; sorts: ViewSort[]; columnFieldDefinitionIds: string[] },
): boolean {
  return (
    JSON.stringify(a.filters) === JSON.stringify(b.filters) &&
    JSON.stringify(a.sorts) === JSON.stringify(b.sorts) &&
    JSON.stringify(a.columnFieldDefinitionIds) === JSON.stringify(b.columnFieldDefinitionIds)
  );
}

// Click-to-sort header behavior: single-column, cycling
// none -> asc -> desc -> none. Clicking a different column always starts
// that column fresh at asc, replacing whatever sort was active.
export function cycleSortForField({
  currentSorts,
  fieldId,
}: {
  currentSorts: ViewSort[];
  fieldId: string;
}): ViewSort[] {
  const isSoleActiveSort =
    currentSorts.length === 1 && currentSorts[0].fieldDefinitionId === fieldId;

  if (!isSoleActiveSort) {
    return [{ fieldDefinitionId: fieldId, direction: "asc" }];
  }

  if (currentSorts[0].direction === "asc") {
    return [{ fieldDefinitionId: fieldId, direction: "desc" }];
  }

  return [];
}
