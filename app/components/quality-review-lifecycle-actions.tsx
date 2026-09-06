"use client";

import { useActionState } from "react";
import type { RecordActionState } from "@/lib/domain/record-repository";

type RecordActionFn = (
  state: RecordActionState,
  formData: FormData,
) => Promise<RecordActionState>;

const initialActionState: RecordActionState = { success: false, message: "" };

// Phase 12.3.1: the explicit Finalize/Reopen affordances. Finalize is
// shown only to the designated Reviewer while a review is Draft; Reopen is
// shown only to a real, non-impersonating governance-authority holder
// while a review is Finalized. Neither button ever appears merely because
// the underlying capability toggle happens to be on -- the backend's own
// authority check is what ultimately decides, this is presentation only.
export function QualityReviewStatusBadge({ isFinalized }: { isFinalized: boolean }) {
  return (
    <span
      className={`border px-2 py-1 text-xs font-medium uppercase tracking-wide ${
        isFinalized ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-800"
      }`}
    >
      {isFinalized ? "Finalized" : "Draft"}
    </span>
  );
}

export function FinalizeReviewAction({ finalizeAction }: { finalizeAction: RecordActionFn }) {
  const [state, action, pending] = useActionState(finalizeAction, initialActionState);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Finalizing..." : "Finalize"}
        </button>
      </form>
      {state.message ? (
        <p className={`text-sm ${state.success ? "text-emerald-700" : "text-red-700"}`} role={state.success ? "status" : "alert"}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

export function ReopenReviewAction({ reopenAction }: { reopenAction: RecordActionFn }) {
  const [state, action, pending] = useActionState(reopenAction, initialActionState);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center justify-center border border-slate-300 px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          {pending ? "Reopening..." : "Reopen for correction"}
        </button>
      </form>
      {state.message ? (
        <p className={`text-sm ${state.success ? "text-emerald-700" : "text-red-700"}`} role={state.success ? "status" : "alert"}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
