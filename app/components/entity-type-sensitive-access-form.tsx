"use client";

import { useActionState, useState } from "react";
import { SectionHeader } from "@/app/components/page-primitives";
import type { EntityTypeActionState } from "@/app/actions";
import type { EntityTypeSensitiveAccessConfig } from "@/lib/domain/metadata-repository";
import type { FieldDefinition } from "@/lib/domain/types";

const initialState: EntityTypeActionState = { success: false, message: "" };

// Phase 12.2: the smallest understandable builder surface for sensitive
// people data. Deliberately says nothing about RLS, policies, or the
// authorization mechanism -- only what a builder needs to decide: who is
// this record about, who reported it, and which of those (plus their
// primary manager) may see it. Every rejection surfaced here is the RPC's
// own truthful message (missing Person type, invalid field, existing
// records without a valid subject with a real count, a Process
// Template/Workflow conflict, or author access without a designated
// field) -- never a generic "please try again."
export function EntityTypeSensitiveAccessForm({
  entityTypeId,
  personTypeDesignated,
  relationFieldsTargetingPersonType,
  config,
  action,
}: {
  entityTypeId: string;
  personTypeDesignated: boolean;
  relationFieldsTargetingPersonType: FieldDefinition[];
  config: EntityTypeSensitiveAccessConfig;
  action: (state: EntityTypeActionState, formData: FormData) => Promise<EntityTypeActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [peopleSensitive, setPeopleSensitive] = useState(config.peopleSensitive);
  const [authorFieldId, setAuthorFieldId] = useState(config.authorPersonFieldId ?? "");
  const [authorCanView, setAuthorCanView] = useState(config.authorCanView);

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <SectionHeader
        title="Sensitive people data"
        description="Restrict who can see records of this object to the person it's about, their manager, and a designated reviewer -- instead of the whole workspace."
      />

      {!personTypeDesignated ? (
        <p className="mt-3 text-sm text-amber-700" role="status">
          A workspace Person type must be designated in Settings before sensitive people data can be enabled here.
        </p>
      ) : null}

      <form action={formAction} className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              name="peopleSensitive"
              defaultChecked={config.peopleSensitive}
              disabled={!personTypeDesignated || relationFieldsTargetingPersonType.length === 0}
              onChange={(event) => setPeopleSensitive(event.target.checked)}
              className="h-4 w-4"
            />
            Treat this object as sensitive people data
          </label>
          {personTypeDesignated && relationFieldsTargetingPersonType.length === 0 ? (
            <p className="mt-1 text-sm text-slate-600">
              Add a relation field on this object that targets the designated Person type before enabling this.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="subjectPersonFieldId" className="block text-sm font-medium text-slate-800">
            Subject field
          </label>
          <select
            id="subjectPersonFieldId"
            name="subjectPersonFieldId"
            disabled={!peopleSensitive}
            defaultValue={config.subjectPersonFieldId ?? ""}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
          >
            <option value="">Choose a field</option>
            {relationFieldsTargetingPersonType.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">Who this record is about.</p>
        </div>

        <div>
          <label htmlFor="authorPersonFieldId" className="block text-sm font-medium text-slate-800">
            Reviewer/author field (optional)
          </label>
          <select
            id="authorPersonFieldId"
            name="authorPersonFieldId"
            disabled={!peopleSensitive}
            defaultValue={config.authorPersonFieldId ?? ""}
            onChange={(event) => setAuthorFieldId(event.target.value)}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
          >
            <option value="">None</option>
            {relationFieldsTargetingPersonType.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">Who reported or reviewed it, if relevant.</p>
        </div>

        <div className="md:col-span-2 flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" name="subjectCanView" disabled={!peopleSensitive} defaultChecked={config.subjectCanView} className="h-4 w-4" />
            Subject can view
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" name="managerCanView" disabled={!peopleSensitive} defaultChecked={config.managerCanView} className="h-4 w-4" />
            Primary manager can view
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              name="authorCanView"
              disabled={!peopleSensitive || !authorFieldId}
              checked={authorCanView && Boolean(authorFieldId)}
              onChange={(event) => setAuthorCanView(event.target.checked)}
              className="h-4 w-4"
            />
            Reviewer/author can view
          </label>
        </div>

        <p className="md:col-span-2 text-sm text-slate-600">
          People-data administrators retain access regardless of these settings.
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
