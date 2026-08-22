"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import type { DeleteViewActionState } from "@/app/actions";
import type { RelationOptionsByFieldKey } from "@/lib/domain/record-repository";
import type { EntityType, FieldDefinition } from "@/lib/domain/types";
import type { EntityView, ViewFilter, ViewSort } from "@/lib/domain/view-types";
import {
  createInitialViewFormState,
  type ViewFormState,
} from "@/lib/domain/view-validation";

type EntityViewsPanelProps = {
  entityType: EntityType;
  views: EntityView[];
  selectedView?: EntityView;
  activeFields: FieldDefinition[];
  allFields: FieldDefinition[];
  relationOptionsByFieldKey: RelationOptionsByFieldKey;
  warnings: string[];
  invalidFilter: boolean;
  createViewAction: (
    state: ViewFormState,
    formData: FormData,
  ) => Promise<ViewFormState>;
  updateViewAction?: (
    state: ViewFormState,
    formData: FormData,
  ) => Promise<ViewFormState>;
  deleteViewAction?: (
    state: DeleteViewActionState,
    formData: FormData,
  ) => Promise<DeleteViewActionState>;
};

type FormMode = "create" | "edit";

const operatorsByFieldType: Record<FieldDefinition["type"], string[]> = {
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

const operatorLabels: Record<string, string> = {
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

function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="mt-1 text-sm text-red-700" role="alert">
      {message}
    </p>
  );
}

function getDefaultColumns(fields: FieldDefinition[]) {
  return [...fields]
    .sort((left, right) => left.position - right.position)
    .map((field) => field.id);
}

function fieldLabel(field: FieldDefinition) {
  return `${field.name} (${field.type})`;
}

function ViewForm({
  mode,
  view,
  activeFields,
  allFields,
  relationOptionsByFieldKey,
  action,
}: {
  mode: FormMode;
  view?: EntityView;
  activeFields: FieldDefinition[];
  allFields: FieldDefinition[];
  relationOptionsByFieldKey: RelationOptionsByFieldKey;
  action: (
    state: ViewFormState,
    formData: FormData,
  ) => Promise<ViewFormState>;
}) {
  const initialValues = useMemo(
    () => ({
      name: view?.name ?? "",
      filters: view?.filters ?? [],
      sorts: view?.sorts ?? [],
      columnFieldDefinitionIds:
        view?.columnFieldDefinitionIds ?? getDefaultColumns(activeFields),
      isDefault: view?.isDefault ?? false,
    }),
    [activeFields, view],
  );
  const [state, formAction, pending] = useActionState(
    action,
    createInitialViewFormState(initialValues),
  );
  const [filters, setFilters] = useState<ViewFilter[]>(initialValues.filters);
  const [sorts, setSorts] = useState<ViewSort[]>(initialValues.sorts);
  const [columnIds, setColumnIds] = useState<string[]>(
    initialValues.columnFieldDefinitionIds.filter((fieldId) =>
      activeFields.some((field) => field.id === fieldId),
    ),
  );
  const activeFieldById = new Map(activeFields.map((field) => [field.id, field]));
  const allFieldById = new Map(allFields.map((field) => [field.id, field]));

  function moveColumn(fieldId: string, direction: -1 | 1) {
    setColumnIds((current) => {
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

  function toggleColumn(fieldId: string, checked: boolean) {
    setColumnIds((current) => {
      if (checked) {
        return current.includes(fieldId) ? current : [...current, fieldId];
      }

      return current.filter((currentFieldId) => currentFieldId !== fieldId);
    });
  }

  return (
    <form action={formAction} className="grid gap-5 border-t border-slate-200 pt-5">
      <div>
        <label
          htmlFor={`${mode}-view-name`}
          className="block text-sm font-medium text-slate-800"
        >
          View Name
        </label>
        <input
          id={`${mode}-view-name`}
          name="viewName"
          defaultValue={state.values.name}
          className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
        />
        <FieldError message={state.errors.viewName} />
      </div>

      <div className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-950">Filters</h3>
          <button
            type="button"
            onClick={() =>
              setFilters((current) => [
                ...current,
                {
                  fieldDefinitionId: activeFields[0]?.id ?? "",
                  operator: "equals",
                  value: "",
                },
              ])
            }
            className="border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
          >
            Add Filter
          </button>
        </div>
        {filters.length === 0 ? (
          <p className="text-sm text-slate-500">No filters.</p>
        ) : null}
        {filters.map((filter, index) => {
          const field =
            activeFieldById.get(filter.fieldDefinitionId) ??
            allFieldById.get(filter.fieldDefinitionId);
          const operators = field
            ? operatorsByFieldType[field.type]
            : ["equals", "not_equals", "is_set", "is_not_set"];

          return (
            <div
              key={`filter-${index}`}
              className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]"
            >
              <select
                name={`filterField:${index}`}
                value={filter.fieldDefinitionId}
                onChange={(event) => {
                  const selectedFieldId = event.currentTarget.value;
                  const nextField = activeFieldById.get(selectedFieldId);
                  setFilters((current) =>
                    current.map((currentFilter, currentIndex) =>
                      currentIndex === index
                        ? {
                            fieldDefinitionId: selectedFieldId,
                            operator: nextField
                              ? (operatorsByFieldType[nextField.type][0] as ViewFilter["operator"])
                              : "equals",
                            value: "",
                          }
                        : currentFilter,
                    ),
                  );
                }}
                className="h-10 border border-slate-300 bg-white px-3 text-sm text-slate-950"
              >
                {field && !activeFieldById.has(field.id) ? (
                  <option value={field.id}>{field.name} (Archived)</option>
                ) : null}
                {activeFields.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {fieldLabel(candidate)}
                  </option>
                ))}
              </select>
              <select
                name={`filterOperator:${index}`}
                value={filter.operator}
                onChange={(event) => {
                  const selectedOperator = event.currentTarget
                    .value as ViewFilter["operator"];
                  setFilters((current) =>
                    current.map((currentFilter, currentIndex) =>
                      currentIndex === index
                        ? {
                            ...currentFilter,
                            operator: selectedOperator,
                          }
                        : currentFilter,
                    ),
                  );
                }}
                className="h-10 border border-slate-300 bg-white px-3 text-sm text-slate-950"
              >
                {operators.map((operator) => (
                  <option key={operator} value={operator}>
                    {operatorLabels[operator]}
                  </option>
                ))}
              </select>
              {field?.type === "boolean" ? (
                <select
                  name={`filterValue:${index}`}
                  defaultValue={String(filter.value ?? "")}
                  className="h-10 border border-slate-300 bg-white px-3 text-sm text-slate-950"
                >
                  <option value="">Choose value</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : field?.type === "relation" ? (
                <select
                  name={`filterValue:${index}`}
                  defaultValue={String(filter.value ?? "")}
                  className="h-10 border border-slate-300 bg-white px-3 text-sm text-slate-950"
                >
                  <option value="">Choose record</option>
                  {(relationOptionsByFieldKey[field.key] ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={`filterValue:${index}`}
                  type={field?.type === "date" ? "date" : "text"}
                  defaultValue={String(filter.value ?? "")}
                  className="h-10 border border-slate-300 px-3 text-sm text-slate-950"
                />
              )}
              <button
                type="button"
                onClick={() =>
                  setFilters((current) =>
                    current.filter((_, currentIndex) => currentIndex !== index),
                  )
                }
                className="h-10 border border-slate-300 px-3 text-sm font-medium text-slate-700"
              >
                Remove
              </button>
              <div className="md:col-span-4">
                <FieldError message={state.errors[`filterField:${index}`]} />
                <FieldError message={state.errors[`filterOperator:${index}`]} />
                <FieldError message={state.errors[`filterValue:${index}`]} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-950">Sorting</h3>
          <button
            type="button"
            onClick={() =>
              setSorts((current) => [
                ...current,
                {
                  fieldDefinitionId:
                    activeFields.find((field) => field.type !== "relation")?.id ??
                    "",
                  direction: "asc",
                },
              ])
            }
            className="border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
          >
            Add Sort
          </button>
        </div>
        {sorts.length === 0 ? (
          <p className="text-sm text-slate-500">No sorting.</p>
        ) : null}
        {sorts.map((sort, index) => (
          <div
            key={`sort-${index}`}
            className="grid gap-2 md:grid-cols-[1fr_1fr_auto]"
          >
            <select
              name={`sortField:${index}`}
              defaultValue={sort.fieldDefinitionId}
              className="h-10 border border-slate-300 bg-white px-3 text-sm text-slate-950"
            >
              {activeFields
                .filter((field) => field.type !== "relation")
                .map((field) => (
                  <option key={field.id} value={field.id}>
                    {fieldLabel(field)}
                  </option>
                ))}
            </select>
            <select
              name={`sortDirection:${index}`}
              defaultValue={sort.direction}
              className="h-10 border border-slate-300 bg-white px-3 text-sm text-slate-950"
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button
              type="button"
              onClick={() =>
                setSorts((current) =>
                  current.filter((_, currentIndex) => currentIndex !== index),
                )
              }
              className="h-10 border border-slate-300 px-3 text-sm font-medium text-slate-700"
            >
              Remove
            </button>
            <div className="md:col-span-3">
              <FieldError message={state.errors[`sortField:${index}`]} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-semibold text-slate-950">Columns</h3>
        <div className="grid gap-2">
          {columnIds.map((fieldId) => (
            <input
              key={fieldId}
              type="hidden"
              name="columnFieldDefinitionId"
              value={fieldId}
            />
          ))}
          {activeFields.map((field) => {
            const visible = columnIds.includes(field.id);
            const order = columnIds.indexOf(field.id);

            return (
              <div
                key={field.id}
                className="grid gap-2 border border-slate-200 p-3 md:grid-cols-[1fr_auto]"
              >
                <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={(event) =>
                      toggleColumn(field.id, event.currentTarget.checked)
                    }
                    className="h-4 w-4"
                  />
                  {fieldLabel(field)}
                </label>
                {visible ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => moveColumn(field.id, -1)}
                      disabled={order <= 0}
                      className="h-8 border border-slate-300 px-2 text-sm disabled:text-slate-400"
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      onClick={() => moveColumn(field.id, 1)}
                      disabled={order === columnIds.length - 1}
                      className="h-8 border border-slate-300 px-2 text-sm disabled:text-slate-400"
                    >
                      Down
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <FieldError message={state.errors.columnFieldDefinitionId} />
      </div>

      <input name="isDefault" type="hidden" value="false" />
      <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
        <input
          name="isDefault"
          type="checkbox"
          value="true"
          defaultChecked={state.values.isDefault}
          className="h-4 w-4"
        />
        Make this the default view
      </label>

      {state.message || state.errors._form ? (
        <p
          className={`text-sm ${
            state.success ? "text-emerald-700" : "text-red-700"
          }`}
          role="status"
        >
          {state.message || state.errors._form}
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white disabled:bg-slate-400"
        >
          {pending
            ? mode === "create"
              ? "Creating..."
              : "Saving..."
            : mode === "create"
              ? "Create View"
              : "Save View"}
        </button>
      </div>
    </form>
  );
}

function DeleteViewForm({
  deleteViewAction,
}: {
  deleteViewAction: (
    state: DeleteViewActionState,
    formData: FormData,
  ) => Promise<DeleteViewActionState>;
}) {
  const [state, action, pending] = useActionState(deleteViewAction, {
    success: false,
    message: "",
  });

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm("Delete this view? Records will not be deleted.")) {
          event.preventDefault();
        }
      }}
    >
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center justify-center border border-red-700 px-4 text-sm font-medium text-red-700 disabled:text-slate-400"
      >
        {pending ? "Deleting..." : "Delete View"}
      </button>
      {state.message ? (
        <p className="mt-2 text-sm text-red-700" role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function EntityViewsPanel({
  entityType,
  views,
  selectedView,
  activeFields,
  allFields,
  relationOptionsByFieldKey,
  warnings,
  invalidFilter,
  createViewAction,
  updateViewAction,
  deleteViewAction,
}: EntityViewsPanelProps) {
  const defaultView = views.find((view) => view.isDefault);

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Link
          href={`/entities/${entityType.id}?view=all`}
          className={`border px-3 py-2 text-sm font-medium ${
            !selectedView
              ? "border-slate-950 bg-slate-950 text-white"
              : "border-slate-300 text-slate-700"
          }`}
        >
          All Records
        </Link>
        {views.map((view) => (
          <Link
            key={view.id}
            href={`/entities/${entityType.id}?view=${view.id}`}
            className={`border px-3 py-2 text-sm font-medium ${
              selectedView?.id === view.id
                ? "border-slate-950 bg-slate-950 text-white"
                : "border-slate-300 text-slate-700"
            }`}
          >
            {view.name}
            {view.isDefault ? " · Default" : ""}
          </Link>
        ))}
      </div>

      {warnings.length > 0 ? (
        <div className="mb-5 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">View needs repair.</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {invalidFilter ? (
            <p className="mt-2">
              This view cannot be evaluated correctly. Repair the filter or use
              All Records.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">
            {selectedView ? "Edit View" : "Create View"}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {defaultView
              ? `Default view: ${defaultView.name}`
              : "No default saved view. Entity navigation opens All Records."}
          </p>
        </div>

        {selectedView && updateViewAction ? (
          <>
            <ViewForm
              key={selectedView.id}
              mode="edit"
              view={selectedView}
              activeFields={activeFields}
              allFields={allFields}
              relationOptionsByFieldKey={relationOptionsByFieldKey}
              action={updateViewAction}
            />
            {deleteViewAction ? (
              <div className="border-t border-slate-200 pt-4">
                <DeleteViewForm deleteViewAction={deleteViewAction} />
              </div>
            ) : null}
          </>
        ) : (
          <ViewForm
            key="create-view"
            mode="create"
            activeFields={activeFields}
            allFields={allFields}
            relationOptionsByFieldKey={relationOptionsByFieldKey}
            action={createViewAction}
          />
        )}
      </div>
    </section>
  );
}
