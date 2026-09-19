"use client";

import { useActionState, useState } from "react";
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
                          const swatchColor = isChoiceOptionColor(option.color)
                            ? option.color
                            : undefined;

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
                                  htmlFor={`choiceOptionColor:${field.rowId}:${option.rowId}`}
                                  className="sr-only"
                                >
                                  Option {optionIndex + 1} color
                                </label>
                                {/* Native <select> for full keyboard/screen-reader
                                    support -- a swatch can't reliably render inside
                                    the closed state cross-browser, so a decorative
                                    overlay swatch sits over the select's own text
                                    (already reading the color name), giving the
                                    "[ swatch  Name  v ]" look without a custom
                                    listbox widget. */}
                                <div className="relative">
                                  <span
                                    aria-hidden="true"
                                    className={`pointer-events-none absolute left-2 top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-sm border ${
                                      swatchColor
                                        ? CHOICE_OPTION_SWATCH_CLASSES[swatchColor]
                                        : "border-dashed border-slate-400"
                                    }`}
                                  >
                                    {!swatchColor ? (
                                      <span className="text-[8px] leading-none text-slate-400">
                                        ×
                                      </span>
                                    ) : null}
                                  </span>
                                  <select
                                    id={`choiceOptionColor:${field.rowId}:${option.rowId}`}
                                    name={`choiceOptionColor:${field.rowId}:${option.rowId}`}
                                    value={option.color}
                                    onChange={(event) =>
                                      updateChoiceOptionColor(
                                        field.rowId,
                                        option.rowId,
                                        event.currentTarget.value,
                                      )
                                    }
                                    className="block h-9 w-full border border-slate-300 bg-white py-0 pl-8 pr-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                                  >
                                    <option value="">No color</option>
                                    {CHOICE_OPTION_COLORS.map((color) => (
                                      <option key={color} value={color}>
                                        {CHOICE_OPTION_COLOR_LABELS[color]}
                                      </option>
                                    ))}
                                  </select>
                                </div>
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
