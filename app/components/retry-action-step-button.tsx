"use client";

import { useActionState } from "react";
import type { ProcessActionState } from "@/app/process-actions";

type RetryActionStepButtonProps = {
  stepRunId: string;
  retryProcessActionStepAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

const initialActionState: ProcessActionState = {
  success: false,
  message: "",
};

export function RetryActionStepButton({
  stepRunId,
  retryProcessActionStepAction,
}: RetryActionStepButtonProps) {
  const [state, formAction, pending] = useActionState(
    retryProcessActionStepAction,
    initialActionState,
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="stepRunId" value={stepRunId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-9 items-center justify-center bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
      >
        {pending ? "Retrying..." : "Retry"}
      </button>
      {state.message ? (
        <p className="text-xs text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
