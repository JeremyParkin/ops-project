"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { ChoiceOptionFormState } from "@/lib/domain/choice-option-validation";
import { createInitialChoiceOptionFormState } from "@/lib/domain/choice-option-validation";
import {
  CHOICE_OPTION_COLORS,
  CHOICE_OPTION_COLOR_LABELS,
  CHOICE_OPTION_SWATCH_CLASSES,
  isChoiceOptionColor,
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
  deleteAction?: LifecycleAction;
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
// of DOM adjacency) -- no JS behavior beyond ordinary form submission.
//
// Swatch-only, not chip+label: rendering every color as both a color chip
// and its full text label was the single biggest contributor to the
// new-option editor's height (dogfood, hosted verification after 139e7d6).
// Color is still never the *only* signal: every swatch keeps a literal
// accessible name (via aria-label on the input, since there's no visible
// text for the label to derive one from) plus a native `title` tooltip. The
// saved option row chip is the visible source of truth for current color;
// the picker only shows keyboard focus, not a persistent selected ring.
function ColorSwatchPicker({
  legendId,
  defaultValue,
  value,
  onColorChange,
}: {
  legendId: string;
  defaultValue: string;
  value?: string;
  onColorChange?: (color: string) => void;
}) {
  const isControlled = value !== undefined;
  const isChecked = (color: string) =>
    isControlled ? value === color : defaultValue === color;

  return (
    <div role="radiogroup" aria-labelledby={legendId} className="flex flex-wrap gap-1">
      <label
        title="No color"
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-dashed border-grit has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brass"
      >
        <input
          type="radio"
          name="optionColor"
          value=""
          checked={isControlled ? isChecked("") : undefined}
          defaultChecked={isControlled ? undefined : isChecked("")}
          onChange={() => onColorChange?.("")}
          aria-label="No color"
          className="sr-only"
        />
        <span aria-hidden="true" className="text-[10px] leading-none text-grit">
          ×
        </span>
      </label>
      {CHOICE_OPTION_COLORS.map((color) => (
        <label
          key={color}
          title={CHOICE_OPTION_COLOR_LABELS[color]}
          className={`h-6 w-6 shrink-0 cursor-pointer rounded-sm border ${CHOICE_OPTION_SWATCH_CLASSES[color]} has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brass`}
        >
          <input
            type="radio"
            name="optionColor"
            value={color}
            checked={isControlled ? isChecked(color) : undefined}
            defaultChecked={isControlled ? undefined : isChecked(color)}
            onChange={() => onColorChange?.(color)}
            aria-label={CHOICE_OPTION_COLOR_LABELS[color]}
            className="sr-only"
          />
        </label>
      ))}
    </div>
  );
}

function AddOptionForm({ addOptionAction }: { addOptionAction: OptionFormAction }) {
  const labelInputRef = useRef<HTMLInputElement>(null);
  const [state, formAction, pending] = useActionState(
    addOptionAction,
    createInitialChoiceOptionFormState(),
  );
  const [open, setOpen] = useState(false);
  const domId = useId();
  const colorLegendId = `${domId}-color-legend`;

  // Success confirmation is transient -- once shown beside the now-reset
  // "New option (unsaved)" editor it reads as contradictory state, unlike a
  // failure, which stays visible until the builder can see and fix it.
  // `hiddenForState` tracks *which* state object has already timed out,
  // rather than a plain boolean: since useActionState hands back a new
  // object reference on every completion, a fresh success is automatically
  // "not yet hidden" (no synchronous setState-on-mount/reset needed here --
  // only the deferred setTimeout callback below updates state).
  const [hiddenForState, setHiddenForState] = useState<typeof state | null>(null);
  useEffect(() => {
    if (!state.success || !state.message) {
      return;
    }
    const timer = setTimeout(() => setHiddenForState(state), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    if (open && state.success) {
      labelInputRef.current?.focus();
    }
  }, [open, state.success, state]);
  const showMessage = Boolean(state.message) && (!state.success || hiddenForState !== state);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          window.setTimeout(() => {
            labelInputRef.current?.focus();
          }, 0);
        }}
        className="flex h-9 items-center justify-center border border-dashed border-brass bg-chalk px-3 text-xs font-medium text-stone hover:bg-white"
      >
        + Add option
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="flex flex-wrap items-end gap-2 border border-dashed border-brass bg-chalk p-2"
    >
      <div>
        <label htmlFor="new-option-label" className="block text-xs font-medium text-stone">
          New option (unsaved)
        </label>
        <input
          ref={labelInputRef}
          id="new-option-label"
          name="optionLabel"
          key={state.success ? "reset" : "value"}
          autoFocus={state.success}
          defaultValue={state.success ? "" : state.values.label}
          className="mt-1 h-8 border border-grit bg-white px-2 text-sm text-graphite"
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
        className="h-8 border border-grit bg-white px-3 text-xs font-medium text-stone disabled:text-grit"
      >
        {pending ? "Saving..." : "Save option"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="h-8 border border-grit bg-white px-3 text-xs font-medium text-stone hover:bg-chalk"
      >
        Close
      </button>
      {showMessage ? (
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

function OptionRow({
  row,
  open,
  blockedByDirtySwitch,
  onToggleOpen,
  onDirtyChange,
  onArchiveSuccess,
}: {
  row: ChoiceOptionRowActions;
  open: boolean;
  blockedByDirtySwitch: boolean;
  onToggleOpen: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onArchiveSuccess: () => void;
}) {
  const { option, updateAction, archiveAction, restoreAction, deleteAction, moveUpAction, moveDownAction } = row;
  async function updateAndTrackDirty(
    formState: ChoiceOptionFormState,
    formData: FormData,
  ) {
    const nextState = await updateAction(formState, formData);
    if (nextState.success && formData.get("optionEditIntent") === "label") {
      onDirtyChange(false);
    }
    return nextState;
  }
  async function archiveAndClose(
    formState: FieldLifecycleActionState,
    formData: FormData,
  ) {
    const nextState = archiveAction ? await archiveAction(formState, formData) : formState;
    if (nextState.success) {
      onArchiveSuccess();
    }
    return nextState;
  }

  const [state, formAction, pending] = useActionState(
    updateAndTrackDirty,
    createInitialChoiceOptionFormState({ label: option.label, color: option.color ?? "" }),
  );
  const [archiveState, archiveFormAction, archivePending] = useActionState(
    archiveAndClose,
    { success: false, message: "" },
  );
  const [restoreState, restoreFormAction, restorePending] = useActionState(
    restoreAction ?? (async (s: FieldLifecycleActionState) => s),
    { success: false, message: "" },
  );
  const [deleteState, deleteFormAction, deletePending] = useActionState(
    deleteAction ?? (async (s: FieldLifecycleActionState) => s),
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
  const bodyId = `${domId}-body`;
  const colorFormRef = useRef<HTMLFormElement>(null);
  const currentLabel = state.values.label || option.label;
  const [selectedColor, setSelectedColor] = useState(state.values.color ?? option.color ?? "");

  if (option.archivedAt) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border border-grit bg-chalk px-3 py-2">
        <span className="text-sm text-stone line-through decoration-grit">
          {option.label}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {restoreAction ? (
            <form action={restoreFormAction}>
              <button
                type="submit"
                disabled={restorePending}
                className="h-8 border border-grit bg-white px-3 text-xs font-medium text-stone disabled:text-grit"
              >
                {restorePending ? "Restoring..." : "Restore"}
              </button>
            </form>
          ) : null}
          {deleteAction ? (
            <form
              action={deleteFormAction}
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    `Permanently delete "${option.label}"? This cannot be undone, and only succeeds if this option has never been used on a record, a saved view filter, or a Quality Review status designation.`,
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              <button
                type="submit"
                disabled={deletePending}
                className="h-8 border border-status-oxide bg-white px-3 text-xs font-medium text-status-oxide disabled:cursor-not-allowed disabled:border-grit disabled:text-grit"
              >
                {deletePending ? "Deleting..." : "Permanent delete"}
              </button>
            </form>
          ) : null}
        </div>
        {restoreState.message ? (
          <p className={`w-full text-xs ${restoreState.success ? "text-status-sage" : "text-status-oxide"}`}>
            {restoreState.message}
          </p>
        ) : null}
        {deleteState.message ? (
          <p className={`w-full text-xs ${deleteState.success ? "text-status-sage" : "text-status-oxide"}`}>
            {deleteState.message}
          </p>
        ) : null}
      </div>
    );
  }

  const swatchClass = isChoiceOptionColor(option.color)
    ? CHOICE_OPTION_SWATCH_CLASSES[option.color]
    : "border-dashed border-grit";

  return (
    <div className="contents">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={open}
        aria-controls={bodyId}
        aria-current={open ? "true" : undefined}
        data-active={open ? "true" : undefined}
        className="choice-option-tab relative z-0 inline-flex h-8 max-w-full items-center gap-1.5 border px-2 text-xs outline-none focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brass data-[active=true]:z-10 data-[active=true]:-mb-[2px]"
      >
        <span className={`h-3 w-3 shrink-0 rounded-sm border ${swatchClass}`} aria-hidden="true" />
        <span className="truncate">{option.label}</span>
      </button>
      {open ? (
        <div id={bodyId} className="choice-option-editor-panel order-last -mt-px grid basis-full gap-2 border p-3">
          <form action={formAction} className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`option-label-${option.id}`} className="block text-xs font-medium text-stone">
                Label
              </label>
              <input
                id={`option-label-${option.id}`}
                name="optionLabel"
                defaultValue={currentLabel}
                onChange={(event) => onDirtyChange(event.currentTarget.value !== currentLabel)}
                className="mt-1 h-8 border border-grit px-2 text-sm text-graphite"
              />
              <FieldError message={state.errors.optionLabel} />
            </div>
            <input type="hidden" name="optionEditIntent" value="label" />
            <input type="hidden" name="optionColor" value={selectedColor} />
            <button
              type="submit"
              disabled={pending}
              className="h-8 border border-grit px-3 text-xs font-medium text-stone disabled:text-grit"
            >
              {pending ? "Saving..." : "Save"}
            </button>
          </form>
          <form ref={colorFormRef} action={formAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="optionEditIntent" value="color" />
            <input type="hidden" name="optionLabel" value={currentLabel} />
            <div>
              <span id={colorLegendId} className="block text-xs font-medium text-stone">
                Color
              </span>
              <div className="mt-1">
                <ColorSwatchPicker
                  legendId={colorLegendId}
                  defaultValue={selectedColor}
                  value={selectedColor}
                  onColorChange={(color) => {
                    setSelectedColor(color);
                    window.setTimeout(() => {
                      colorFormRef.current?.requestSubmit();
                    }, 0);
                  }}
                />
              </div>
            </div>
          </form>
          {state.message ? (
            <p
              className={`text-xs ${state.success ? "text-status-sage" : "text-status-oxide"}`}
              role="status"
            >
              {state.message}
            </p>
          ) : null}
          {blockedByDirtySwitch ? (
            <p className="text-xs text-status-oxide" role="alert">
              Save or close this option before editing another.
            </p>
          ) : null}
          {archiveState.message ? (
            <p className={`text-xs ${archiveState.success ? "text-status-sage" : "text-status-oxide"}`}>
              {archiveState.message}
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
            {moveMessage ? (
              <span className={`text-xs ${moveSuccess ? "text-status-sage" : "text-status-oxide"}`}>
                {moveMessage}
              </span>
            ) : null}
            {archiveAction ? (
              <form action={archiveFormAction}>
                <button
                  type="submit"
                  disabled={archivePending}
                  className="h-8 border border-grit px-2 text-xs text-stone hover:bg-chalk disabled:text-grit"
                >
                  {archivePending ? "Archiving..." : "Archive"}
                </button>
              </form>
            ) : null}
          </div>
        </div>
      ) : null}
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
  const [openOptionId, setOpenOptionId] = useState<string | null>(null);
  const [dirtyOptionId, setDirtyOptionId] = useState<string | null>(null);
  const [blockedOptionId, setBlockedOptionId] = useState<string | null>(null);
  function toggleOption(optionId: string) {
    if (openOptionId === optionId) {
      setOpenOptionId(null);
      setDirtyOptionId((current) => (current === optionId ? null : current));
      setBlockedOptionId(null);
      return;
    }

    if (openOptionId && dirtyOptionId === openOptionId) {
      setBlockedOptionId(openOptionId);
      return;
    }

    setOpenOptionId(optionId);
    setBlockedOptionId(null);
  }

  // Archived options are hidden behind a disclosure by default, rather
  // than interleaved with active ones (dogfood): the active set is what
  // builders scan and maintain day to day, and an inactive option mixed
  // in with Restore/Archive controls made that harder to read. A native
  // <details> is safe here -- unlike the per-option row, its own summary
  // has no interactive controls; Restore/Permanent delete live in the
  // body, one level below the toggle.
  const activeRows = orderedRows.filter((row) => !row.option.archivedAt);
  const archivedRows = orderedRows.filter((row) => row.option.archivedAt);

  return (
    <div className="grid gap-2 pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone">Options</h3>
      {activeRows.length === 0 ? (
        <p className="text-sm text-stone">No options yet.</p>
      ) : (
        <div className="flex flex-wrap items-start gap-x-1.5 gap-y-0">
          {activeRows.map((row) => (
            <OptionRow
              key={row.option.id}
              row={row}
              open={openOptionId === row.option.id}
              blockedByDirtySwitch={blockedOptionId === row.option.id}
              onToggleOpen={() => toggleOption(row.option.id)}
              onDirtyChange={(dirty) => {
                setDirtyOptionId(dirty ? row.option.id : null);
                if (!dirty && blockedOptionId === row.option.id) {
                  setBlockedOptionId(null);
                }
              }}
              onArchiveSuccess={() => {
                setOpenOptionId((current) => (current === row.option.id ? null : current));
                setDirtyOptionId((current) => (current === row.option.id ? null : current));
                setBlockedOptionId((current) => (current === row.option.id ? null : current));
              }}
            />
          ))}
        </div>
      )}
      {archivedRows.length > 0 ? (
        <details className="group border border-grit [&::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-stone hover:bg-chalk">
            <span>Show archived options ({archivedRows.length})</span>
            <span
              aria-hidden="true"
              className="shrink-0 text-xs text-stone transition-transform group-open:rotate-90"
            >
              ▸
            </span>
          </summary>
          <div className="grid gap-2 border-t border-grit p-3">
            {archivedRows.map((row) => (
              <OptionRow
                key={row.option.id}
                row={row}
                open={openOptionId === row.option.id}
                blockedByDirtySwitch={blockedOptionId === row.option.id}
                onToggleOpen={() => toggleOption(row.option.id)}
              onDirtyChange={(dirty) => {
                setDirtyOptionId(dirty ? row.option.id : null);
                if (!dirty && blockedOptionId === row.option.id) {
                  setBlockedOptionId(null);
                }
              }}
              onArchiveSuccess={() => {
                setOpenOptionId((current) => (current === row.option.id ? null : current));
                setDirtyOptionId((current) => (current === row.option.id ? null : current));
                setBlockedOptionId((current) => (current === row.option.id ? null : current));
              }}
            />
            ))}
          </div>
        </details>
      ) : null}
      <AddOptionForm addOptionAction={addOptionAction} />
    </div>
  );
}
