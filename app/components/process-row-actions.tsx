"use client";

import { useActionState } from "react";
import type { ProcessActionState } from "@/app/process-actions";

type ProcessRowActionsProps = {
  isArchived: boolean;
  archiveProcessTemplateAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
  restoreProcessTemplateAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
  deleteProcessTemplateAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

const initialActionState: ProcessActionState = {
  success: false,
  message: "",
};

export function ProcessRowActions({
  isArchived,
  archiveProcessTemplateAction,
  restoreProcessTemplateAction,
  deleteProcessTemplateAction,
}: ProcessRowActionsProps) {
  const [archiveState, archiveAction, archivePending] = useActionState(
    archiveProcessTemplateAction,
    initialActionState,
  );
  const [restoreState, restoreAction, restorePending] = useActionState(
    restoreProcessTemplateAction,
    initialActionState,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteProcessTemplateAction,
    initialActionState,
  );
  const latestMessage =
    deleteState.message || restoreState.message || archiveState.message;
  const latestSuccess = deleteState.message
    ? deleteState.success
    : restoreState.message
      ? restoreState.success
      : archiveState.success;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {isArchived ? (
          <form action={restoreAction}>
            <button
              type="submit"
              disabled={restorePending}
              className="text-sm font-medium text-slate-950 underline-offset-4 hover:underline disabled:text-slate-400"
            >
              {restorePending ? "Restoring..." : "Restore"}
            </button>
          </form>
        ) : (
          <form action={archiveAction}>
            <button
              type="submit"
              disabled={archivePending}
              className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline disabled:text-slate-400"
            >
              {archivePending ? "Archiving..." : "Archive"}
            </button>
          </form>
        )}
        <form
          action={deleteAction}
          onSubmit={(event) => {
            if (
              !window.confirm(
                "Delete this process template permanently? This cannot be undone.",
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <button
            type="submit"
            disabled={deletePending}
            className="text-sm font-medium text-red-700 underline-offset-4 hover:underline disabled:text-red-300"
          >
            {deletePending ? "Deleting..." : "Delete"}
          </button>
        </form>
      </div>
      {latestMessage ? (
        <p
          className={`text-xs ${latestSuccess ? "text-emerald-700" : "text-red-700"}`}
          role="status"
        >
          {latestMessage}
        </p>
      ) : null}
    </div>
  );
}
