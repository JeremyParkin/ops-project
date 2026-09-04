"use client";

import { useActionState, useState } from "react";
import type { ProcessActionState } from "@/app/process-actions";

type CancelProcessRunButtonProps = {
  processRunId: string;
  cancelProcessRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

const initialActionState: ProcessActionState = {
  success: false,
  message: "",
};

// A required, truthful reason is the confirmation gate here -- no browser
// confirm() dialog, matching this codebase's preference for plain forms
// over modal primitives. The reason field disappears once cancellation
// succeeds (the button itself is gone by then -- the page revalidates and
// this component unmounts along with the rest of the now-inapplicable
// active-run UI).
export function CancelProcessRunButton({
  processRunId,
  cancelProcessRunAction,
}: CancelProcessRunButtonProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(cancelProcessRunAction, initialActionState);

  if (!isConfirming) {
    return (
      <button
        type="button"
        onClick={() => setIsConfirming(true)}
        className="inline-flex h-9 items-center justify-center border border-grit px-3 text-sm font-medium text-stone hover:border-status-oxide hover:text-status-oxide"
      >
        Cancel process
      </button>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-2 border border-grit bg-chalk p-3">
      <input type="hidden" name="processRunId" value={processRunId} />
      <p className="text-sm font-medium text-graphite">Cancel this process run?</p>
      <p className="text-xs text-stone">
        Cancelling stops this process run. Completed work, decisions, and any actions that already occurred are
        preserved and are not reversed. You can start a new run afterward.
      </p>
      <label htmlFor={`cancel-process-run-${processRunId}-reason`} className="text-xs font-medium text-stone">
        Reason (required)
      </label>
      <textarea
        id={`cancel-process-run-${processRunId}-reason`}
        name="reason"
        rows={2}
        required
        className="w-full resize-y border border-grit bg-white px-3 py-2 text-sm text-graphite outline-none focus:border-graphite"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center justify-center bg-status-oxide px-3 text-sm font-medium text-paper hover:bg-status-oxide/90 disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Cancelling..." : "Confirm cancellation"}
        </button>
        <button
          type="button"
          onClick={() => setIsConfirming(false)}
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
