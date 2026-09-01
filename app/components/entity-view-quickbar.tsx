"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type {
  RelationOptionsByFieldKey,
} from "@/lib/domain/record-repository";
import type { FieldDefinition } from "@/lib/domain/types";
import {
  FILTER_OPERATORS_BY_FIELD_TYPE,
  FILTER_OPERATOR_LABELS,
  SORTABLE_FIELD_TYPES,
} from "@/lib/domain/view-operators";
import { viewFilterNeedsValue } from "@/lib/domain/view-engine";
import {
  serializeViewState,
  withoutViewStateParams,
  withViewStateParams,
} from "@/lib/domain/view-query-state";
import type { ViewFilter, ViewSort } from "@/lib/domain/view-types";

type EntityViewQuickBarProps = {
  activeFields: FieldDefinition[];
  relationOptionsByFieldKey: RelationOptionsByFieldKey;
  effectiveFilters: ViewFilter[];
  effectiveSorts: ViewSort[];
  effectiveColumnIds: string[];
  hasPendingEdits: boolean;
  selectedViewName?: string;
};

function fieldLabel(field: FieldDefinition) {
  return `${field.name} (${field.type})`;
}

function formatFilterValue(filter: ViewFilter, field?: FieldDefinition) {
  if (!viewFilterNeedsValue(filter.operator)) {
    return "";
  }

  if (field?.type === "boolean") {
    return filter.value === true ? "Yes" : "No";
  }

  return String(filter.value ?? "");
}

export function EntityViewQuickBar({
  activeFields,
  relationOptionsByFieldKey,
  effectiveFilters,
  effectiveSorts,
  effectiveColumnIds,
  hasPendingEdits,
  selectedViewName,
}: EntityViewQuickBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isAddingFilter, setIsAddingFilter] = useState(false);
  const [isAddingSort, setIsAddingSort] = useState(false);
  const [isColumnsOpen, setIsColumnsOpen] = useState(false);
  const [draftColumnIds, setDraftColumnIds] = useState<string[]>(effectiveColumnIds);

  const activeFieldById = new Map(activeFields.map((field) => [field.id, field]));
  const sortableFields = activeFields.filter((field) =>
    SORTABLE_FIELD_TYPES.has(field.type),
  );

  const [filterFieldId, setFilterFieldId] = useState(activeFields[0]?.id ?? "");
  const filterField = activeFieldById.get(filterFieldId);
  const filterOperators = filterField
    ? FILTER_OPERATORS_BY_FIELD_TYPE[filterField.type]
    : [];
  const [filterOperator, setFilterOperator] = useState<string>(filterOperators[0] ?? "equals");
  const [filterValue, setFilterValue] = useState("");

  const [sortFieldId, setSortFieldId] = useState(sortableFields[0]?.id ?? "");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  function navigateWithState(next: {
    filters: ViewFilter[];
    sorts: ViewSort[];
    columnFieldDefinitionIds: string[];
  }) {
    const nextParams = withViewStateParams(
      new URLSearchParams(searchParams.toString()),
      serializeViewState(next),
    );
    router.push(`${pathname}?${nextParams.toString()}`);
  }

  function handleAddFilter() {
    if (!filterField) {
      return;
    }

    const needsValue = viewFilterNeedsValue(filterOperator as ViewFilter["operator"]);

    if (needsValue && filterValue.trim() === "") {
      return;
    }

    const nextFilter: ViewFilter = {
      fieldDefinitionId: filterField.id,
      operator: filterOperator as ViewFilter["operator"],
      ...(needsValue ? { value: filterValue.trim() } : {}),
    };

    navigateWithState({
      filters: [...effectiveFilters, nextFilter],
      sorts: effectiveSorts,
      columnFieldDefinitionIds: effectiveColumnIds,
    });
    setIsAddingFilter(false);
    setFilterValue("");
  }

  function handleRemoveFilter(index: number) {
    navigateWithState({
      filters: effectiveFilters.filter((_, currentIndex) => currentIndex !== index),
      sorts: effectiveSorts,
      columnFieldDefinitionIds: effectiveColumnIds,
    });
  }

  function handleAddSort() {
    if (!sortFieldId) {
      return;
    }

    navigateWithState({
      filters: effectiveFilters,
      sorts: [
        ...effectiveSorts.filter((sort) => sort.fieldDefinitionId !== sortFieldId),
        { fieldDefinitionId: sortFieldId, direction: sortDirection },
      ],
      columnFieldDefinitionIds: effectiveColumnIds,
    });
    setIsAddingSort(false);
  }

  function handleRemoveSort(index: number) {
    navigateWithState({
      filters: effectiveFilters,
      sorts: effectiveSorts.filter((_, currentIndex) => currentIndex !== index),
      columnFieldDefinitionIds: effectiveColumnIds,
    });
  }

  function handleApplyColumns() {
    navigateWithState({
      filters: effectiveFilters,
      sorts: effectiveSorts,
      columnFieldDefinitionIds: draftColumnIds,
    });
    setIsColumnsOpen(false);
  }

  function toggleDraftColumn(fieldId: string, checked: boolean) {
    setDraftColumnIds((current) => {
      if (checked) {
        return current.includes(fieldId) ? current : [...current, fieldId];
      }

      return current.filter((currentFieldId) => currentFieldId !== fieldId);
    });
  }

  function moveDraftColumn(fieldId: string, direction: -1 | 1) {
    setDraftColumnIds((current) => {
      const index = current.indexOf(fieldId);
      const nextIndex = index + direction;

      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];

      return next;
    });
  }

  function handleDiscardPending() {
    const nextParams = withoutViewStateParams(new URLSearchParams(searchParams.toString()));
    router.push(`${pathname}?${nextParams.toString()}`);
  }

  function handleOpenSavePrompt() {
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("saveView", "true");
    router.push(`${pathname}?${nextParams.toString()}#manage-views`);
  }

  return (
    <section
      data-testid="entity-view-quickbar"
      className="mx-auto w-full max-w-6xl border border-slate-200 border-t-0 bg-chalk px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {effectiveFilters.map((filter, index) => {
          const field = activeFieldById.get(filter.fieldDefinitionId);
          const value = formatFilterValue(filter, field);

          return (
            <span
              key={`filter-chip-${index}`}
              className="inline-flex items-center gap-1 border border-grit bg-white px-2 py-1 text-xs text-graphite"
            >
              {field?.name ?? "Unknown field"}{" "}
              {FILTER_OPERATOR_LABELS[filter.operator]}
              {value ? ` "${value}"` : ""}
              <button
                type="button"
                onClick={() => handleRemoveFilter(index)}
                aria-label={`Remove filter: ${field?.name ?? filter.fieldDefinitionId}`}
                className="ml-1 font-semibold text-stone hover:text-graphite"
              >
                ×
              </button>
            </span>
          );
        })}

        {effectiveSorts.map((sort, index) => {
          const field = activeFieldById.get(sort.fieldDefinitionId);

          return (
            <span
              key={`sort-chip-${index}`}
              className="inline-flex items-center gap-1 border border-grit bg-white px-2 py-1 text-xs text-graphite"
            >
              Sort: {field?.name ?? "Unknown field"} {sort.direction === "asc" ? "↑" : "↓"}
              <button
                type="button"
                onClick={() => handleRemoveSort(index)}
                aria-label={`Remove sort: ${field?.name ?? sort.fieldDefinitionId}`}
                className="ml-1 font-semibold text-stone hover:text-graphite"
              >
                ×
              </button>
            </span>
          );
        })}

        <button
          type="button"
          onClick={() => setIsAddingFilter((current) => !current)}
          className="border border-grit bg-white px-2 py-1 text-xs font-medium text-stone hover:bg-slab/5"
        >
          + Add filter
        </button>
        <button
          type="button"
          onClick={() => setIsAddingSort((current) => !current)}
          className="border border-grit bg-white px-2 py-1 text-xs font-medium text-stone hover:bg-slab/5"
        >
          + Add sort
        </button>
        <button
          type="button"
          onClick={() => {
            setDraftColumnIds(effectiveColumnIds);
            setIsColumnsOpen((current) => !current);
          }}
          className="border border-grit bg-white px-2 py-1 text-xs font-medium text-stone hover:bg-slab/5"
        >
          Columns
        </button>

        {hasPendingEdits ? (
          <span className="ml-auto flex items-center gap-2 text-xs text-stone">
            Unsaved changes to {selectedViewName ?? "All Records"}
            <button
              type="button"
              onClick={handleOpenSavePrompt}
              className="border border-brass bg-brass px-2 py-1 font-medium text-graphite hover:bg-brass-deep hover:text-paper"
            >
              {selectedViewName ? "Update View" : "Save as View"}
            </button>
            <button
              type="button"
              onClick={handleDiscardPending}
              className="font-medium text-stone underline-offset-4 hover:underline"
            >
              Discard
            </button>
          </span>
        ) : null}
      </div>

      {isAddingFilter ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-grit pt-3">
          <select
            aria-label="Quick filter field"
            value={filterFieldId}
            onChange={(event) => {
              const nextFieldId = event.currentTarget.value;
              const nextField = activeFieldById.get(nextFieldId);
              setFilterFieldId(nextFieldId);
              setFilterOperator(
                nextField ? FILTER_OPERATORS_BY_FIELD_TYPE[nextField.type][0] : "equals",
              );
              setFilterValue("");
            }}
            className="h-9 border border-grit bg-white px-2 text-sm text-graphite"
          >
            {activeFields.map((field) => (
              <option key={field.id} value={field.id}>
                {fieldLabel(field)}
              </option>
            ))}
          </select>
          <select
            aria-label="Quick filter operator"
            value={filterOperator}
            onChange={(event) => setFilterOperator(event.currentTarget.value)}
            className="h-9 border border-grit bg-white px-2 text-sm text-graphite"
          >
            {filterOperators.map((operator) => (
              <option key={operator} value={operator}>
                {FILTER_OPERATOR_LABELS[operator]}
              </option>
            ))}
          </select>
          {viewFilterNeedsValue(filterOperator as ViewFilter["operator"]) ? (
            filterField?.type === "boolean" ? (
              <select
                aria-label="Quick filter value"
                value={filterValue}
                onChange={(event) => setFilterValue(event.currentTarget.value)}
                className="h-9 border border-grit bg-white px-2 text-sm text-graphite"
              >
                <option value="">Choose value</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : filterField?.type === "relation" ? (
              <select
                aria-label="Quick filter value"
                value={filterValue}
                onChange={(event) => setFilterValue(event.currentTarget.value)}
                className="h-9 border border-grit bg-white px-2 text-sm text-graphite"
              >
                <option value="">Choose an option</option>
                {(relationOptionsByFieldKey[filterField.key] ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label="Quick filter value"
                type={filterField?.type === "date" ? "date" : "text"}
                value={filterValue}
                onChange={(event) => setFilterValue(event.currentTarget.value)}
                className="h-9 border border-grit bg-white px-2 text-sm text-graphite"
              />
            )
          ) : null}
          <button
            type="button"
            onClick={handleAddFilter}
            className="h-9 border border-grit bg-white px-3 text-sm font-medium text-graphite hover:bg-slab/5"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setIsAddingFilter(false)}
            className="h-9 px-2 text-sm text-stone underline-offset-4 hover:underline"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {isAddingSort ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-grit pt-3">
          <select
            aria-label="Quick sort field"
            value={sortFieldId}
            onChange={(event) => setSortFieldId(event.currentTarget.value)}
            className="h-9 border border-grit bg-white px-2 text-sm text-graphite"
          >
            {sortableFields.map((field) => (
              <option key={field.id} value={field.id}>
                {fieldLabel(field)}
              </option>
            ))}
          </select>
          <select
            aria-label="Quick sort direction"
            value={sortDirection}
            onChange={(event) =>
              setSortDirection(event.currentTarget.value === "desc" ? "desc" : "asc")
            }
            className="h-9 border border-grit bg-white px-2 text-sm text-graphite"
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button
            type="button"
            onClick={handleAddSort}
            className="h-9 border border-grit bg-white px-3 text-sm font-medium text-graphite hover:bg-slab/5"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setIsAddingSort(false)}
            className="h-9 px-2 text-sm text-stone underline-offset-4 hover:underline"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {isColumnsOpen ? (
        <div className="mt-3 grid gap-2 border-t border-grit pt-3">
          {activeFields.map((field) => {
            const visible = draftColumnIds.includes(field.id);
            const order = draftColumnIds.indexOf(field.id);

            return (
              <div
                key={field.id}
                className="flex flex-wrap items-center justify-between gap-2 border border-grit bg-white px-3 py-2"
              >
                <label className="flex items-center gap-2 text-sm text-graphite">
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={(event) => toggleDraftColumn(field.id, event.currentTarget.checked)}
                    className="h-4 w-4"
                  />
                  {fieldLabel(field)}
                </label>
                {visible ? (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => moveDraftColumn(field.id, -1)}
                      disabled={order <= 0}
                      className="h-7 border border-grit px-2 text-xs disabled:text-stone/50"
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      onClick={() => moveDraftColumn(field.id, 1)}
                      disabled={order === draftColumnIds.length - 1}
                      className="h-7 border border-grit px-2 text-xs disabled:text-stone/50"
                    >
                      Down
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleApplyColumns}
              disabled={draftColumnIds.length === 0}
              className="h-9 border border-grit bg-white px-3 text-sm font-medium text-graphite hover:bg-slab/5 disabled:text-stone/50"
            >
              Apply columns
            </button>
            <button
              type="button"
              onClick={() => setIsColumnsOpen(false)}
              className="h-9 px-2 text-sm text-stone underline-offset-4 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
