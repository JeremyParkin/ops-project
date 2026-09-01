"use client";

import Link from "next/link";
import { useActionState } from "react";
import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
} from "@/lib/domain/types";
import type { RelationOptionsByFieldKey } from "@/lib/domain/record-repository";
import { activeChoiceOptions } from "@/lib/domain/choice-display";
import type { ChoiceOptionsByFieldKey } from "@/lib/domain/choice-display";
import type { RecordFormState } from "@/lib/domain/record-validation";

type RecordEditFormProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  record: EntityRecord;
  relationOptionsByFieldKey?: RelationOptionsByFieldKey;
  choiceOptionsByFieldKey?: ChoiceOptionsByFieldKey;
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
  choiceOptionsByFieldKey = {},
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
    <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-graphite">
          Edit {entityType.name}
        </h1>
        <p className="mt-1 text-sm text-stone">
          Fields marked <span className="font-semibold text-red-700">*</span> are required.
        </p>
        {state.message ? (
          <p
            className={`mt-2 text-sm ${
              state.success ? "text-status-sage" : "text-red-700"
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
                  className="flex items-center gap-3 text-sm font-medium text-slab"
                >
                  <input
                    id={fieldId}
                    name={field.key}
                    type="checkbox"
                    value="true"
                    defaultChecked={fieldValue === "true"}
                    className="h-4 w-4 border-grit text-brass-deep"
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

          if (field.type === "choice") {
            const allOptions = choiceOptionsByFieldKey[field.key] ?? [];
            const active = activeChoiceOptions(allOptions);
            const currentOption = allOptions.find((option) => option.id === fieldValue);
            // Include the record's own current option even if archived, so
            // it doesn't just disappear from the field -- it stays valid to
            // keep, but archived options are never offered for a fresh pick.
            const options =
              currentOption?.archivedAt && !active.some((option) => option.id === currentOption.id)
                ? [currentOption, ...active]
                : active;

            return (
              <div key={field.id}>
                <label
                  htmlFor={fieldId}
                  className="block text-sm font-medium text-slab"
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
                  className="mt-1 block h-10 w-full border border-grit bg-white px-3 text-sm text-graphite outline-none focus:border-brass-deep"
                >
                  <option value="">Choose an option</option>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                      {option.archivedAt ? " (Archived)" : ""}
                    </option>
                  ))}
                </select>
                <div id={`${fieldId}-error`}>
                  <FieldError message={state.errors[field.key]} />
                </div>
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
                  className="block text-sm font-medium text-slab"
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
                  className="mt-1 block h-10 w-full border border-grit bg-white px-3 text-sm text-graphite outline-none focus:border-brass-deep"
                >
                  <option value="">Choose record</option>
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {relatedEntityName ? (
                  <p className="mt-1 text-xs text-stone">
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
                className="block text-sm font-medium text-slab"
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
                className="mt-1 block h-10 w-full border border-grit px-3 text-sm text-graphite outline-none focus:border-brass-deep"
              />
              <div id={`${fieldId}-error`}>
                <FieldError message={state.errors[field.key]} />
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-3 border-t border-grit pt-4 md:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
          >
            {pending ? "Saving..." : "Save Changes"}
          </button>
          <Link
            href={
              returnTo === "detail"
                ? `/entities/${entityType.id}/records/${record.id}`
                : `/entities/${entityType.id}`
            }
            className="h-10 px-2 py-2 text-sm font-medium text-stone underline-offset-4 hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
