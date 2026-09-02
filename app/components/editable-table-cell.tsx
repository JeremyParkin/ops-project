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
import type { RelationRecordOption } from "@/lib/domain/record-repository";
import { linkifyText } from "@/lib/domain/text-linkification";

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
  // Relation only: active target records for the dropdown, plus this row's
  // own current target even if archived (see getRelationLookups'
  // currentRecords) -- ignored by every other field type.
  relationOptions?: RelationRecordOption[];
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
  relationOptions = [],
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
    // A linkified text value can't share a click target with "enter edit
    // mode" (see linkifyText) -- the link itself opens/navigates, and a
    // separate compact button is the only way into the edit flow.
    const linkified =
      field.type === "text" && typeof value === "string" && value !== ""
        ? linkifyText(value)
        : undefined;

    if (linkified && linkified.kind !== "plain") {
      return (
        <span className="flex min-w-[6rem] items-center gap-2 px-1 py-0.5">
          <a
            href={linkified.href}
            target={linkified.kind === "url" ? "_blank" : undefined}
            rel={linkified.kind === "url" ? "noopener noreferrer" : undefined}
            className="truncate underline-offset-4 hover:underline"
          >
            {linkified.text}
          </a>
          <button
            ref={triggerRef}
            type="button"
            onClick={openEditor}
            className="shrink-0 text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-950 hover:underline"
            aria-label={`Edit ${field.name}`}
          >
            Edit
          </button>
        </span>
      );
    }

    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={openEditor}
        className="block w-full min-w-[6rem] rounded-sm px-1 py-0.5 text-left hover:bg-slate-50 focus-visible:bg-slate-50"
        aria-label={`Edit ${field.name}`}
      >
        {currentChoiceOption ? (
          <ChoicePill option={currentChoiceOption} />
        ) : field.type === "relation" && displayValue !== "—" ? (
          <span className="inline-flex items-center border border-grit bg-chalk px-2 py-1 text-xs font-medium text-stone">
            {displayValue}
          </span>
        ) : (
          displayValue
        )}
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
      relationOptions={relationOptions}
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
  relationOptions: RelationRecordOption[];
  onClose: (options: { returnFocus: boolean }) => void;
};

function EditableCellForm({
  field,
  value,
  recordEditHref,
  updateFieldAction,
  choiceOptions,
  relationOptions,
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
  // relationOptions is fetched once per FIELD, not per row (see
  // getRelationLookups' currentRecords) -- it can carry an archived target
  // that some OTHER row currently references. Only surface an archived
  // entry here when it's this row's own current value; every other row
  // must never be able to newly assign an archived target.
  const selectableRelationOptions = relationOptions.filter(
    (option) => !option.archivedAt || option.value === value,
  );

  useEffect(() => {
    inputRef.current?.focus();

    if (
      field.type !== "boolean" &&
      field.type !== "choice" &&
      field.type !== "relation" &&
      inputRef.current
    ) {
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
        ) : field.type === "relation" ? (
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
            <option value="">Choose a record</option>
            {selectableRelationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
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
