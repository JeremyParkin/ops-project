"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type {
  EntityChoiceOptionFormRow,
  EntityDefinitionFormState,
  EntityFieldFormRow,
} from "@/lib/domain/entity-definition-validation";
import { initialEntityDefinitionFormState } from "@/lib/domain/entity-definition-validation";
import {
  CHOICE_OPTION_COLORS,
  CHOICE_OPTION_COLOR_LABELS,
  CHOICE_OPTION_SWATCH_CLASSES,
  isChoiceOptionColor,
} from "@/lib/domain/choice-colors";
import type { EntityType, FieldType } from "@/lib/domain/types";

type EntityCreateFormProps = {
  entityTypes: EntityType[];
  createEntityDefinitionAction: (
    state: EntityDefinitionFormState,
    formData: FormData,
  ) => Promise<EntityDefinitionFormState>;
};

type EntityCreateFormFieldsProps = {
  state: EntityDefinitionFormState;
  entityTypes: EntityType[];
  pending: boolean;
};

const fieldTypes: Array<{
  label: string;
  value: FieldType;
}> = [
  { label: "Text", value: "text" },
  { label: "Number", value: "number" },
  { label: "Date", value: "date" },
  { label: "Boolean", value: "boolean" },
  { label: "Relation", value: "relation" },
  { label: "Choice", value: "choice" },
];

function createEmptyChoiceOption(rowId: string): EntityChoiceOptionFormRow {
  return {
    rowId,
    label: "",
    color: "gray",
  };
}

function createEmptyField(rowNumber: number): EntityFieldFormRow {
  return {
    rowId: `field-${rowNumber}`,
    name: "",
    type: "text",
    relatedEntityTypeId: "",
    required: false,
    choiceOptions: [],
  };
}

function createChoiceOptionRowId() {
  return `option-${crypto.randomUUID()}`;
}

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

const NO_COLOR_VALUE = "";
const choiceColorSelectOptions: Array<{ value: string; label: string }> = [
  { value: NO_COLOR_VALUE, label: "No color" },
  ...CHOICE_OPTION_COLORS.map((color) => ({
    value: color,
    label: CHOICE_OPTION_COLOR_LABELS[color],
  })),
];

function ChoiceColorSwatch({ color }: { color: string }) {
  const swatchColor = isChoiceOptionColor(color) ? color : undefined;

  return (
    <span
      aria-hidden="true"
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
        swatchColor ? CHOICE_OPTION_SWATCH_CLASSES[swatchColor] : "border-dashed border-slate-400"
      }`}
    >
      {!swatchColor ? <span className="text-[8px] leading-none text-slate-400">×</span> : null}
    </span>
  );
}

// A native <select> can't reliably show a swatch beside each <option>'s
// text in its OPEN list cross-browser (confirmed in hosted dogfood: only
// the closed trigger could be visually augmented, the open native list
// stayed text-only) -- so this control replaces it entirely with a real
// listbox button. Modeled on NavMenu's disclosure mechanics (click-outside
// closes, Escape closes) but, unlike NavMenu's deliberate `role="group"`
// (a navigation disclosure, not a value picker), this implements the
// actual ARIA listbox-button pattern: aria-activedescendant keeps DOM
// focus on the trigger the whole time (never moving focus into the list),
// with arrow keys/Enter/Escape handled on the trigger itself.
function ChoiceColorSelect({
  id,
  labelId,
  name,
  value,
  onChange,
}: {
  id: string;
  labelId: string;
  name: string;
  value: string;
  onChange: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = `${id}-listbox`;
  const selectedOption =
    choiceColorSelectOptions.find((option) => option.value === value) ??
    choiceColorSelectOptions[0];

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  function openList() {
    const currentIndex = choiceColorSelectOptions.findIndex((option) => option.value === value);
    setHighlightedIndex(Math.max(currentIndex, 0));
    setOpen(true);
  }

  function selectHighlighted() {
    const option = choiceColorSelectOptions[highlightedIndex];
    if (option) {
      onChange(option.value);
    }
    setOpen(false);
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openList();
      } else {
        setHighlightedIndex((current) =>
          Math.min(current + 1, choiceColorSelectOptions.length - 1),
        );
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
      } else {
        setHighlightedIndex((current) => Math.max(current - 1, 0));
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        openList();
      } else {
        selectHighlighted();
      }
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={value} />
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={`${labelId} ${id}`}
        aria-activedescendant={open ? `${listboxId}-option-${highlightedIndex}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleTriggerKeyDown}
        className="flex h-9 w-full items-center gap-2 border border-slate-300 bg-white px-3 text-left text-sm text-slate-950 outline-none focus:border-slate-950"
      >
        <ChoiceColorSwatch color={selectedOption.value} />
        <span className="flex-1 truncate">{selectedOption.label}</span>
        <span aria-hidden="true" className="shrink-0 text-[10px] text-slate-500">
          ▾
        </span>
      </button>
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-labelledby={labelId}
          tabIndex={-1}
          className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto border border-slate-300 bg-white py-1 shadow-md"
        >
          {choiceColorSelectOptions.map((option, index) => (
            <li
              key={option.value || "none"}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-950 ${
                index === highlightedIndex ? "bg-slate-100" : ""
              }`}
            >
              <ChoiceColorSwatch color={option.value} />
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function EntityCreateForm({
  entityTypes,
  createEntityDefinitionAction,
}: EntityCreateFormProps) {
  const [state, formAction, pending] = useActionState(
    createEntityDefinitionAction,
    initialEntityDefinitionFormState,
  );

  return (
    <section className="w-full max-w-4xl border border-slate-200 bg-white p-5">
      <div className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Data model
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-950">
          Create object
        </h1>
        {state.message ? (
          <p className="mt-2 text-sm text-red-700" role="status">
            {state.message}
          </p>
        ) : null}
        <FieldError message={state.errors._form} />
      </div>

      <form action={formAction} className="flex flex-col gap-6">
        <EntityCreateFormFields
          key={state.formVersion}
          state={state}
          entityTypes={entityTypes}
          pending={pending}
        />
      </form>
    </section>
  );
}

function EntityCreateFormFields({
  state,
  entityTypes,
  pending,
}: EntityCreateFormFieldsProps) {
  const initialFieldRows =
    state.fields.length > 0 ? state.fields : initialEntityDefinitionFormState.fields;
  const [fieldRows, setFieldRows] =
    useState<EntityFieldFormRow[]>(initialFieldRows);
  const [nextRowNumber, setNextRowNumber] = useState(initialFieldRows.length + 1);

  function addFieldRow() {
    setFieldRows((currentRows) => [
      ...currentRows,
      createEmptyField(nextRowNumber),
    ]);
    setNextRowNumber((currentNumber) => currentNumber + 1);
  }

  function removeFieldRow(rowId: string) {
    setFieldRows((currentRows) => {
      if (currentRows.length === 1) {
        return currentRows;
      }

      return currentRows.filter((row) => row.rowId !== rowId);
    });
  }

  function updateFieldType(rowId: string, type: FieldType) {
    setFieldRows((currentRows) =>
      currentRows.map((row) => {
        if (row.rowId !== rowId) {
          return row;
        }

        return {
          ...row,
          type,
          relatedEntityTypeId:
            type === "relation" ? row.relatedEntityTypeId : "",
          // A Choice field with zero options is backend-valid (migration
          // 0140 only requires at least one FIELD, not at least one choice
          // option) -- one empty row is just a friendlier starting point
          // than none, not a hidden minimum.
          choiceOptions:
            type === "choice" && row.choiceOptions.length === 0
              ? [createEmptyChoiceOption(createChoiceOptionRowId())]
              : row.choiceOptions,
        };
      }),
    );
  }

  function updateRelatedEntityType(rowId: string, relatedEntityTypeId: string) {
    setFieldRows((currentRows) =>
      currentRows.map((row) => {
        if (row.rowId !== rowId) {
          return row;
        }

        return {
          ...row,
          relatedEntityTypeId,
        };
      }),
    );
  }

  function addChoiceOption(fieldRowId: string) {
    setFieldRows((currentRows) =>
      currentRows.map((row) => {
        if (row.rowId !== fieldRowId) {
          return row;
        }

        return {
          ...row,
          choiceOptions: [
            ...row.choiceOptions,
            createEmptyChoiceOption(createChoiceOptionRowId()),
          ],
        };
      }),
    );
  }

  function removeChoiceOption(fieldRowId: string, optionRowId: string) {
    setFieldRows((currentRows) =>
      currentRows.map((row) => {
        if (row.rowId !== fieldRowId) {
          return row;
        }

        return {
          ...row,
          choiceOptions: row.choiceOptions.filter(
            (option) => option.rowId !== optionRowId,
          ),
        };
      }),
    );
  }

  function updateChoiceOptionColor(
    fieldRowId: string,
    optionRowId: string,
    color: string,
  ) {
    setFieldRows((currentRows) =>
      currentRows.map((row) => {
        if (row.rowId !== fieldRowId) {
          return row;
        }

        return {
          ...row,
          choiceOptions: row.choiceOptions.map((option) =>
            option.rowId === optionRowId ? { ...option, color } : option,
          ),
        };
      }),
    );
  }

  function updateChoiceOptionLabel(
    fieldRowId: string,
    optionRowId: string,
    label: string,
  ) {
    setFieldRows((currentRows) =>
      currentRows.map((row) => {
        if (row.rowId !== fieldRowId) {
          return row;
        }

        return {
          ...row,
          choiceOptions: row.choiceOptions.map((option) =>
            option.rowId === optionRowId ? { ...option, label } : option,
          ),
        };
      }),
    );
  }

  return (
    <>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label
              htmlFor="entityName"
              className="block text-sm font-medium text-slate-800"
            >
              Name
              <span className="ml-1 text-red-700" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id="entityName"
              name="entityName"
              required
              defaultValue={state.entity.name}
              className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
            />
            <FieldError message={state.errors.entityName} />
          </div>

          <div>
            <label
              htmlFor="entityDescription"
              className="block text-sm font-medium text-slate-800"
            >
              Description
            </label>
            <input
              id="entityDescription"
              name="entityDescription"
              defaultValue={state.entity.description}
              className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
            />
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-950">Fields</h2>
            <button
              type="button"
              onClick={addFieldRow}
              className="inline-flex h-9 items-center justify-center border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              Add Field
            </button>
          </div>

          <div className="flex flex-col gap-3">
            {fieldRows.map((field, index) => (
              <div
                key={field.rowId}
                className="grid gap-3 border border-slate-200 p-4 md:grid-cols-[1fr_180px_180px_auto_auto]"
              >
                <input type="hidden" name="fieldRowId" value={field.rowId} />
                <div>
                  <label
                    htmlFor={`fieldName:${field.rowId}`}
                    className="block text-sm font-medium text-slate-800"
                  >
                    Field {index + 1} Name
                    <span className="ml-1 text-red-700" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <input
                    id={`fieldName:${field.rowId}`}
                    name={`fieldName:${field.rowId}`}
                    required
                    defaultValue={field.name}
                    className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                  />
                  <FieldError message={state.errors[`fieldName:${field.rowId}`]} />
                </div>

                <div>
                  <label
                    htmlFor={`fieldType:${field.rowId}`}
                    className="block text-sm font-medium text-slate-800"
                  >
                    Type
                  </label>
                  <select
                    id={`fieldType:${field.rowId}`}
                    name={`fieldType:${field.rowId}`}
                    value={field.type}
                    onChange={(event) =>
                      updateFieldType(
                        field.rowId,
                        event.currentTarget.value as FieldType,
                      )
                    }
                    className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                  >
                    {fieldTypes.map((fieldType) => (
                      <option key={fieldType.value} value={fieldType.value}>
                        {fieldType.label}
                      </option>
                    ))}
                  </select>
                  <FieldError message={state.errors[`fieldType:${field.rowId}`]} />
                </div>

                {field.type === "relation" ? (
                  <div>
                    <label
                      htmlFor={`fieldRelatedEntityTypeId:${field.rowId}`}
                      className="block text-sm font-medium text-slate-800"
                    >
                      Related object
                    </label>
                    <select
                      id={`fieldRelatedEntityTypeId:${field.rowId}`}
                      name={`fieldRelatedEntityTypeId:${field.rowId}`}
                      value={field.relatedEntityTypeId}
                      onChange={(event) =>
                        updateRelatedEntityType(
                          field.rowId,
                          event.currentTarget.value,
                        )
                      }
                      className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                    >
                      <option value="">Choose entity</option>
                      {entityTypes.map((entityType) => (
                        <option key={entityType.id} value={entityType.id}>
                          {entityType.name}
                        </option>
                      ))}
                    </select>
                    <FieldError
                      message={
                        state.errors[
                          `fieldRelatedEntityTypeId:${field.rowId}`
                        ]
                      }
                    />
                  </div>
                ) : (
                  <input
                    type="hidden"
                    name={`fieldRelatedEntityTypeId:${field.rowId}`}
                    value=""
                  />
                )}

                <div className="flex items-end">
                  <input
                    type="hidden"
                    name={`fieldRequired:${field.rowId}`}
                    value="false"
                  />
                  <label className="flex h-10 items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      name={`fieldRequired:${field.rowId}`}
                      type="checkbox"
                      value="true"
                      defaultChecked={field.required}
                      className="h-4 w-4 border-slate-300 text-slate-950"
                    />
                    Required
                  </label>
                </div>

                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => removeFieldRow(field.rowId)}
                    disabled={fieldRows.length === 1}
                    className="inline-flex h-10 items-center justify-center border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    Remove
                  </button>
                </div>

                {field.type === "choice" ? (
                  <div className="md:col-span-5">
                    <div className="border border-slate-200 bg-slate-50 p-3">
                      <p className="mb-2 text-sm font-medium text-slate-800">
                        Choice options
                      </p>
                      <FieldError
                        message={state.errors[`choiceOptions:${field.rowId}`]}
                      />
                      <div className="flex flex-col gap-2">
                        {field.choiceOptions.map((option, optionIndex) => {
                          return (
                            <div
                              key={option.rowId}
                              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px_auto]"
                            >
                              <input
                                type="hidden"
                                name={`choiceOptionRowId:${field.rowId}`}
                                value={option.rowId}
                              />
                              <div>
                                <label
                                  htmlFor={`choiceOptionLabel:${field.rowId}:${option.rowId}`}
                                  className="sr-only"
                                >
                                  Option {optionIndex + 1} label
                                </label>
                                <input
                                  id={`choiceOptionLabel:${field.rowId}:${option.rowId}`}
                                  name={`choiceOptionLabel:${field.rowId}:${option.rowId}`}
                                  value={option.label}
                                  onChange={(event) =>
                                    updateChoiceOptionLabel(
                                      field.rowId,
                                      option.rowId,
                                      event.currentTarget.value,
                                    )
                                  }
                                  placeholder={`Option ${optionIndex + 1}`}
                                  className="block h-9 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                                />
                                <FieldError
                                  message={
                                    state.errors[
                                      `choiceOptionLabel:${field.rowId}:${option.rowId}`
                                    ]
                                  }
                                />
                              </div>
                              <div>
                                <label
                                  id={`choiceOptionColorLabel:${field.rowId}:${option.rowId}`}
                                  htmlFor={`choiceOptionColor:${field.rowId}:${option.rowId}`}
                                  className="sr-only"
                                >
                                  Option {optionIndex + 1} color
                                </label>
                                <ChoiceColorSelect
                                  id={`choiceOptionColor:${field.rowId}:${option.rowId}`}
                                  labelId={`choiceOptionColorLabel:${field.rowId}:${option.rowId}`}
                                  name={`choiceOptionColor:${field.rowId}:${option.rowId}`}
                                  value={option.color}
                                  onChange={(color) =>
                                    updateChoiceOptionColor(
                                      field.rowId,
                                      option.rowId,
                                      color,
                                    )
                                  }
                                />
                                <FieldError
                                  message={
                                    state.errors[
                                      `choiceOptionColor:${field.rowId}:${option.rowId}`
                                    ]
                                  }
                                />
                              </div>
                              <div className="flex items-start">
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeChoiceOption(field.rowId, option.rowId)
                                  }
                                  aria-label="Remove option"
                                  title="Remove option"
                                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                                >
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="h-4 w-4 shrink-0"
                                    aria-hidden="true"
                                  >
                                    <path d="M3 6h18" />
                                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                    <path d="M10 11v6" />
                                    <path d="M14 11v6" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => addChoiceOption(field.rowId)}
                        className="mt-3 inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"
                      >
                        <span aria-hidden="true" className="text-base leading-none text-slate-500">
                          +
                        </span>
                        <span>Add option</span>
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 w-fit items-center justify-center bg-brass px-4 text-sm font-medium text-graphite disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Creating..." : "Create object"}
        </button>
    </>
  );
}
