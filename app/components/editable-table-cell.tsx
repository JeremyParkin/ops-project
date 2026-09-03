"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { RecordFieldFormState } from "@/app/actions";
import { ChoicePill } from "@/app/components/choice-pill";
import { ClampedText } from "@/app/components/clamped-text";
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

function toDefaultInputValue(value: FieldValue | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

// A small conventional pencil glyph. This project has no icon library and
// no prior icon component to reuse, so this is a plain, dependency-free
// inline SVG rather than a new package -- the only two call sites (below)
// are both in this file. `currentColor` lets it inherit whatever text-color
// state (default/hover) the surrounding button already has.
function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.5 2.5a1.5 1.5 0 0 1 2.121 2.121L5.5 12.75l-3.25.75.75-3.25 8.5-8.5z" />
    </svg>
  );
}

const ANCHORED_EDITOR_MARGIN = 8;
// Choice/Relation: a native <select> plus Save/Cancel doesn't need much
// room (280-320px). Text: a multiline <textarea> needs meaningfully more
// (360-480px) to be worth opening a popover for at all -- see
// EditableCellForm's field.type === "text" branch.
const ANCHORED_EDITOR_WIDTH_BY_TYPE: Partial<Record<FieldDefinition["type"], number>> = {
  choice: 300,
  relation: 300,
  text: 420,
};

// Choice/Relation/Text get their editor in a small viewport-anchored
// popover instead of squeezed into the cell -- a native <select> plus
// Save/Cancel doesn't fit a compact cell width without looking cramped
// (Relation is the more acute case, since record labels tend to run
// longer than option labels), and a single-line text input can only ever
// show a small fragment of a paragraph-length value while editing it.
//
// Deliberately minimal: no positioning library, no portal, no continuous
// re-tracking. Position is computed once, when the popover opens, by
// measuring its own rendered size to decide whether it fits below the
// trigger or needs to open above instead, then clamping horizontally to
// stay on-screen. If the page (or the table's own horizontally-scrolling
// wrapper) scrolls, or the window resizes, the popover simply closes
// rather than trying to chase the trigger around -- a closed editor next
// to a moved trigger is fine; a detached one floating over the wrong row
// is not.
function AnchoredEditorPopover({
  triggerRef,
  labelId,
  width,
  onRequestClose,
  children,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  labelId: string;
  width: number;
  onRequestClose: () => void;
  children: ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;

    if (!trigger || !popover) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();

    let left = triggerRect.left;
    if (left + width + ANCHORED_EDITOR_MARGIN > window.innerWidth) {
      left = Math.max(ANCHORED_EDITOR_MARGIN, window.innerWidth - width - ANCHORED_EDITOR_MARGIN);
    }

    let top = triggerRect.bottom + 4;
    const overflowsBelow =
      top + popoverRect.height + ANCHORED_EDITOR_MARGIN > window.innerHeight;
    if (overflowsBelow) {
      const above = triggerRect.top - popoverRect.height - 4;
      top = above >= ANCHORED_EDITOR_MARGIN ? above : ANCHORED_EDITOR_MARGIN;
    }

    setPosition({ top, left });
    // Position is computed once, from this popover instance's own
    // (stable) trigger/popover refs -- there is nothing meaningful to
    // recompute on a later render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleViewportChange() {
      onRequestClose();
    }

    // capture: true so this also catches scroll on the table's own
    // horizontally-scrolling wrapper, not just window-level scroll --
    // scroll events don't bubble, but they do propagate through the
    // capture phase up to window.
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    return () => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [onRequestClose]);

  return (
    // No visibility toggle for the pre-measurement pass: it renders
    // off-screen (still real, paintable content) rather than
    // visibility:hidden, specifically so EditableCellForm's own
    // focus-on-mount effect -- a passive effect, always scheduled to run
    // after this popover's position-measuring layout effect (and the
    // synchronous re-render it triggers) has already settled and
    // painted -- lands on an element the browser actually considers
    // focusable at that point. visibility:hidden would silently no-op
    // that focus() call even once the element later becomes visible,
    // since the effect that calls it only runs once, on mount.
    <div
      ref={popoverRef}
      role="group"
      aria-labelledby={labelId}
      style={{
        position: "fixed",
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        width,
      }}
      className="z-30 border border-grit bg-white p-3 shadow-md"
    >
      {children}
    </div>
  );
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
  const popoverLabelId = useId();

  useEffect(() => {
    if (!isEditing && returnFocusRef.current) {
      triggerRef.current?.focus();
      returnFocusRef.current = false;
    }
  }, [isEditing]);

  function openEditor() {
    if (isEditing) {
      return;
    }
    setEditSessionId((id) => id + 1);
    setIsEditing(true);
  }

  function closeEditor(options: { returnFocus: boolean }) {
    returnFocusRef.current = options.returnFocus;
    setIsEditing(false);
  }

  const usesAnchoredEditor =
    field.type === "choice" || field.type === "relation" || field.type === "text";
  const anchoredEditorWidth = ANCHORED_EDITOR_WIDTH_BY_TYPE[field.type] ?? 300;

  const currentChoiceOption =
    field.type === "choice" && typeof value === "string"
      ? choiceOptions.find((option) => option.id === value)
      : undefined;
  // A linkified text value can't share a click target with "enter edit
  // mode" (see linkifyText) -- the link itself opens/navigates, and a
  // separate compact pencil button is the only way into the edit flow.
  const linkified =
    field.type === "text" && typeof value === "string" && value !== ""
      ? linkifyText(value)
      : undefined;

  function renderTrigger() {
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
            aria-haspopup="true"
            aria-expanded={isEditing}
            className="shrink-0 text-stone hover:text-graphite"
            aria-label={`Edit ${field.name}`}
            title={`Edit ${field.name}`}
          >
            <PencilIcon />
          </button>
        </span>
      );
    }

    // Ordinary long text (not linkified) clamps to 2 lines with its own
    // "More"/"Less" toggle -- that control can't share a click target with
    // "enter edit mode" any more than the linkified case above can, so the
    // edit trigger is again a separate sibling, not the clamped text
    // itself.
    if (field.type === "text" && typeof value === "string" && value !== "") {
      return (
        <span className="flex min-w-[6rem] items-start gap-2 px-1 py-0.5">
          <ClampedText text={value} className="max-w-xs" />
          <button
            ref={triggerRef}
            type="button"
            onClick={openEditor}
            aria-haspopup="true"
            aria-expanded={isEditing}
            className="shrink-0 text-stone hover:text-graphite"
            aria-label={`Edit ${field.name}`}
            title={`Edit ${field.name}`}
          >
            <PencilIcon />
          </button>
        </span>
      );
    }

    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={openEditor}
        aria-haspopup={usesAnchoredEditor ? "true" : undefined}
        aria-expanded={usesAnchoredEditor ? isEditing : undefined}
        aria-label={`Edit ${field.name}`}
        className="group block w-full min-w-[6rem] rounded-sm px-1 py-0.5 text-left hover:bg-chalk focus-visible:bg-chalk"
      >
        {currentChoiceOption ? (
          <ChoicePill
            option={currentChoiceOption}
            className="group-hover:ring-2 group-hover:ring-grit group-focus-visible:ring-2 group-focus-visible:ring-brass"
          />
        ) : field.type === "relation" && displayValue !== "—" ? (
          <span className="inline-flex items-center rounded-sm border border-grit bg-chalk px-2 py-1 text-xs font-medium text-stone group-hover:ring-2 group-hover:ring-grit group-focus-visible:ring-2 group-focus-visible:ring-brass">
            {displayValue}
          </span>
        ) : (
          displayValue
        )}
      </button>
    );
  }

  if (!isEditing) {
    return renderTrigger();
  }

  if (usesAnchoredEditor) {
    return (
      <>
        {renderTrigger()}
        <AnchoredEditorPopover
          triggerRef={triggerRef}
          labelId={popoverLabelId}
          width={anchoredEditorWidth}
          onRequestClose={() => closeEditor({ returnFocus: true })}
        >
          <EditableCellForm
            key={editSessionId}
            field={field}
            value={value}
            recordEditHref={recordEditHref}
            updateFieldAction={updateFieldAction}
            choiceOptions={choiceOptions}
            relationOptions={relationOptions}
            onClose={closeEditor}
            layout="popover"
            headingId={popoverLabelId}
          />
        </AnchoredEditorPopover>
      </>
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
      layout="inline"
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
  // "inline" (number/date/boolean) swaps the trigger for the form in
  // place, in the existing compact cell-width layout. "popover" (choice/
  // relation/text, see AnchoredEditorPopover above) gets a field-name
  // heading, a full-width control, and roomier, clearly-separated
  // Save/Cancel buttons instead of bare text links.
  layout: "inline" | "popover";
  headingId?: string;
};

// Matches the selected-state treatment already established for the Choice
// option color swatch picker (choice-option-management.tsx): a visually-
// hidden native radio, a visible text label, and a `has-[:checked]`
// selected-state ring -- reused here rather than inventing a second
// compact-control visual language.
const RADIO_CHIP_CLASSES =
  "flex cursor-pointer items-center rounded-sm border border-grit px-2 py-1 text-xs text-stone has-[:checked]:border-graphite has-[:checked]:bg-chalk has-[:checked]:font-medium has-[:checked]:text-graphite has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-brass";

function EditableCellForm({
  field,
  value,
  recordEditHref,
  updateFieldAction,
  choiceOptions,
  relationOptions,
  onClose,
  layout,
  headingId,
}: EditableCellFormProps) {
  const [state, formAction, pending] = useActionState(
    updateFieldAction,
    initialFieldState,
  );
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null);
  const domId = useId();
  const errorId = `${domId}-error`;
  const isPopover = layout === "popover";
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
      (inputRef.current as HTMLInputElement | HTMLTextAreaElement).select();
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

  // The multiline text control (below) only wires this, not handleKeyDown
  // above -- Enter has to insert a newline there, the way any ordinary
  // multiline field works, rather than submitting the form. Save is an
  // explicit button click for text; Escape still cancels either way.
  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose({ returnFocus: true });
    }
  }

  function handleBlur(event: FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    const nextTarget = event.relatedTarget as Node | null;

    if (nextTarget && formRef.current?.contains(nextTarget)) {
      return;
    }

    onClose({ returnFocus: false });
  }

  const fieldError = !state.blocked ? state.message : undefined;
  const isUnset = value === null || value === undefined;

  const control =
    field.type === "boolean" ? (
      // Direct manipulation of a tiny fixed value set (Unset/Yes/No), not
      // a dropdown -- native radios, submitting the same ""/"true"/"false"
      // contract every other optional field already clears/sets through
      // (parseFieldValue treats an empty "value" as "unset this optional
      // field" uniformly across field types, so this needed no validation
      // changes). Unset is omitted entirely for a required field, matching
      // that same validation (an empty submission on a required field is
      // rejected) rather than offering a choice that can only ever error.
      <div
        role="radiogroup"
        aria-label={field.name}
        aria-invalid={fieldError ? "true" : "false"}
        aria-describedby={fieldError ? errorId : undefined}
        className="flex flex-wrap gap-1.5"
      >
        {!field.required ? (
          <label className={RADIO_CHIP_CLASSES}>
            <input
              ref={(element) => {
                if (isUnset) {
                  inputRef.current = element;
                }
              }}
              type="radio"
              name="value"
              value=""
              defaultChecked={isUnset}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              className="sr-only"
            />
            Unset
          </label>
        ) : null}
        <label className={RADIO_CHIP_CLASSES}>
          <input
            ref={(element) => {
              if (value === true) {
                inputRef.current = element;
              }
            }}
            type="radio"
            name="value"
            value="true"
            defaultChecked={value === true}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className="sr-only"
          />
          Yes
        </label>
        <label className={RADIO_CHIP_CLASSES}>
          <input
            ref={(element) => {
              if (value === false) {
                inputRef.current = element;
              }
            }}
            type="radio"
            name="value"
            value="false"
            defaultChecked={value === false}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className="sr-only"
          />
          No
        </label>
      </div>
    ) : field.type === "choice" ? (
      <select
        ref={inputRef as RefObject<HTMLSelectElement>}
        id={domId}
        name="value"
        defaultValue={toDefaultInputValue(value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        aria-invalid={fieldError ? "true" : "false"}
        aria-describedby={fieldError ? errorId : undefined}
        className="h-8 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-graphite"
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
        defaultValue={toDefaultInputValue(value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        aria-invalid={fieldError ? "true" : "false"}
        aria-describedby={fieldError ? errorId : undefined}
        className="h-8 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-graphite"
      >
        <option value="">Choose a record</option>
        {selectableRelationOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ) : field.type === "text" ? (
      // Always the larger popover editor for now (see the "Do not infer
      // editor type from string length" note above this component) --
      // every text field, short or long, gets a multiline textarea rather
      // than guessing from the current value. rows sets a sensible initial
      // height (~6 lines); resize-y is the entire "allow vertical growth"
      // story here -- the browser's own native resize handle, not custom
      // autosizing logic.
      <textarea
        ref={inputRef as RefObject<HTMLTextAreaElement>}
        id={domId}
        name="value"
        rows={6}
        defaultValue={toDefaultInputValue(value)}
        onKeyDown={handleTextareaKeyDown}
        onBlur={handleBlur}
        aria-invalid={fieldError ? "true" : "false"}
        aria-describedby={fieldError ? errorId : undefined}
        className="w-full resize-y border border-grit px-2 py-1.5 text-sm text-graphite outline-none focus:border-graphite"
      />
    ) : (
      <input
        ref={inputRef as RefObject<HTMLInputElement>}
        id={domId}
        name="value"
        type={field.type === "number" ? "text" : field.type}
        defaultValue={toDefaultInputValue(value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        aria-invalid={fieldError ? "true" : "false"}
        aria-describedby={fieldError ? errorId : undefined}
        className="h-8 w-full min-w-[6rem] border border-grit px-2 text-sm text-graphite outline-none focus:border-graphite"
      />
    );

  const saveButtonClassName = isPopover
    ? "h-8 border border-grit bg-white px-3 text-xs font-medium text-graphite hover:bg-chalk disabled:text-grit"
    : "text-xs font-medium text-graphite underline-offset-4 hover:underline disabled:text-grit";
  const cancelButtonClassName = isPopover
    ? "h-8 border border-grit px-3 text-xs font-medium text-stone hover:bg-chalk disabled:text-grit"
    : "text-xs font-medium text-stone underline-offset-4 hover:underline disabled:text-grit";

  const actionButtons = (
    <>
      <button type="submit" disabled={pending} className={saveButtonClassName}>
        {pending ? "Saving..." : "Save"}
      </button>
      <button
        type="button"
        disabled={pending}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onClose({ returnFocus: true })}
        className={cancelButtonClassName}
      >
        Cancel
      </button>
    </>
  );

  return (
    <form
      ref={formRef}
      action={formAction}
      className={isPopover ? "flex flex-col gap-3" : "flex flex-col gap-1"}
    >
      {isPopover ? (
        <p id={headingId} className="text-xs font-semibold text-stone">
          {field.name}
        </p>
      ) : null}
      <input type="hidden" name="fieldKey" value={field.key} />
      <div className={isPopover ? "flex flex-col gap-2" : "flex items-center gap-2"}>
        {control}
        {isPopover ? (
          <div className="flex items-center justify-end gap-2 border-t border-grit pt-2">
            {actionButtons}
          </div>
        ) : (
          actionButtons
        )}
      </div>
      {state.blocked ? (
        <p id={errorId} className="text-xs text-status-oxide" role="alert">
          {state.message}{" "}
          <Link href={recordEditHref} className="underline underline-offset-4">
            Open full edit
          </Link>
        </p>
      ) : fieldError ? (
        <p id={errorId} className="text-xs text-status-oxide" role="alert">
          {fieldError}
        </p>
      ) : null}
    </form>
  );
}
