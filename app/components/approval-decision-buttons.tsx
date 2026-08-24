"use client";

import { useActionState } from "react";
import type { ProcessActionState } from "@/app/process-actions";

export function ApprovalDecisionButtons({
  stepRunId,
  outcomes,
  decideProcessApprovalAction,
}: {
  stepRunId: string;
  outcomes: Array<{ id: string; label: string }>;
  decideProcessApprovalAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
}) {
  const [state, formAction, pending] = useActionState(decideProcessApprovalAction, {
    success: false,
    message: "",
  });

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="stepRunId" value={stepRunId} />
      <div className="flex flex-wrap justify-end gap-2">
        {outcomes.map((outcome) => (
          <button
            key={outcome.id}
            type="submit"
            name="outcomeId"
            value={outcome.id}
            disabled={pending}
            className="inline-flex h-9 items-center justify-center border border-brass-deep px-3 text-xs font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:opacity-50"
          >
            {outcome.label}
          </button>
        ))}
      </div>
      {state.message ? (
        <p className={`text-xs ${state.success ? "text-status-sage" : "text-red-700"}`} role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
