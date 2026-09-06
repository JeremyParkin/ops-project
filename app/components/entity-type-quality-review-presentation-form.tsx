"use client";

import { useActionState } from "react";
import { SectionHeader } from "@/app/components/page-primitives";
import type { EntityTypeActionState } from "@/app/actions";
import type { EntityTypeQualityReviewPresentationConfig } from "@/lib/domain/metadata-repository";
import type { FieldDefinition } from "@/lib/domain/types";

const initialState: EntityTypeActionState = { success: false, message: "" };

// Phase 12.3.2: which Date field shows as "Review Date" and which Choice
// field (if any) shows as "Overall Result" on the Person Review History
// section -- QR-specific presentation, not a generic semantic taxonomy.
// Every rejection surfaced here is the RPC's own truthful message
// (finalized records missing a valid date, an attempt to change or clear a
// designation once Finalized history exists) -- never a generic retry
// prompt.
export function EntityTypeQualityReviewPresentationForm({
  entityTypeId,
  dateFields,
  choiceFields,
  config,
  action,
}: {
  entityTypeId: string;
  dateFields: FieldDefinition[];
  choiceFields: FieldDefinition[];
  config: EntityTypeQualityReviewPresentationConfig;
  action: (state: EntityTypeActionState, formData: FormData) => Promise<EntityTypeActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <SectionHeader
        title="Review presentation"
        description="Choose which fields show as Review Date and Overall Result on this person's Review history. Once a Finalized review exists, these designations can no longer be changed or cleared."
      />

      <form action={formAction} className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="dateFieldId" className="block text-sm font-medium text-slate-800">
            Review date field
          </label>
          <select
            id="dateFieldId"
            name="dateFieldId"
            defaultValue={config.dateFieldId ?? ""}
            disabled={dateFields.length === 0}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
          >
            <option value="">Choose a field</option>
            {dateFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          {dateFields.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">Add a Date field on this object first.</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="resultFieldId" className="block text-sm font-medium text-slate-800">
            Overall result field
          </label>
          <select
            id="resultFieldId"
            name="resultFieldId"
            defaultValue={config.resultFieldId ?? ""}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            <option value="">None</option>
            {choiceFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">Optional -- historical reviews may have no result.</p>
        </div>

        <input type="hidden" name="entityTypeId" value={entityTypeId} />

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
          >
            {pending ? "Saving..." : "Save"}
          </button>
        </div>

        {state.message ? (
          <p className={`md:col-span-2 text-sm ${state.success ? "text-emerald-700" : "text-red-700"}`} role={state.success ? "status" : "alert"}>
            {state.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
