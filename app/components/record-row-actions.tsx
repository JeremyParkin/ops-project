"use client";

import { useActionState } from "react";
import type { RecordActionState } from "@/lib/domain/record-repository";

type RecordRowActionsProps = {
  isArchived: boolean;
  archiveRecordAction: (
    state: RecordActionState,
    formData: FormData,
  ) => Promise<RecordActionState>;
  restoreRecordAction: (
    state: RecordActionState,
    formData: FormData,
  ) => Promise<RecordActionState>;
  deleteRecordAction: (
    state: RecordActionState,
    formData: FormData,
  ) => Promise<RecordActionState>;
};

const initialActionState: RecordActionState = {
  success: false,
  message: "",
};

export function RecordRowActions({
  isArchived,
  archiveRecordAction,
  restoreRecordAction,
  deleteRecordAction,
}: RecordRowActionsProps) {
  const [archiveState, archiveAction, archivePending] = useActionState(
    archiveRecordAction,
    initialActionState,
  );
  const [restoreState, restoreAction, restorePending] = useActionState(
    restoreRecordAction,
    initialActionState,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteRecordAction,
    initialActionState,
  );
  const latestMessage =
    deleteState.message || restoreState.message || archiveState.message;
  const latestSuccess =
    deleteState.message ? deleteState.success : restoreState.message
      ? restoreState.success
      : archiveState.success;

  return (
    <div className="flex min-w-44 flex-col gap-2">
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
                "Delete this record permanently? This cannot be undone.",
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
