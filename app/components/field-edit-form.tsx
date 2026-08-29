"use client";

import { useActionState } from "react";
import type { FieldLifecycleActionState } from "@/app/actions";
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
  archiveFieldAction: (
    state: FieldLifecycleActionState,
    formData: FormData,
  ) => Promise<FieldLifecycleActionState>;
  restoreFieldAction: (
    state: FieldLifecycleActionState,
    formData: FormData,
  ) => Promise<FieldLifecycleActionState>;
  deleteFieldAction: (
    state: FieldLifecycleActionState,
    formData: FormData,
  ) => Promise<FieldLifecycleActionState>;
  moveFieldUpAction: (
    state: FieldLifecycleActionState,
    formData: FormData,
  ) => Promise<FieldLifecycleActionState>;
  moveFieldDownAction: (
    state: FieldLifecycleActionState,
    formData: FormData,
  ) => Promise<FieldLifecycleActionState>;
  isFirst: boolean;
  isLast: boolean;
  workflowReferenceCount: number;
  viewReferenceCount: number;
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
  archiveFieldAction,
  restoreFieldAction,
  deleteFieldAction,
  moveFieldUpAction,
  moveFieldDownAction,
  isFirst,
  isLast,
  workflowReferenceCount,
  viewReferenceCount,
}: FieldEditFormProps) {
  const [state, formAction, pending] = useActionState(
    updateFieldDefinitionAction,
    createInitialFieldEditFormState(field),
  );
  const [archiveState, archiveAction, archivePending] = useActionState(
    archiveFieldAction,
    {
      success: false,
      message: "",
    },
  );
  const [restoreState, restoreAction, restorePending] = useActionState(
    restoreFieldAction,
    {
      success: false,
      message: "",
    },
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteFieldAction,
    {
      success: false,
      message: "",
    },
  );
  const [moveUpState, moveUpAction, moveUpPending] = useActionState(
    moveFieldUpAction,
    {
      success: false,
      message: "",
    },
  );
  const [moveDownState, moveDownAction, moveDownPending] = useActionState(
    moveFieldDownAction,
    {
      success: false,
      message: "",
    },
  );
  const moveMessage = moveUpState.message || moveDownState.message;
  const moveSuccess = moveUpState.message ? moveUpState.success : moveDownState.success;
  const statusState = field.archivedAt
    ? deleteState.message
      ? deleteState
      : restoreState
    : archiveState.message
      ? archiveState
      : state;
  const typeDescription = `${fieldTypeLabel[field.type]}${
    field.type === "relation" && relatedEntityName
      ? ` to ${relatedEntityName}`
      : ""
  }`;

  if (field.archivedAt) {
    return (
      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-950">{field.name}</p>
            <span className="border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
              Archived
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {typeDescription}
            {field.required ? " · Required" : " · Optional"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Archived fields are hidden from normal forms, tables, and new workflow
            configuration.
          </p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <form action={restoreAction}>
            <button
              type="submit"
              disabled={restorePending}
              className="inline-flex h-10 items-center justify-center border border-slate-300 px-4 text-sm font-medium text-slate-800 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {restorePending ? "Restoring..." : "Restore"}
            </button>
          </form>
          <form
            action={deleteAction}
            onSubmit={(event) => {
              if (
                !window.confirm(
                  "Permanently delete this archived field? This cannot be undone.",
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            <button
              type="submit"
              disabled={deletePending}
              className="inline-flex h-10 items-center justify-center border border-red-700 px-4 text-sm font-medium text-red-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
            >
              {deletePending ? "Deleting..." : "Delete"}
            </button>
          </form>
        </div>
        {statusState.message ? (
          <p
            className={`md:col-span-2 text-sm ${
              statusState.success ? "text-emerald-700" : "text-red-700"
            }`}
            role="status"
          >
            {statusState.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
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
          <p className="mt-2 text-sm text-slate-800">{typeDescription}</p>
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
      <div className="flex flex-wrap items-center gap-2">
        <form action={moveUpAction}>
          <button
            type="submit"
            disabled={isFirst || moveUpPending}
            className="inline-flex h-9 items-center justify-center border border-slate-300 px-3 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Move Up
          </button>
        </form>
        <form action={moveDownAction}>
          <button
            type="submit"
            disabled={isLast || moveDownPending}
            className="inline-flex h-9 items-center justify-center border border-slate-300 px-3 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Move Down
          </button>
        </form>
        {moveMessage ? (
          <p
            className={`text-sm ${moveSuccess ? "text-emerald-700" : "text-red-700"}`}
            role="status"
          >
            {moveMessage}
          </p>
        ) : null}
      </div>
      <form
        action={archiveAction}
        onSubmit={(event) => {
          if (workflowReferenceCount === 0 && viewReferenceCount === 0) {
            return;
          }

          const workflowText =
            workflowReferenceCount === 1 ? "1 workflow" : `${workflowReferenceCount} workflows`;
          const viewText =
            viewReferenceCount === 1 ? "1 saved view" : `${viewReferenceCount} saved views`;
          const references = [
            workflowReferenceCount > 0 ? workflowText : "",
            viewReferenceCount > 0 ? viewText : "",
          ]
            .filter(Boolean)
            .join(" and ");

          if (
            !window.confirm(
              `This field is used by ${references}. Archiving it will make those configurations invalid until repaired. Archive anyway?`,
            )
          ) {
            event.preventDefault();
          }
        }}
      >
        <button
          type="submit"
          disabled={archivePending}
          className="inline-flex h-10 w-fit items-center justify-center border border-slate-300 px-4 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          {archivePending ? "Archiving..." : "Archive Field"}
        </button>
      </form>
      {archiveState.message ? (
        <p
          className={`text-sm ${
            archiveState.success ? "text-emerald-700" : "text-red-700"
          }`}
          role="status"
        >
          {archiveState.message}
        </p>
      ) : null}
    </div>
  );
}
