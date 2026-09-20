"use client";

import { useActionState, useState } from "react";
import type {
  FieldTypeChangeActionState,
  FieldTypeChangePreflightState,
} from "@/lib/domain/field-type-change-validation";
import { initialFieldTypeChangePreflightState } from "@/lib/domain/field-type-change-validation";
import type { EntityType, FieldDefinition, FieldType } from "@/lib/domain/types";

const fieldTypeLabel: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Boolean",
  relation: "Relation",
  choice: "Choice",
  workspace_member: "Workspace Member",
};

type FieldTypeChangeProps = {
  field: FieldDefinition;
  // Active entity types only, same list/semantics as Add Field's own
  // Related object picker (app/components/field-create-form.tsx) -- an
  // archived object is never offered as a relation target.
  entityTypes: EntityType[];
  checkPreflightAction: (
    state: FieldTypeChangePreflightState,
    formData: FormData,
  ) => Promise<FieldTypeChangePreflightState>;
  changeTypeAction: (
    state: FieldTypeChangeActionState,
    formData: FormData,
  ) => Promise<FieldTypeChangeActionState>;
};

// Type is compact, read-only metadata everywhere else in this row (see
// field-edit-form.tsx) -- this is the one, explicit, secondary recovery
// affordance, deliberately not a general "edit" control. It never assumes
// a change is safe: the preflight always runs first and its result is
// what decides whether a type picker or a truthful blocked explanation
// renders, mirroring the backend's own "preflight is informational only,
// the mutation RPC re-checks authoritatively" split.
export function FieldTypeChange({
  field,
  entityTypes,
  checkPreflightAction,
  changeTypeAction,
}: FieldTypeChangeProps) {
  const [preflightState, runPreflight, preflightPending] = useActionState(
    checkPreflightAction,
    initialFieldTypeChangePreflightState,
  );
  const [changeState, submitChange, changePending] = useActionState(changeTypeAction, {
    success: false,
    message: "",
  });
  const availableTypes = (Object.keys(fieldTypeLabel) as FieldType[]).filter(
    (type) => type !== field.type,
  );
  const [selectedType, setSelectedType] = useState<FieldType>(availableTypes[0]);

  if (changeState.success) {
    return (
      <p className="text-xs text-emerald-700" role="status">
        {changeState.message}
      </p>
    );
  }

  if (!preflightState.checked) {
    return (
      <form action={runPreflight}>
        <button
          type="submit"
          disabled={preflightPending}
          className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
        >
          {preflightPending ? "Checking..." : "Change type…"}
        </button>
      </form>
    );
  }

  if (!preflightState.success) {
    return (
      <p className="text-xs text-red-700" role="alert">
        {preflightState.message}
      </p>
    );
  }

  if (!preflightState.pristine) {
    return (
      <p className="max-w-xs text-xs text-slate-600">{preflightState.message}</p>
    );
  }

  return (
    <form
      action={submitChange}
      onSubmit={(event) => {
        if (
          !window.confirm(
            `Change ${field.name}'s type to ${fieldTypeLabel[selectedType]}? This field has no data or configuration yet, so nothing will be migrated or lost.`,
          )
        ) {
          event.preventDefault();
        }
      }}
      className="field-type-change-panel flex flex-wrap items-end gap-2 border border-slate-200 p-2"
    >
      <div>
        <label
          htmlFor={`field-new-type-${field.id}`}
          className="block text-xs font-medium text-slate-700"
        >
          New type
        </label>
        <select
          id={`field-new-type-${field.id}`}
          name="newType"
          value={selectedType}
          onChange={(event) => setSelectedType(event.currentTarget.value as FieldType)}
          className="mt-1 block h-9 border border-slate-300 bg-white px-2 text-sm text-slate-950 outline-none focus:border-slate-950"
        >
          {availableTypes.map((type) => (
            <option key={type} value={type}>
              {fieldTypeLabel[type]}
            </option>
          ))}
        </select>
      </div>
      {selectedType === "relation" ? (
        <div>
          <label
            htmlFor={`field-new-related-${field.id}`}
            className="block text-xs font-medium text-slate-700"
          >
            Related object
          </label>
          <select
            id={`field-new-related-${field.id}`}
            name="newRelatedEntityTypeId"
            defaultValue=""
            className="mt-1 block h-9 border border-slate-300 bg-white px-2 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            <option value="">Choose an object</option>
            {entityTypes.map((entityType) => (
              <option key={entityType.id} value={entityType.id}>
                {entityType.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <button
        type="submit"
        disabled={changePending}
        className="inline-flex h-9 items-center justify-center border border-slate-950 px-3 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
      >
        {changePending ? "Changing..." : "Confirm"}
      </button>
      {changeState.message ? (
        <p className="w-full text-xs text-red-700" role="alert">
          {changeState.message}
        </p>
      ) : null}
    </form>
  );
}
