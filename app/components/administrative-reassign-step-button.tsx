"use client";

import { useActionState, useState } from "react";
import type { ProcessActionState } from "@/app/process-actions";
import type { WorkspaceMemberIdentity } from "@/lib/domain/process-types";

type AdministrativeReassignStepButtonProps = {
  stepRunId: string;
  currentAssigneeLabel?: string;
  candidates: WorkspaceMemberIdentity[];
  reassignProcessStepRunAdministrativelyAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

const initialActionState: ProcessActionState = {
  success: false,
  message: "",
};

// Administrative (non-self) reassignment -- Phase 11.3. Visually and
// behaviorally distinct from the self-service ReassignStepButton: it can
// target any current assignee's step, and a reason is mandatory rather
// than optional, since this is a workspace-governance intervention, not
// the assignee's own choice.
export function AdministrativeReassignStepButton({
  stepRunId,
  currentAssigneeLabel,
  candidates,
  reassignProcessStepRunAdministrativelyAction,
}: AdministrativeReassignStepButtonProps) {
  const [isReassigning, setIsReassigning] = useState(false);
  const [state, formAction, pending] = useActionState(
    reassignProcessStepRunAdministrativelyAction,
    initialActionState,
  );

  if (!isReassigning) {
    return (
      <button
        type="button"
        onClick={() => setIsReassigning(true)}
        className="inline-flex h-9 items-center justify-center border border-status-ochre/60 px-3 text-sm font-medium text-status-ochre hover:border-status-ochre hover:bg-status-ochre/10"
      >
        Reassign on their behalf
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="flex w-full max-w-sm flex-col gap-2 border border-status-ochre/60 bg-chalk p-3"
    >
      <input type="hidden" name="stepRunId" value={stepRunId} />
      <p className="text-xs text-stone">
        {currentAssigneeLabel
          ? `Administratively reassign this step away from ${currentAssigneeLabel}.`
          : "Administratively reassign this step."}
      </p>
      <label htmlFor={`admin-reassign-step-${stepRunId}-assignee`} className="text-xs font-medium text-stone">
        Reassign to
      </label>
      <select
        id={`admin-reassign-step-${stepRunId}-assignee`}
        name="newAssigneeUserId"
        required
        defaultValue=""
        className="w-full border border-grit bg-white px-3 py-2 text-sm text-graphite outline-none focus:border-graphite"
      >
        <option value="" disabled>
          Choose a workspace member
        </option>
        {candidates.map((candidate) => (
          <option key={candidate.userId} value={candidate.userId}>
            {candidate.email}
          </option>
        ))}
      </select>
      <label htmlFor={`admin-reassign-step-${stepRunId}-reason`} className="text-xs font-medium text-stone">
        Reason (required)
      </label>
      <textarea
        id={`admin-reassign-step-${stepRunId}-reason`}
        name="reason"
        required
        rows={2}
        className="w-full resize-y border border-grit bg-white px-3 py-2 text-sm text-graphite outline-none focus:border-graphite"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center justify-center bg-status-ochre px-3 text-sm font-medium text-white hover:bg-status-ochre/80 disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Reassigning..." : "Confirm administrative reassignment"}
        </button>
        <button
          type="button"
          onClick={() => setIsReassigning(false)}
          disabled={pending}
          className="inline-flex h-9 items-center justify-center px-3 text-sm font-medium text-stone hover:text-graphite"
        >
          Never mind
        </button>
      </div>
      {state.message ? (
        <p className="text-xs text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
