"use client";

import { useActionState } from "react";
import type { FieldEditFormState } from "@/lib/domain/field-edit-validation";
import { createInitialFieldEditFormState } from "@/lib/domain/field-edit-validation";
import type { FieldDefinition } from "@/lib/domain/types";

type FieldEditFormProps = {
  field: FieldDefinition;
  relatedEntityName?: string;
  updateFieldDefinitionAction: (
    state: FieldEditFormState,
    formData: FormData,
  ) => Promise<FieldEditFormState>;
};

const fieldTypeLabel = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Boolean",
  relation: "Relation",
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

export function FieldEditForm({
  field,
  relatedEntityName,
  updateFieldDefinitionAction,
}: FieldEditFormProps) {
  const [state, formAction, pending] = useActionState(
    updateFieldDefinitionAction,
    createInitialFieldEditFormState(field),
  );

  return (
    <form
      action={formAction}
      className="grid gap-3 md:grid-cols-[1fr_auto_auto]"
    >
      <div>
        <label
          htmlFor={`field-edit-name-${field.id}`}
          className="block text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          Name
        </label>
        <input
          id={`field-edit-name-${field.id}`}
          name="fieldName"
          required
          defaultValue={state.values.name}
          className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
        />
        <FieldError message={state.errors.fieldName} />
      </div>

      <div className="min-w-36">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Type
        </p>
        <p className="mt-2 text-sm text-slate-800">
          {fieldTypeLabel[field.type]}
          {field.type === "relation" && relatedEntityName
            ? ` to ${relatedEntityName}`
            : ""}
        </p>
      </div>

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
          className="inline-flex h-10 items-center justify-center border border-slate-950 px-4 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </div>

      <div className="md:col-span-3">
        {state.message ? (
          <p
            className={`text-sm ${
              state.success ? "text-emerald-700" : "text-red-700"
            }`}
            role="status"
          >
            {state.message}
          </p>
        ) : null}
        <FieldError message={state.errors.fieldRequired} />
        <FieldError message={state.errors._form} />
      </div>
    </form>
  );
}
