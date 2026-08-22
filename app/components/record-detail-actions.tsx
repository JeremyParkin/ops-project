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
            className="inline-flex h-10 items-center justify-center border border-slate-950 px-4 text-sm font-medium text-slate-950"
          >
            Edit
          </Link>
        ) : null}
        {isArchived ? (
          <form action={restoreAction}>
            <button
              type="submit"
              disabled={restorePending}
              className="inline-flex h-10 items-center justify-center border border-slate-300 px-4 text-sm font-medium text-slate-800 disabled:text-slate-400"
            >
              {restorePending ? "Restoring..." : "Restore"}
            </button>
          </form>
        ) : (
          <form action={archiveAction}>
            <button
              type="submit"
              disabled={archivePending}
              className="inline-flex h-10 items-center justify-center border border-slate-300 px-4 text-sm font-medium text-slate-800 disabled:text-slate-400"
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
            className="inline-flex h-10 items-center justify-center border border-red-700 px-4 text-sm font-medium text-red-700 disabled:text-red-300"
          >
            {deletePending ? "Deleting..." : "Delete"}
          </button>
        </form>
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
