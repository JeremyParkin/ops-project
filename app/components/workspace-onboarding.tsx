"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import {
  buildStarterEntities,
  initialWorkspaceSetupFormState,
  starterOptions,
  type StarterOptionId,
  type WorkspaceSetupFormState,
} from "@/lib/domain/workspace-onboarding";

type WorkspaceOnboardingProps = {
  createWorkspaceStarterStructureAction: (
    state: WorkspaceSetupFormState,
    formData: FormData,
  ) => Promise<WorkspaceSetupFormState>;
};

export function WorkspaceOnboarding({
  createWorkspaceStarterStructureAction,
}: WorkspaceOnboardingProps) {
  const [state, formAction, pending] = useActionState(
    createWorkspaceStarterStructureAction,
    initialWorkspaceSetupFormState,
  );
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedOptionIds, setSelectedOptionIds] = useState<StarterOptionId[]>(
    state.selectedOptionIds,
  );
  const entities = useMemo(
    () => buildStarterEntities(selectedOptionIds),
    [selectedOptionIds],
  );
  const relations = entities.flatMap((entity) =>
    entity.fields
      .filter((field) => field.type === "relation" && field.relatedLocalId)
      .map((field) => ({
        fieldName: field.name,
        sourceEntityName: entity.name,
        targetEntityName:
          entities.find((candidate) => candidate.localId === field.relatedLocalId)
            ?.name ?? "",
      })),
  );

  function toggleOption(optionId: StarterOptionId) {
    setSelectedOptionIds((current) =>
      current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId],
    );
  }

  return (
    <section className="mx-auto w-full max-w-3xl border border-slate-200 bg-white p-6">
      <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
        Workspace setup
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-slate-950">
        Set up your workspace
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
        Start with a few useful records and fields. Everything remains editable
        after setup.
      </p>

      <form action={formAction} className="mt-6">
        {selectedOptionIds.map((optionId) => (
          <input key={optionId} type="hidden" name="starterOption" value={optionId} />
        ))}

        {step === 1 ? (
          <div>
            <fieldset>
              <legend className="text-lg font-semibold text-slate-950">
                What do you want to manage?
              </legend>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {starterOptions.map((option) => {
                  const selected = selectedOptionIds.includes(option.id);

                  return (
                    <label
                      key={option.id}
                      className={`cursor-pointer border p-4 ${
                        selected
                          ? "border-slate-950 bg-slate-50"
                          : "border-slate-200 bg-white hover:border-slate-400"
                      }`}
                    >
                      <input
                        className="sr-only"
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleOption(option.id)}
                      />
                      <span className="block text-base font-semibold text-slate-950">
                        {option.name}
                      </span>
                      <span className="mt-1 block text-sm text-slate-600">
                        {option.description}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {state.message ? (
              <p className="mt-4 text-sm text-red-700" role="alert">
                {state.message}
              </p>
            ) : null}
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={selectedOptionIds.length === 0}
                className="h-10 bg-brass px-4 text-sm font-medium text-graphite disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
              >
                Continue
              </button>
              <Link
                href="/entities/new?from=onboarding"
                className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
              >
                Start from scratch
              </Link>
            </div>
          </div>
        ) : (
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Review your setup</h2>
            <div className="mt-4 grid gap-3">
              {entities.map((entity) => (
                <div key={entity.localId} className="border border-slate-200 p-4">
                  <h3 className="font-semibold text-slate-950">{entity.name}</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    {entity.fields.map((field) => field.name).join(", ")}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-slate-600">
              {relations.length > 0
                ? `Relations: ${relations
                    .map(
                      (relation) =>
                        `${relation.sourceEntityName}.${relation.fieldName} to ${relation.targetEntityName}`,
                    )
                    .join("; ")}.`
                : "No inferred relations are needed for this selection."}
            </p>
            {state.message ? (
              <p className="mt-4 text-sm text-red-700" role="alert">
                {state.message}
              </p>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={pending}
                className="h-10 bg-brass px-4 text-sm font-medium text-graphite disabled:bg-chalk disabled:text-stone"
              >
                {pending ? "Creating..." : "Create workspace structure"}
              </button>
              <button
                type="button"
                onClick={() => setStep(1)}
                disabled={pending}
                className="h-10 border border-slate-300 px-4 text-sm font-medium text-slate-800"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}
