"use client";

import { useActionState, useState } from "react";
import type {
  EntityDefinitionFormState,
  EntityFieldFormRow,
} from "@/lib/domain/entity-definition-validation";
import { initialEntityDefinitionFormState } from "@/lib/domain/entity-definition-validation";
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

const primitiveFieldTypes: Array<{
  label: string;
  value: FieldType;
}> = [
  { label: "Text", value: "text" },
  { label: "Number", value: "number" },
  { label: "Date", value: "date" },
  { label: "Boolean", value: "boolean" },
  { label: "Relation", value: "relation" },
];

function createEmptyField(rowNumber: number): EntityFieldFormRow {
  return {
    rowId: `field-${rowNumber}`,
    name: "",
    type: "text",
    relatedEntityTypeId: "",
    required: false,
  };
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
          New Entity
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-950">
          Define Entity Type
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
                    {primitiveFieldTypes.map((fieldType) => (
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
                      Related Entity
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
              </div>
            ))}
          </div>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 w-fit items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {pending ? "Creating..." : "Create Entity"}
        </button>
    </>
  );
}
