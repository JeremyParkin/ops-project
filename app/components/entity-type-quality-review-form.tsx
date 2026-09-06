"use client";

import { useActionState, useState } from "react";
import { SectionHeader } from "@/app/components/page-primitives";
import type { EntityTypeActionState } from "@/app/actions";
import type { EntityTypeQualityReviewConfig } from "@/lib/domain/metadata-repository";
import type { ChoiceOption, FieldDefinition } from "@/lib/domain/types";

const initialState: EntityTypeActionState = { success: false, message: "" };

// Phase 12.3.1: the smallest purposeful lifecycle surface for a Quality
// Review-shaped object. Says nothing about triggers, RPCs, or the
// enforcement mechanism -- only what a builder needs to decide: which
// Choice field tracks status, and which of its options mean "still being
// written" versus "finalized and locked." Every rejection surfaced here is
// the RPC's own truthful message (missing prerequisites, an option that
// doesn't belong to the chosen field, existing records with an
// unrecognized status and a real count, an attempt to disable while
// records exist) -- never a generic "please try again."
export function EntityTypeQualityReviewForm({
  entityTypeId,
  prerequisitesMet,
  choiceFields,
  optionsByFieldId,
  config,
  action,
}: {
  entityTypeId: string;
  prerequisitesMet: boolean;
  choiceFields: FieldDefinition[];
  optionsByFieldId: Record<string, ChoiceOption[]>;
  config: EntityTypeQualityReviewConfig;
  action: (state: EntityTypeActionState, formData: FormData) => Promise<EntityTypeActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [qualityReview, setQualityReview] = useState(config.qualityReview);
  const [statusFieldId, setStatusFieldId] = useState(config.statusFieldId ?? "");

  const activeOptionsForStatusField = (optionsByFieldId[statusFieldId] ?? []).filter(
    (option) => !option.archivedAt,
  );

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <SectionHeader
        title="Quality Review lifecycle"
        description="Give this object a Draft/Finalized state: only the designated reviewer can create and edit a review while it's a draft, and once finalized it becomes read-only history."
      />

      {!prerequisitesMet ? (
        <p className="mt-3 text-sm text-amber-700" role="status">
          Configure sensitive people data above first -- with a subject field, a reviewer field, and reviewer
          visibility enabled -- before setting up the review lifecycle.
        </p>
      ) : null}

      <form action={formAction} className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              name="qualityReview"
              defaultChecked={config.qualityReview}
              disabled={!prerequisitesMet || choiceFields.length === 0}
              onChange={(event) => setQualityReview(event.target.checked)}
              className="h-4 w-4"
            />
            Track a Draft/Finalized lifecycle for this object
          </label>
          {prerequisitesMet && choiceFields.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">
              Add a Choice field on this object to track status before enabling this.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="statusFieldId" className="block text-sm font-medium text-slate-800">
            Status field
          </label>
          <select
            id="statusFieldId"
            name="statusFieldId"
            disabled={!qualityReview}
            defaultValue={config.statusFieldId ?? ""}
            onChange={(event) => setStatusFieldId(event.target.value)}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
          >
            <option value="">Choose a field</option>
            {choiceFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">The Choice field that tracks Draft vs. Finalized.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="draftOptionId" className="block text-sm font-medium text-slate-800">
              Draft option
            </label>
            <select
              id="draftOptionId"
              name="draftOptionId"
              disabled={!qualityReview || !statusFieldId}
              defaultValue={config.draftOptionId ?? ""}
              className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
            >
              <option value="">Choose an option</option>
              {activeOptionsForStatusField.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="finalizedOptionId" className="block text-sm font-medium text-slate-800">
              Finalized option
            </label>
            <select
              id="finalizedOptionId"
              name="finalizedOptionId"
              disabled={!qualityReview || !statusFieldId}
              defaultValue={config.finalizedOptionId ?? ""}
              className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
            >
              <option value="">Choose an option</option>
              {activeOptionsForStatusField.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="md:col-span-2 text-sm text-slate-600">
          New reviews always start in Draft. Only the designated reviewer can create, edit, or finalize a
          draft; once finalized, correcting it requires a privileged administrator to reopen it first.
        </p>

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
