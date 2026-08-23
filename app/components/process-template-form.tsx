"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { ProcessTemplateFormState } from "@/lib/domain/process-validation";
import type { WorkspaceMemberIdentity } from "@/lib/domain/process-types";
import type { EntityType } from "@/lib/domain/types";

type LocalStep = {
  key: string;
  nodeId: string;
  name: string;
  assigneeUserId: string;
};

type ProcessTemplateFormProps = {
  entityTypes: EntityType[];
  members: WorkspaceMemberIdentity[];
  saveProcessTemplateAction: (
    state: ProcessTemplateFormState,
    formData: FormData,
  ) => Promise<ProcessTemplateFormState>;
  initialState: ProcessTemplateFormState;
  isEditing: boolean;
};

function createStepKey() {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

export function ProcessTemplateForm({
  entityTypes,
  members,
  saveProcessTemplateAction,
  initialState,
  isEditing,
}: ProcessTemplateFormProps) {
  const [state, formAction, pending] = useActionState(
    saveProcessTemplateAction,
    initialState,
  );
  const [steps, setSteps] = useState<LocalStep[]>(() =>
    state.values.steps.map((step) => ({
      key: createStepKey(),
      nodeId: step.nodeId,
      name: step.name,
      assigneeUserId: step.assigneeUserId,
    })),
  );

  function updateStepName(key: string, name: string) {
    setSteps((current) =>
      current.map((step) => (step.key === key ? { ...step, name } : step)),
    );
  }

  function updateStepAssignee(key: string, assigneeUserId: string) {
    setSteps((current) =>
      current.map((step) => (step.key === key ? { ...step, assigneeUserId } : step)),
    );
  }

  function addStep() {
    setSteps((current) => [
      ...current,
      { key: createStepKey(), nodeId: "", name: "", assigneeUserId: "" },
    ]);
  }

  function removeStep(key: string) {
    setSteps((current) =>
      current.length <= 1 ? current : current.filter((step) => step.key !== key),
    );
  }

  function moveStep(key: string, direction: "up" | "down") {
    setSteps((current) => {
      const index = current.findIndex((step) => step.key === key);
      const swapWith = direction === "up" ? index - 1 : index + 1;

      if (index === -1 || swapWith < 0 || swapWith >= current.length) {
        return current;
      }

      const next = [...current];

      [next[index], next[swapWith]] = [next[swapWith], next[index]];

      return next;
    });
  }

  return (
    <section className="mx-auto w-full max-w-3xl border border-slate-200 bg-white p-5">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-slate-950">
          {isEditing ? "Edit Process Template" : "New Process Template"}
        </h1>
        {state.message ? (
          <p
            className={`mt-2 text-sm ${state.success ? "text-emerald-700" : "text-red-700"}`}
            role="status"
          >
            {state.message}
          </p>
        ) : null}
        <FieldError message={state.errors._form} />
      </div>

      <form action={formAction} className="flex flex-col gap-5">
        <div>
          <label htmlFor="process-template-name" className="block text-sm font-medium text-slate-800">
            Name<span className="ml-1 text-red-700" aria-hidden="true">*</span>
          </label>
          <input
            id="process-template-name"
            name="name"
            type="text"
            required
            defaultValue={state.values.name}
            aria-invalid={state.errors.name ? "true" : "false"}
            className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          />
          <FieldError message={state.errors.name} />
        </div>

        <div>
          <label htmlFor="process-template-description" className="block text-sm font-medium text-slate-800">
            Description
          </label>
          <textarea
            id="process-template-description"
            name="description"
            rows={2}
            defaultValue={state.values.description}
            className="mt-1 block w-full border border-slate-300 px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-950"
          />
        </div>

        <div>
          <label htmlFor="process-template-applies-to" className="block text-sm font-medium text-slate-800">
            Applies to<span className="ml-1 text-red-700" aria-hidden="true">*</span>
          </label>
          {isEditing ? (
            <>
              <input
                type="hidden"
                name="appliesToEntityTypeId"
                value={state.values.appliesToEntityTypeId}
              />
              <p className="mt-1 h-10 border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                {entityTypes.find(
                  (entityType) => entityType.id === state.values.appliesToEntityTypeId,
                )?.name ?? "Unknown entity"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                The entity a process template applies to cannot be changed after creation.
              </p>
            </>
          ) : (
            <select
              id="process-template-applies-to"
              name="appliesToEntityTypeId"
              required
              defaultValue={state.values.appliesToEntityTypeId}
              aria-invalid={state.errors.appliesToEntityTypeId ? "true" : "false"}
              className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
            >
              <option value="">Choose entity type</option>
              {entityTypes.map((entityType) => (
                <option key={entityType.id} value={entityType.id}>
                  {entityType.name}
                </option>
              ))}
            </select>
          )}
          <FieldError message={state.errors.appliesToEntityTypeId} />
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-950">Steps</h2>
            <button
              type="button"
              onClick={addStep}
              className="border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:border-slate-950 hover:text-slate-950"
            >
              + Add step
            </button>
          </div>
          <div className="flex flex-col gap-3">
            {steps.map((step, index) => (
              <div key={step.key} className="border border-slate-200 p-3">
                <input type="hidden" name="stepNodeId" value={step.nodeId} />
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label
                      htmlFor={`step-name-${step.key}`}
                      className="block text-xs font-medium uppercase tracking-wide text-slate-500"
                    >
                      Step {index + 1}
                    </label>
                    <input
                      id={`step-name-${step.key}`}
                      name="stepName"
                      type="text"
                      required
                      value={step.name}
                      onChange={(event) => updateStepName(step.key, event.target.value)}
                      className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => moveStep(step.key, "up")}
                    disabled={index === 0}
                    className="h-10 border border-slate-300 px-2 text-xs font-medium text-slate-700 hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Move Up
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStep(step.key, "down")}
                    disabled={index === steps.length - 1}
                    className="h-10 border border-slate-300 px-2 text-xs font-medium text-slate-700 hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Move Down
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStep(step.key)}
                    disabled={steps.length <= 1}
                    className="h-10 border border-slate-300 px-2 text-xs font-medium text-slate-700 hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-2 max-w-xs">
                  <label
                    htmlFor={`step-assignee-${step.key}`}
                    className="block text-xs font-medium uppercase tracking-wide text-slate-500"
                  >
                    Assignee
                  </label>
                  <select
                    id={`step-assignee-${step.key}`}
                    name="stepAssigneeUserId"
                    value={step.assigneeUserId}
                    onChange={(event) => updateStepAssignee(step.key, event.target.value)}
                    className="mt-1 block h-9 w-full border border-slate-300 bg-white px-2 text-sm text-slate-950 outline-none focus:border-slate-950"
                  >
                    <option value="">Unassigned</option>
                    {members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.email}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {pending ? "Saving..." : "Save Process Template"}
          </button>
          <Link
            href="/processes"
            className="h-10 px-2 py-2 text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
