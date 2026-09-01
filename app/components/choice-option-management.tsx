"use client";

import { useActionState } from "react";
import type { ChoiceOptionFormState } from "@/lib/domain/choice-option-validation";
import { createInitialChoiceOptionFormState } from "@/lib/domain/choice-option-validation";
import { CHOICE_OPTION_COLORS, CHOICE_OPTION_COLOR_LABELS } from "@/lib/domain/choice-colors";
import type { ChoiceOption } from "@/lib/domain/types";
import type { FieldLifecycleActionState } from "@/app/actions";

type OptionFormAction = (
  state: ChoiceOptionFormState,
  formData: FormData,
) => Promise<ChoiceOptionFormState>;
type LifecycleAction = (
  state: FieldLifecycleActionState,
  formData: FormData,
) => Promise<FieldLifecycleActionState>;

export type ChoiceOptionRowActions = {
  option: ChoiceOption;
  updateAction: OptionFormAction;
  archiveAction?: LifecycleAction;
  restoreAction?: LifecycleAction;
  moveUpAction?: LifecycleAction;
  moveDownAction?: LifecycleAction;
};

function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="mt-1 text-xs text-red-700" role="alert">
      {message}
    </p>
  );
}

function ColorSelect({
  id,
  defaultValue,
}: {
  id: string;
  defaultValue: string;
}) {
  return (
    <select
      id={id}
      name="optionColor"
      defaultValue={defaultValue}
      className="h-8 border border-slate-300 bg-white px-2 text-xs text-slate-950"
    >
      <option value="">No color</option>
      {CHOICE_OPTION_COLORS.map((color) => (
        <option key={color} value={color}>
          {CHOICE_OPTION_COLOR_LABELS[color]}
        </option>
      ))}
    </select>
  );
}

function AddOptionForm({ addOptionAction }: { addOptionAction: OptionFormAction }) {
  const [state, formAction, pending] = useActionState(
    addOptionAction,
    createInitialChoiceOptionFormState(),
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3">
      <div>
        <label htmlFor="new-option-label" className="block text-xs font-medium text-slate-600">
          New option
        </label>
        <input
          id="new-option-label"
          name="optionLabel"
          key={state.success ? "reset" : "value"}
          defaultValue={state.success ? "" : state.values.label}
          className="mt-1 h-8 border border-slate-300 px-2 text-sm text-slate-950"
          placeholder="Label"
        />
        <FieldError message={state.errors.optionLabel} />
      </div>
      <div>
        <label htmlFor="new-option-color" className="block text-xs font-medium text-slate-600">
          Color
        </label>
        <div className="mt-1">
          <ColorSelect id="new-option-color" defaultValue={state.success ? "" : state.values.color} />
        </div>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="h-8 border border-slate-300 px-3 text-xs font-medium text-slate-800 disabled:text-slate-400"
      >
        {pending ? "Adding..." : "Add Option"}
      </button>
      {state.message ? (
        <p
          className={`text-xs ${state.success ? "text-emerald-700" : "text-red-700"}`}
          role="status"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function OptionRow({ row }: { row: ChoiceOptionRowActions }) {
  const { option, updateAction, archiveAction, restoreAction, moveUpAction, moveDownAction } = row;
  const [state, formAction, pending] = useActionState(
    updateAction,
    createInitialChoiceOptionFormState({ label: option.label, color: option.color ?? "" }),
  );
  const [archiveState, archiveFormAction, archivePending] = useActionState(
    archiveAction ?? (async (s: FieldLifecycleActionState) => s),
    { success: false, message: "" },
  );
  const [restoreState, restoreFormAction, restorePending] = useActionState(
    restoreAction ?? (async (s: FieldLifecycleActionState) => s),
    { success: false, message: "" },
  );
  const [moveUpState, moveUpFormAction, moveUpPending] = useActionState(
    moveUpAction ?? (async (s: FieldLifecycleActionState) => s),
    { success: false, message: "" },
  );
  const [moveDownState, moveDownFormAction, moveDownPending] = useActionState(
    moveDownAction ?? (async (s: FieldLifecycleActionState) => s),
    { success: false, message: "" },
  );
  const moveMessage = moveUpState.message || moveDownState.message;
  const moveSuccess = moveUpState.message ? moveUpState.success : moveDownState.success;

  if (option.archivedAt) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-3 py-2">
        <span className="text-sm text-slate-500 line-through decoration-slate-400">
          {option.label}
        </span>
        {restoreAction ? (
          <form action={restoreFormAction}>
            <button
              type="submit"
              disabled={restorePending}
              className="h-8 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 disabled:text-slate-400"
            >
              {restorePending ? "Restoring..." : "Restore"}
            </button>
            {restoreState.message ? (
              <span className={`ml-2 text-xs ${restoreState.success ? "text-emerald-700" : "text-red-700"}`}>
                {restoreState.message}
              </span>
            ) : null}
          </form>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-2 border border-slate-200 p-3">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`option-label-${option.id}`} className="block text-xs font-medium text-slate-600">
            Label
          </label>
          <input
            id={`option-label-${option.id}`}
            name="optionLabel"
            defaultValue={state.values.label}
            className="mt-1 h-8 border border-slate-300 px-2 text-sm text-slate-950"
          />
          <FieldError message={state.errors.optionLabel} />
        </div>
        <div>
          <label htmlFor={`option-color-${option.id}`} className="block text-xs font-medium text-slate-600">
            Color
          </label>
          <div className="mt-1">
            <ColorSelect id={`option-color-${option.id}`} defaultValue={state.values.color} />
          </div>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="h-8 border border-slate-300 px-3 text-xs font-medium text-slate-800 disabled:text-slate-400"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </form>
      {state.message ? (
        <p
          className={`text-xs ${state.success ? "text-emerald-700" : "text-red-700"}`}
          role="status"
        >
          {state.message}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {moveUpAction ? (
          <form action={moveUpFormAction}>
            <button
              type="submit"
              disabled={moveUpPending}
              className="h-8 border border-slate-300 px-2 text-xs disabled:text-slate-400"
            >
              Up
            </button>
          </form>
        ) : null}
        {moveDownAction ? (
          <form action={moveDownFormAction}>
            <button
              type="submit"
              disabled={moveDownPending}
              className="h-8 border border-slate-300 px-2 text-xs disabled:text-slate-400"
            >
              Down
            </button>
          </form>
        ) : null}
        {archiveAction ? (
          <form action={archiveFormAction}>
            <button
              type="submit"
              disabled={archivePending}
              className="h-8 border border-slate-300 px-3 text-xs font-medium text-slate-700 disabled:text-slate-400"
            >
              {archivePending ? "Archiving..." : "Archive"}
            </button>
          </form>
        ) : null}
        {moveMessage ? (
          <span className={`text-xs ${moveSuccess ? "text-emerald-700" : "text-red-700"}`}>
            {moveMessage}
          </span>
        ) : null}
        {archiveState.message ? (
          <span className={`text-xs ${archiveState.success ? "text-emerald-700" : "text-red-700"}`}>
            {archiveState.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ChoiceOptionManagement({
  rows,
  addOptionAction,
}: {
  rows: ChoiceOptionRowActions[];
  addOptionAction: OptionFormAction;
}) {
  const orderedRows = [...rows].sort((left, right) => left.option.position - right.option.position);

  return (
    <div className="grid gap-2 border-t border-slate-200 pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Options</h3>
      {orderedRows.length === 0 ? (
        <p className="text-sm text-slate-500">No options yet.</p>
      ) : (
        <div className="grid gap-2">
          {orderedRows.map((row) => (
            <OptionRow key={row.option.id} row={row} />
          ))}
        </div>
      )}
      <AddOptionForm addOptionAction={addOptionAction} />
    </div>
  );
}
