"use client";

import { useActionState, useId } from "react";
import type { ChoiceOptionFormState } from "@/lib/domain/choice-option-validation";
import { createInitialChoiceOptionFormState } from "@/lib/domain/choice-option-validation";
import {
  CHOICE_OPTION_COLORS,
  CHOICE_OPTION_COLOR_LABELS,
  CHOICE_OPTION_SWATCH_CLASSES,
} from "@/lib/domain/choice-colors";
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
    <p className="mt-1 text-xs text-status-oxide" role="alert">
      {message}
    </p>
  );
}

// A native radio-per-swatch picker, not a select: same "optionColor" form
// field name and values as the select it replaces, so the server action and
// validateChoiceOptionFormData need no changes. Radios give keyboard
// support for free (arrow keys move within the group by `name`, independent
// of DOM adjacency) -- no JS behavior beyond ordinary form submission. Each
// swatch always pairs the color chip with its literal text label, so color
// is never the only carrier of which option is selected.
function ColorSwatchPicker({
  legendId,
  defaultValue,
}: {
  legendId: string;
  defaultValue: string;
}) {
  return (
    <div role="radiogroup" aria-labelledby={legendId} className="flex flex-wrap gap-1.5">
      <label className="flex cursor-pointer items-center gap-1.5 border border-grit px-2 py-1 text-xs text-stone has-[:checked]:border-graphite has-[:checked]:bg-chalk has-[:checked]:font-medium has-[:checked]:text-graphite has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brass">
        <input type="radio" name="optionColor" value="" defaultChecked={defaultValue === ""} className="sr-only" />
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-sm border border-dashed border-grit"
          aria-hidden="true"
        />
        No color
      </label>
      {CHOICE_OPTION_COLORS.map((color) => (
        <label
          key={color}
          className="flex cursor-pointer items-center gap-1.5 border border-grit px-2 py-1 text-xs text-stone has-[:checked]:border-graphite has-[:checked]:bg-chalk has-[:checked]:font-medium has-[:checked]:text-graphite has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brass"
        >
          <input
            type="radio"
            name="optionColor"
            value={color}
            defaultChecked={defaultValue === color}
            className="sr-only"
          />
          <span
            className={`h-3.5 w-3.5 shrink-0 rounded-sm border ${CHOICE_OPTION_SWATCH_CLASSES[color]}`}
            aria-hidden="true"
          />
          {CHOICE_OPTION_COLOR_LABELS[color]}
        </label>
      ))}
    </div>
  );
}

function AddOptionForm({ addOptionAction }: { addOptionAction: OptionFormAction }) {
  const [state, formAction, pending] = useActionState(
    addOptionAction,
    createInitialChoiceOptionFormState(),
  );
  const domId = useId();
  const colorLegendId = `${domId}-color-legend`;

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2 border-t border-grit pt-3">
      <div>
        <label htmlFor="new-option-label" className="block text-xs font-medium text-stone">
          New option
        </label>
        <input
          id="new-option-label"
          name="optionLabel"
          key={state.success ? "reset" : "value"}
          defaultValue={state.success ? "" : state.values.label}
          className="mt-1 h-8 border border-grit px-2 text-sm text-graphite"
          placeholder="Label"
        />
        <FieldError message={state.errors.optionLabel} />
      </div>
      <div>
        <span id={colorLegendId} className="block text-xs font-medium text-stone">
          Color
        </span>
        <div className="mt-1">
          <ColorSwatchPicker
            legendId={colorLegendId}
            defaultValue={state.success ? "" : state.values.color}
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="h-8 border border-grit px-3 text-xs font-medium text-stone disabled:text-grit"
      >
        {pending ? "Adding..." : "Add Option"}
      </button>
      {state.message ? (
        <p
          className={`text-xs ${state.success ? "text-status-sage" : "text-status-oxide"}`}
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
  const domId = useId();
  const colorLegendId = `${domId}-color-legend`;

  if (option.archivedAt) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border border-grit bg-chalk px-3 py-2">
        <span className="text-sm text-stone line-through decoration-grit">
          {option.label}
        </span>
        {restoreAction ? (
          <form action={restoreFormAction}>
            <button
              type="submit"
              disabled={restorePending}
              className="h-8 border border-grit bg-white px-3 text-xs font-medium text-stone disabled:text-grit"
            >
              {restorePending ? "Restoring..." : "Restore"}
            </button>
            {restoreState.message ? (
              <span className={`ml-2 text-xs ${restoreState.success ? "text-status-sage" : "text-status-oxide"}`}>
                {restoreState.message}
              </span>
            ) : null}
          </form>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-2 border border-grit p-3">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`option-label-${option.id}`} className="block text-xs font-medium text-stone">
            Label
          </label>
          <input
            id={`option-label-${option.id}`}
            name="optionLabel"
            defaultValue={state.values.label}
            className="mt-1 h-8 border border-grit px-2 text-sm text-graphite"
          />
          <FieldError message={state.errors.optionLabel} />
        </div>
        <div>
          <span id={colorLegendId} className="block text-xs font-medium text-stone">
            Color
          </span>
          <div className="mt-1">
            <ColorSwatchPicker legendId={colorLegendId} defaultValue={state.values.color} />
          </div>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="h-8 border border-grit px-3 text-xs font-medium text-stone disabled:text-grit"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </form>
      {state.message ? (
        <p
          className={`text-xs ${state.success ? "text-status-sage" : "text-status-oxide"}`}
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
              className="h-8 border border-grit px-2 text-xs disabled:text-grit"
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
              className="h-8 border border-grit px-2 text-xs disabled:text-grit"
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
              className="h-8 border border-grit px-3 text-xs font-medium text-stone disabled:text-grit"
            >
              {archivePending ? "Archiving..." : "Archive"}
            </button>
          </form>
        ) : null}
        {moveMessage ? (
          <span className={`text-xs ${moveSuccess ? "text-status-sage" : "text-status-oxide"}`}>
            {moveMessage}
          </span>
        ) : null}
        {archiveState.message ? (
          <span className={`text-xs ${archiveState.success ? "text-status-sage" : "text-status-oxide"}`}>
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
    <div className="grid gap-2 border-t border-grit pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone">Options</h3>
      {orderedRows.length === 0 ? (
        <p className="text-sm text-stone">No options yet.</p>
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
