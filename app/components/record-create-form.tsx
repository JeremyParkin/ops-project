"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import type { EntityType, FieldDefinition } from "@/lib/domain/types";
import type { RelationOptionsByFieldKey } from "@/lib/domain/record-repository";
import { activeChoiceOptions } from "@/lib/domain/choice-display";
import type { ChoiceOptionsByFieldKey } from "@/lib/domain/choice-display";
import {
  initialRecordFormState,
  type RecordFormState,
} from "@/lib/domain/record-validation";

type RecordCreateFormProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  relationOptionsByFieldKey?: RelationOptionsByFieldKey;
  choiceOptionsByFieldKey?: ChoiceOptionsByFieldKey;
  entityNameById?: Record<string, string>;
  initialValues?: Record<string, string>;
  cancelHref?: string;
  createRecordAction: (
    state: RecordFormState,
    formData: FormData,
  ) => Promise<RecordFormState>;
};

function getFieldValue(state: RecordFormState, field: FieldDefinition) {
  return state.values[field.key] ?? "";
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

export function RecordCreateForm({
  initialValues = {},
  ...props
}: RecordCreateFormProps) {
  const formIdentity = JSON.stringify(initialValues);

  return (
    <RecordCreateFormContents
      key={formIdentity}
      {...props}
      initialValues={initialValues}
    />
  );
}

function RecordCreateFormContents({
  entityType,
  fields,
  relationOptionsByFieldKey = {},
  choiceOptionsByFieldKey = {},
  entityNameById = {},
  initialValues = {},
  cancelHref,
  createRecordAction,
}: RecordCreateFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [state, formAction, pending] = useActionState(
    createRecordAction,
    {
      ...initialRecordFormState,
      values: initialValues,
    },
  );
  const orderedFields = [...fields].sort((left, right) => {
    return left.position - right.position;
  });
  const [open, setOpen] = useState(
    () =>
      Boolean(cancelHref) ||
      Object.keys(initialValues).length > 0 ||
      (typeof window !== "undefined" && window.location.hash === "#add-record"),
  );
  const hasErrors = Object.keys(state.errors).length > 0;
  const isOpen = open || hasErrors;

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  useEffect(() => {
    function openFromHash() {
      if (window.location.hash === "#add-record") {
        setOpen(true);
      }
    }

    function openFromAddRecordLink(event: MouseEvent) {
      if (!(event.target instanceof Element)) {
        return;
      }

      if (event.target.closest('a[href="#add-record"]')) {
        setOpen(true);
      }
    }

    window.addEventListener("hashchange", openFromHash);
    window.addEventListener("click", openFromAddRecordLink);
    return () => {
      window.removeEventListener("hashchange", openFromHash);
      window.removeEventListener("click", openFromAddRecordLink);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const shouldFocus =
      window.location.hash === "#add-record" || Boolean(cancelHref);
    if (shouldFocus) {
      headingRef.current?.focus();
    }
  }, [cancelHref, isOpen]);

  function closeForm() {
    formRef.current?.reset();
    setOpen(false);
  }

  return (
    <details
      id="add-record"
      open={isOpen}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="mx-auto w-full max-w-6xl border border-slate-200 bg-white"
    >
      <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-800 marker:text-slate-500">
        Add {entityType.name}
      </summary>
      <div className="border-t border-slate-200 p-5">
        <div className="mb-5">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-slate-950">
            Add {entityType.name}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Fields marked <span className="font-semibold text-red-700">*</span> are required.
          </p>
          {state.message ? (
            <p
              className={`mt-2 text-sm ${
                state.success ? "text-emerald-700" : "text-red-700"
              }`}
              role="status"
            >
              {state.message}
            </p>
          ) : null}
          <FieldError message={state.errors._form} />
        </div>

      <form ref={formRef} action={formAction} className="grid gap-5 md:grid-cols-2">
        {orderedFields.map((field) => {
          const fieldId = `record-field-${field.key}`;
          const fieldValue = getFieldValue(state, field);

          if (field.type === "boolean") {
            return (
              <div key={field.id} className="md:col-span-2">
                <input type="hidden" name={field.key} value="false" />
                <label
                  htmlFor={fieldId}
                  className="flex items-center gap-3 text-sm font-medium text-slate-800"
                >
                  <input
                    id={fieldId}
                    name={field.key}
                    type="checkbox"
                    value="true"
                    defaultChecked={fieldValue === "true"}
                    className="h-4 w-4 border-slate-300 text-slate-950"
                  />
                  {field.name}
                  {field.required ? (
                    <span className="text-red-700" aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </label>
                <FieldError message={state.errors[field.key]} />
              </div>
            );
          }

          if (field.type === "choice") {
            const options = activeChoiceOptions(choiceOptionsByFieldKey[field.key] ?? []);

            return (
              <div key={field.id}>
                <label
                  htmlFor={fieldId}
                  className="block text-sm font-medium text-slate-800"
                >
                  {field.name}
                  {field.required ? (
                    <span className="ml-1 text-red-700" aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </label>
                <select
                  id={fieldId}
                  name={field.key}
                  required={field.required}
                  defaultValue={fieldValue}
                  aria-invalid={state.errors[field.key] ? "true" : "false"}
                  aria-describedby={
                    state.errors[field.key] ? `${fieldId}-error` : undefined
                  }
                  className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                >
                  <option value="">Choose an option</option>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <div id={`${fieldId}-error`}>
                  <FieldError message={state.errors[field.key]} />
                </div>
              </div>
            );
          }

          if (field.type === "relation") {
            // A new record has no existing value to preserve, so an
            // already-archived target (kept in optionsByFieldKey only so an
            // existing row's selection in the table doesn't disappear) is
            // never a valid choice here -- see getRelationLookups.
            const options = (relationOptionsByFieldKey[field.key] ?? []).filter(
              (option) => !option.archivedAt,
            );
            const relatedEntityName = field.relatedEntityTypeId
              ? entityNameById[field.relatedEntityTypeId]
              : undefined;

            return (
              <div key={field.id}>
                <label
                  htmlFor={fieldId}
                  className="block text-sm font-medium text-slate-800"
                >
                  {field.name}
                  {field.required ? (
                    <span className="ml-1 text-red-700" aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </label>
                <select
                  id={fieldId}
                  name={field.key}
                  required={field.required}
                  defaultValue={fieldValue}
                  aria-invalid={state.errors[field.key] ? "true" : "false"}
                  aria-describedby={
                    state.errors[field.key] ? `${fieldId}-error` : undefined
                  }
                  className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                >
                  <option value="">
                    {relatedEntityName ? `Choose ${relatedEntityName}` : "Choose an option"}
                  </option>
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {relatedEntityName ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Related to {relatedEntityName}
                  </p>
                ) : null}
                <div id={`${fieldId}-error`}>
                  <FieldError message={state.errors[field.key]} />
                </div>
              </div>
            );
          }

          return (
            <div key={field.id}>
              <label
                htmlFor={fieldId}
                className="block text-sm font-medium text-slate-800"
              >
                {field.name}
                {field.required ? (
                  <span className="ml-1 text-red-700" aria-hidden="true">
                    *
                  </span>
                ) : null}
              </label>
              <input
                id={fieldId}
                name={field.key}
                type={field.type === "number" ? "text" : field.type}
                required={field.required}
                defaultValue={fieldValue}
                aria-invalid={state.errors[field.key] ? "true" : "false"}
                aria-describedby={
                  state.errors[field.key] ? `${fieldId}-error` : undefined
                }
                className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
              />
              <div id={`${fieldId}-error`}>
                <FieldError message={state.errors[field.key]} />
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 md:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
          >
            {pending ? "Adding..." : `Add ${entityType.name}`}
          </button>
          {cancelHref ? (
            <Link
              href={cancelHref}
              className="ml-4 text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
            >
              Cancel
            </Link>
          ) : (
            <button
              type="button"
              onClick={closeForm}
              className="h-10 px-2 text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
      </div>
    </details>
  );
}
