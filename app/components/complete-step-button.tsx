"use client";

import { useActionState } from "react";
import type { ProcessActionState } from "@/app/process-actions";

type CompleteStepButtonProps = {
  stepRunId: string;
  completeProcessStepRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

const initialActionState: ProcessActionState = {
  success: false,
  message: "",
};

export function CompleteStepButton({
  stepRunId,
  completeProcessStepRunAction,
}: CompleteStepButtonProps) {
  const [state, formAction, pending] = useActionState(
    completeProcessStepRunAction,
    initialActionState,
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="stepRunId" value={stepRunId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-9 items-center justify-center bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {pending ? "Completing..." : "Complete"}
      </button>
      {state.message ? (
        <p className="text-xs text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
