"use client";

import { useActionState, useState } from "react";
import type {
  FieldDefinitionFormState,
} from "@/lib/domain/field-definition-validation";
import { initialFieldDefinitionFormState } from "@/lib/domain/field-definition-validation";
import type { EntityType, FieldType } from "@/lib/domain/types";

type FieldCreateFormProps = {
  entityTypes: EntityType[];
  addFieldDefinitionAction: (
    state: FieldDefinitionFormState,
    formData: FormData,
  ) => Promise<FieldDefinitionFormState>;
};

const fieldTypes: Array<{ label: string; value: FieldType }> = [
  { label: "Text", value: "text" },
  { label: "Number", value: "number" },
  { label: "Date", value: "date" },
  { label: "Boolean", value: "boolean" },
  { label: "Relation", value: "relation" },
];

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

export function FieldCreateForm({
  entityTypes,
  addFieldDefinitionAction,
}: FieldCreateFormProps) {
  const [state, formAction, pending] = useActionState(
    addFieldDefinitionAction,
    initialFieldDefinitionFormState,
  );
  const [fieldType, setFieldType] = useState<FieldType>(state.values.type);

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-slate-950">Add Field</h2>
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

      <form action={formAction} className="grid gap-4 md:grid-cols-4">
        <div>
          <label
            htmlFor="fieldName"
            className="block text-sm font-medium text-slate-800"
          >
            Field Name
          </label>
          <input
            id="fieldName"
            name="fieldName"
            required
            defaultValue={state.values.name}
            className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          />
          <FieldError message={state.errors.fieldName} />
        </div>

        <div>
          <label
            htmlFor="fieldType"
            className="block text-sm font-medium text-slate-800"
          >
            Type
          </label>
          <select
            id="fieldType"
            name="fieldType"
            value={fieldType}
            onChange={(event) =>
              setFieldType(event.currentTarget.value as FieldType)
            }
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            {fieldTypes.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
          <FieldError message={state.errors.fieldType} />
        </div>

        {fieldType === "relation" ? (
          <div>
            <label
              htmlFor="fieldRelatedEntityTypeId"
              className="block text-sm font-medium text-slate-800"
            >
              Related Entity
            </label>
            <select
              id="fieldRelatedEntityTypeId"
              name="fieldRelatedEntityTypeId"
              defaultValue={state.values.relatedEntityTypeId}
              className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
            >
              <option value="">Choose entity</option>
              {entityTypes.map((entityType) => (
                <option key={entityType.id} value={entityType.id}>
                  {entityType.name}
                </option>
              ))}
            </select>
            <FieldError message={state.errors.fieldRelatedEntityTypeId} />
          </div>
        ) : (
          <input name="fieldRelatedEntityTypeId" type="hidden" value="" />
        )}

        <div className="flex items-end gap-4">
          <input name="fieldRequired" type="hidden" value="false" />
          <label className="flex h-10 items-center gap-2 text-sm font-medium text-slate-800">
            <input
              name="fieldRequired"
              type="checkbox"
              value="true"
              defaultChecked={state.values.required}
              className="h-4 w-4 border-slate-300 text-slate-950"
            />
            Required
          </label>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {pending ? "Adding..." : "Add Field"}
          </button>
        </div>
        <div className="md:col-span-4">
          <FieldError message={state.errors.fieldRequired} />
        </div>
      </form>
    </section>
  );
}
