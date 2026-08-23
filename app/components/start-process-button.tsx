"use client";

import { useActionState } from "react";
import type { ProcessActionState } from "@/app/process-actions";

type StartProcessButtonProps = {
  startProcessRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
  label?: string;
};

const initialActionState: ProcessActionState = {
  success: false,
  message: "",
};

export function StartProcessButton({
  startProcessRunAction,
  label = "Start process",
}: StartProcessButtonProps) {
  const [state, formAction, pending] = useActionState(
    startProcessRunAction,
    initialActionState,
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-9 items-center justify-center bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {pending ? "Starting..." : label}
      </button>
      {state.message ? (
        <p className="text-xs text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
