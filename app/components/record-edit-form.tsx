"use client";

import Link from "next/link";
import { useActionState } from "react";
import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
} from "@/lib/domain/types";
import type { RelationOptionsByFieldKey } from "@/lib/domain/record-repository";
import type { RecordFormState } from "@/lib/domain/record-validation";

type RecordEditFormProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  record: EntityRecord;
  relationOptionsByFieldKey?: RelationOptionsByFieldKey;
  entityNameById?: Record<string, string>;
  updateRecordAction: (
    state: RecordFormState,
    formData: FormData,
  ) => Promise<RecordFormState>;
  returnTo?: "detail";
};

function createInitialEditState(
  fields: FieldDefinition[],
  record: EntityRecord,
): RecordFormState {
  return {
    success: false,
    message: "",
    errors: {},
    values: Object.fromEntries(
      fields.map((field) => {
        const value = record.values[field.key];

        return [
          field.key,
          value === null || value === undefined ? "" : String(value),
        ];
      }),
    ),
  };
}

function getFieldValue(state: RecordFormState, field: FieldDefinition) {
  return state.values[field.key] ?? "";
}

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

export function RecordEditForm({
  entityType,
  fields,
  record,
  relationOptionsByFieldKey = {},
  entityNameById = {},
  updateRecordAction,
  returnTo,
}: RecordEditFormProps) {
  const [state, formAction, pending] = useActionState(
    updateRecordAction,
    createInitialEditState(fields, record),
  );
  const orderedFields = [...fields].sort((left, right) => {
    return left.position - right.position;
  });

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-slate-950">
          Edit {entityType.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Fields marked <span className="font-semibold text-red-700">*</span> are required.
        </p>
        {state.message ? (
          <p
            className={`mt-2 text-sm ${
              state.success ? "text-emerald-700" : "text-red-700"
            }`}
            role="status"
          >
            {state.message}
          </p>
        ) : null}
        <FieldError message={state.errors._form} />
      </div>

      <form action={formAction} className="grid gap-5 md:grid-cols-2">
        {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
        {orderedFields.map((field) => {
          const fieldId = `edit-record-field-${field.key}`;
          const fieldValue = getFieldValue(state, field);

          if (field.type === "boolean") {
            return (
              <div key={field.id} className="md:col-span-2">
                <input type="hidden" name={field.key} value="false" />
                <label
                  htmlFor={fieldId}
                  className="flex items-center gap-3 text-sm font-medium text-slate-800"
                >
                  <input
                    id={fieldId}
                    name={field.key}
                    type="checkbox"
                    value="true"
                    defaultChecked={fieldValue === "true"}
                    className="h-4 w-4 border-slate-300 text-slate-950"
                  />
                  {field.name}
                  {field.required ? (
                    <span className="text-red-700" aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </label>
                <FieldError message={state.errors[field.key]} />
              </div>
            );
          }

          if (field.type === "relation") {
            const options = relationOptionsByFieldKey[field.key] ?? [];
            const relatedEntityName = field.relatedEntityTypeId
              ? entityNameById[field.relatedEntityTypeId]
              : undefined;

            return (
              <div key={field.id}>
                <label
                  htmlFor={fieldId}
                  className="block text-sm font-medium text-slate-800"
                >
                  {field.name}
                  {field.required ? (
                    <span className="ml-1 text-red-700" aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </label>
                <select
                  id={fieldId}
                  name={field.key}
                  required={field.required}
                  defaultValue={fieldValue}
                  aria-invalid={state.errors[field.key] ? "true" : "false"}
                  aria-describedby={
                    state.errors[field.key] ? `${fieldId}-error` : undefined
                  }
                  className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                >
                  <option value="">Choose record</option>
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {relatedEntityName ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Related to {relatedEntityName}
                  </p>
                ) : null}
                <div id={`${fieldId}-error`}>
                  <FieldError message={state.errors[field.key]} />
                </div>
              </div>
            );
          }

          return (
            <div key={field.id}>
              <label
                htmlFor={fieldId}
                className="block text-sm font-medium text-slate-800"
              >
                {field.name}
                {field.required ? (
                  <span className="ml-1 text-red-700" aria-hidden="true">
                    *
                  </span>
                ) : null}
              </label>
              <input
                id={fieldId}
                name={field.key}
                type={field.type === "number" ? "text" : field.type}
                required={field.required}
                defaultValue={fieldValue}
                aria-invalid={state.errors[field.key] ? "true" : "false"}
                aria-describedby={
                  state.errors[field.key] ? `${fieldId}-error` : undefined
                }
                className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
              />
              <div id={`${fieldId}-error`}>
                <FieldError message={state.errors[field.key]} />
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 md:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {pending ? "Saving..." : "Save Changes"}
          </button>
          <Link
            href={
              returnTo === "detail"
                ? `/entities/${entityType.id}/records/${record.id}`
                : `/entities/${entityType.id}`
            }
            className="h-10 px-2 py-2 text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
