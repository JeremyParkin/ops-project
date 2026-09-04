"use client";

import { useActionState, useState } from "react";
import type { ProcessActionState } from "@/app/process-actions";
import type { WorkspaceMemberIdentity } from "@/lib/domain/process-types";

type ReassignStepButtonProps = {
  stepRunId: string;
  candidates: WorkspaceMemberIdentity[];
  reassignProcessStepRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

const initialActionState: ProcessActionState = {
  success: false,
  message: "",
};

// Self-reassignment only in this slice (11.2) -- this control only ever
// renders for the step's own current assignee (see process-run-detail-view
// and process-run-graph-view), so `candidates` already excludes the caller.
export function ReassignStepButton({
  stepRunId,
  candidates,
  reassignProcessStepRunAction,
}: ReassignStepButtonProps) {
  const [isReassigning, setIsReassigning] = useState(false);
  const [state, formAction, pending] = useActionState(reassignProcessStepRunAction, initialActionState);

  if (!isReassigning) {
    return (
      <button
        type="button"
        onClick={() => setIsReassigning(true)}
        className="inline-flex h-9 items-center justify-center border border-grit px-3 text-sm font-medium text-stone hover:border-graphite hover:text-graphite"
      >
        Reassign
      </button>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-2 border border-grit bg-chalk p-3">
      <input type="hidden" name="stepRunId" value={stepRunId} />
      <label htmlFor={`reassign-step-${stepRunId}-assignee`} className="text-xs font-medium text-stone">
        Reassign to
      </label>
      <select
        id={`reassign-step-${stepRunId}-assignee`}
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
      <label htmlFor={`reassign-step-${stepRunId}-reason`} className="text-xs font-medium text-stone">
        Reason (optional)
      </label>
      <textarea
        id={`reassign-step-${stepRunId}-reason`}
        name="reason"
        rows={2}
        className="w-full resize-y border border-grit bg-white px-3 py-2 text-sm text-graphite outline-none focus:border-graphite"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center justify-center bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Reassigning..." : "Confirm reassignment"}
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
