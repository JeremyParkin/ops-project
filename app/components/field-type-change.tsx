"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
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
const fieldTypePanelOpenEvent = "field-type-change-panel-open";

type FieldTypeChangeProps = {
  field: FieldDefinition;
  relatedEntityName?: string;
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
  relatedEntityName,
  entityTypes,
  checkPreflightAction,
  changeTypeAction,
}: FieldTypeChangeProps) {
  const panelId = `field-type-change-panel-${field.id}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [preflightTransitionPending, startPreflightTransition] = useTransition();
  const [changeTransitionPending, startChangeTransition] = useTransition();
  const [preflightState, runPreflight, preflightPending] = useActionState(
    checkPreflightAction,
    initialFieldTypeChangePreflightState,
  );
  const [changeState, runChange, changePending] = useActionState(changeTypeAction, {
    success: false,
    message: "",
  });
  const availableTypes = (Object.keys(fieldTypeLabel) as FieldType[]).filter(
    (type) => type !== field.type,
  );
  const [selectedType, setSelectedType] = useState<FieldType>(availableTypes[0]);
  const checking = preflightPending || preflightTransitionPending;
  const changing = changePending || changeTransitionPending;
  const typeDescription = `${fieldTypeLabel[field.type]}${
    field.type === "relation" && relatedEntityName ? ` to ${relatedEntityName}` : ""
  }`;

  useEffect(() => {
    function closeWhenAnotherPanelOpens(event: Event) {
      if (!(event instanceof CustomEvent) || event.detail?.fieldId === field.id) {
        return;
      }

      setOpen(false);
    }

    window.addEventListener(fieldTypePanelOpenEvent, closeWhenAnotherPanelOpens);

    return () => {
      window.removeEventListener(fieldTypePanelOpenEvent, closeWhenAnotherPanelOpens);
    };
  }, [field.id]);

  function openAndCheck() {
    window.dispatchEvent(
      new CustomEvent(fieldTypePanelOpenEvent, {
        detail: { fieldId: field.id },
      }),
    );
    setOpen(true);
    startPreflightTransition(() => {
      runPreflight(new FormData());
    });
  }

  function closePanel() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function submitChange() {
    const formData = new FormData();
    formData.set("newType", selectedType);

    if (selectedType === "relation") {
      const relatedSelect = document.getElementById(
        `field-new-related-${field.id}`,
      ) as HTMLSelectElement | null;
      formData.set("newRelatedEntityTypeId", relatedSelect?.value ?? "");
    }

    startChangeTransition(() => {
      runChange(formData);
    });
  }

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          closePanel();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Change type for ${field.name}, currently ${fieldTypeLabel[field.type]}.`}
        title={`Change type for ${field.name}`}
        onClick={() => {
          if (open) {
            closePanel();
          } else {
            openAndCheck();
          }
        }}
        className="field-type-chip inline-flex max-w-full items-center px-2.5 py-1 text-sm font-medium text-slate-700 outline-none ring-offset-2 hover:border-slate-400 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-slate-950"
      >
        {typeDescription}
      </button>

      {open ? (
        <div
          id={panelId}
          className="field-type-change-panel absolute left-0 z-20 mt-2 w-[min(26rem,calc(100vw-2rem))] border border-slate-200 bg-white p-3 shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-slate-500">Current type</p>
              <p className="text-sm font-semibold text-slate-950">{typeDescription}</p>
            </div>
            <button
              type="button"
              onClick={closePanel}
              className="inline-flex h-7 w-7 items-center justify-center border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
              aria-label="Close type change panel"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>

          <div className="mt-3">
            <label
              htmlFor={`field-new-type-${field.id}`}
              className="block text-xs font-medium text-slate-700"
            >
              Destination type
            </label>
            <select
              id={`field-new-type-${field.id}`}
              name="newType"
              value={selectedType}
              onChange={(event) => setSelectedType(event.currentTarget.value as FieldType)}
              className="mt-1 block h-9 w-full border border-slate-300 bg-white px-2 text-sm text-slate-950 outline-none focus:border-slate-950"
            >
              {availableTypes.map((type) => (
                <option key={type} value={type}>
                  {fieldTypeLabel[type]}
                </option>
              ))}
            </select>
          </div>

          {selectedType === "relation" ? (
            <div className="mt-3">
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
                className="mt-1 block h-9 w-full border border-slate-300 bg-white px-2 text-sm text-slate-950 outline-none focus:border-slate-950"
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

          <div className="mt-3 border-t border-slate-100 pt-3">
            {checking ? (
              <p className="text-sm text-slate-600" role="status">
                Checking dependencies...
              </p>
            ) : !preflightState.checked ? (
              <p className="text-sm text-slate-600">Open this panel to check availability.</p>
            ) : !preflightState.success ? (
              <p className="text-sm text-red-700" role="alert">
                {preflightState.message}
              </p>
            ) : !preflightState.pristine ? (
              <div className="text-sm text-slate-700" role="alert">
                <p className="font-medium text-slate-950">Change unavailable</p>
                <p className="mt-1">{preflightState.message}</p>
              </div>
            ) : (
              <div className="text-sm text-slate-700">
                <p className="font-medium text-slate-950">Change available</p>
                {preflightState.dependencies?.viewColumnReferenceCount ? (
                  <p className="mt-1">
                    Table column references will be preserved.
                  </p>
                ) : (
                  <p className="mt-1">No blocking dependencies were found.</p>
                )}
              </div>
            )}
          </div>

          {changeState.success ? (
            <p className="mt-3 text-sm text-emerald-700" role="status">
              {changeState.message}
            </p>
          ) : changeState.message ? (
            <p className="mt-3 text-sm text-red-700" role="alert">
              {changeState.message}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={closePanel}
              className="inline-flex h-9 items-center justify-center border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!preflightState.checked || !preflightState.success || !preflightState.pristine || changing}
              onClick={submitChange}
              className="inline-flex h-9 items-center justify-center border border-slate-950 px-3 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
            >
              {changing ? "Changing..." : "Change type"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
