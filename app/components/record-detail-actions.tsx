"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { RecordActionState } from "@/lib/domain/record-repository";

type RecordDetailActionsProps = {
  editHref?: string;
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

export function RecordDetailActions({
  editHref,
  isArchived,
  archiveRecordAction,
  restoreRecordAction,
  deleteRecordAction,
}: RecordDetailActionsProps) {
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {editHref ? (
          <Link
            href={editHref}
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
          >
            Edit
          </Link>
        ) : null}
        <details className="relative">
          <summary className="inline-flex h-10 cursor-pointer items-center justify-center border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Record actions
          </summary>
          <div className="absolute right-0 z-10 mt-2 flex min-w-44 flex-col gap-3 border border-slate-200 bg-white p-3 shadow-sm">
            {isArchived ? (
              <form action={restoreAction}>
                <button
                  type="submit"
                  disabled={restorePending}
                  className="text-sm font-medium text-slate-800 underline-offset-4 hover:underline disabled:text-slate-400"
                >
                  {restorePending ? "Restoring..." : "Restore"}
                </button>
              </form>
            ) : (
              <form action={archiveAction}>
                <button
                  type="submit"
                  disabled={archivePending}
                  className="text-sm font-medium text-slate-800 underline-offset-4 hover:underline disabled:text-slate-400"
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
                className="text-left text-sm font-medium text-red-700 underline-offset-4 hover:underline disabled:text-red-300"
              >
                {deletePending ? "Deleting..." : "Delete"}
              </button>
            </form>
          </div>
        </details>
      </div>
      {latestMessage ? (
        <p
          className={`text-sm ${latestSuccess ? "text-emerald-700" : "text-red-700"}`}
          role="status"
        >
          {latestMessage}
        </p>
      ) : null}
    </div>
  );
}
