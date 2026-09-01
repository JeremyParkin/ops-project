"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { RecordFieldFormState } from "@/app/actions";
import { ChoicePill } from "@/app/components/choice-pill";
import type { ChoiceOption, FieldDefinition, FieldValue } from "@/lib/domain/types";

type UpdateFieldAction = (
  state: RecordFieldFormState,
  formData: FormData,
) => Promise<RecordFieldFormState>;

type EditableTableCellProps = {
  field: FieldDefinition;
  value: FieldValue | undefined;
  displayValue: string;
  recordEditHref: string;
  updateFieldAction: UpdateFieldAction;
  // Choice only: active options for the dropdown, plus the record's own
  // current option even if archived (see EditableCellForm) so an
  // already-selected archived value doesn't just disappear from the
  // control -- ignored by every other field type.
  choiceOptions?: ChoiceOption[];
};

const initialFieldState: RecordFieldFormState = {
  success: false,
  message: "",
  value: "",
};

function toDefaultInputValue(field: FieldDefinition, value: FieldValue | undefined) {
  if (field.type === "boolean") {
    return value === true;
  }

  return value === null || value === undefined ? "" : String(value);
}

export function EditableTableCell({
  field,
  value,
  displayValue,
  recordEditHref,
  updateFieldAction,
  choiceOptions = [],
}: EditableTableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editSessionId, setEditSessionId] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);

  useEffect(() => {
    if (!isEditing && returnFocusRef.current) {
      triggerRef.current?.focus();
      returnFocusRef.current = false;
    }
  }, [isEditing]);

  function openEditor() {
    setEditSessionId((id) => id + 1);
    setIsEditing(true);
  }

  function closeEditor(options: { returnFocus: boolean }) {
    returnFocusRef.current = options.returnFocus;
    setIsEditing(false);
  }

  if (!isEditing) {
    const currentChoiceOption =
      field.type === "choice" && typeof value === "string"
        ? choiceOptions.find((option) => option.id === value)
        : undefined;

    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={openEditor}
        className="block w-full min-w-[6rem] rounded-sm px-1 py-0.5 text-left hover:bg-slate-50 focus-visible:bg-slate-50"
        aria-label={`Edit ${field.name}`}
      >
        {currentChoiceOption ? <ChoicePill option={currentChoiceOption} /> : displayValue}
      </button>
    );
  }

  return (
    <EditableCellForm
      key={editSessionId}
      field={field}
      value={value}
      recordEditHref={recordEditHref}
      updateFieldAction={updateFieldAction}
      choiceOptions={choiceOptions}
      onClose={closeEditor}
    />
  );
}

type EditableCellFormProps = {
  field: FieldDefinition;
  value: FieldValue | undefined;
  recordEditHref: string;
  updateFieldAction: UpdateFieldAction;
  choiceOptions: ChoiceOption[];
  onClose: (options: { returnFocus: boolean }) => void;
};

function EditableCellForm({
  field,
  value,
  recordEditHref,
  updateFieldAction,
  choiceOptions,
  onClose,
}: EditableCellFormProps) {
  const [state, formAction, pending] = useActionState(
    updateFieldAction,
    initialFieldState,
  );
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const domId = useId();
  const errorId = `${domId}-error`;
  // Active options for new selection, plus the record's own current option
  // even if archived -- so an already-selected archived value stays
  // visible/selected in the dropdown rather than silently disappearing.
  const currentOption =
    field.type === "choice" && typeof value === "string"
      ? choiceOptions.find((option) => option.id === value)
      : undefined;
  const selectableChoiceOptions =
    currentOption?.archivedAt
      ? [currentOption, ...choiceOptions.filter((option) => !option.archivedAt)]
      : choiceOptions.filter((option) => !option.archivedAt);

  useEffect(() => {
    inputRef.current?.focus();

    if (field.type !== "boolean" && field.type !== "choice" && inputRef.current) {
      (inputRef.current as HTMLInputElement).select();
    }
    // Runs once, when this edit session mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.success) {
      router.refresh();
      onClose({ returnFocus: false });
    }
    // onClose is stable enough for this effect's purpose; re-running it on
    // every parent render would fight the edit-session remount strategy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, router]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose({ returnFocus: true });
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  function handleBlur(event: FocusEvent<HTMLInputElement | HTMLSelectElement>) {
    const nextTarget = event.relatedTarget as Node | null;

    if (nextTarget && formRef.current?.contains(nextTarget)) {
      return;
    }

    onClose({ returnFocus: false });
  }

  const fieldError = !state.blocked ? state.message : undefined;

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="fieldKey" value={field.key} />
      <div className="flex items-center gap-2">
        {field.type === "boolean" ? (
          <>
            <input type="hidden" name="value" value="false" />
            <input
              ref={inputRef as RefObject<HTMLInputElement>}
              id={domId}
              name="value"
              type="checkbox"
              value="true"
              defaultChecked={toDefaultInputValue(field, value) === true}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              aria-invalid={fieldError ? "true" : "false"}
              aria-describedby={fieldError ? errorId : undefined}
              className="h-4 w-4 border-slate-300 text-slate-950"
            />
          </>
        ) : field.type === "choice" ? (
          <select
            ref={inputRef as RefObject<HTMLSelectElement>}
            id={domId}
            name="value"
            defaultValue={toDefaultInputValue(field, value) as string}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            aria-invalid={fieldError ? "true" : "false"}
            aria-describedby={fieldError ? errorId : undefined}
            className="h-8 w-full min-w-[6rem] border border-slate-300 bg-white px-2 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            <option value="">Choose an option</option>
            {selectableChoiceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.archivedAt ? " (Archived)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={inputRef as RefObject<HTMLInputElement>}
            id={domId}
            name="value"
            type={field.type === "number" ? "text" : field.type}
            defaultValue={toDefaultInputValue(field, value) as string}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            aria-invalid={fieldError ? "true" : "false"}
            aria-describedby={fieldError ? errorId : undefined}
            className="h-8 w-full min-w-[6rem] border border-slate-300 px-2 text-sm text-slate-950 outline-none focus:border-slate-950"
          />
        )}
        <button
          type="submit"
          disabled={pending}
          className="text-xs font-medium text-slate-950 underline-offset-4 hover:underline disabled:text-slate-400"
        >
          {pending ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          disabled={pending}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onClose({ returnFocus: true })}
          className="text-xs font-medium text-slate-600 underline-offset-4 hover:underline disabled:text-slate-400"
        >
          Cancel
        </button>
      </div>
      {state.blocked ? (
        <p id={errorId} className="text-xs text-red-700" role="alert">
          {state.message}{" "}
          <Link href={recordEditHref} className="underline underline-offset-4">
            Open full edit
          </Link>
        </p>
      ) : fieldError ? (
        <p id={errorId} className="text-xs text-red-700" role="alert">
          {fieldError}
        </p>
      ) : null}
    </form>
  );
}
