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

function ArchiveIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="M4.25 6.75h11.5M5.25 6.75v8a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5v-8M6.5 3.75h7l1 3h-9l1-3Zm1.75 6.25h3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="M6.25 7.25H3.75v-2.5M4 7a6.25 6.25 0 1 1-.25 3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="M4.5 6h11M8.25 6V4.75a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1V6m2.5 0-.5 9.25a1.5 1.5 0 0 1-1.5 1.42h-4.5a1.5 1.5 0 0 1-1.5-1.42L5.75 6m3 3.25v4.5m2.5-4.5v4.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {isArchived ? (
          <form action={restoreAction}>
            <button
              type="submit"
              disabled={restorePending}
              title="Restore"
              className="inline-flex h-8 items-center gap-1.5 border border-grit bg-white px-2 text-xs font-medium text-graphite hover:bg-slab/5 disabled:text-grit"
            >
              <RestoreIcon />
              {restorePending ? "Restoring..." : "Restore"}
            </button>
          </form>
        ) : (
          <form action={archiveAction}>
            <button
              type="submit"
              disabled={archivePending}
              title="Archive"
              className="inline-flex h-8 items-center gap-1.5 border border-grit bg-white px-2 text-xs font-medium text-stone hover:bg-slab/5 disabled:text-grit"
            >
              <ArchiveIcon />
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
            title="Delete"
            className="inline-flex h-8 items-center gap-1.5 border border-red-200 bg-white px-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:text-red-300"
          >
            <TrashIcon />
            {deletePending ? "Deleting..." : "Delete"}
          </button>
        </form>
      </div>
      {latestMessage ? (
        <p
          className={`text-xs ${latestSuccess ? "text-status-sage" : "text-red-700"}`}
          role="status"
        >
          {latestMessage}
        </p>
      ) : null}
    </div>
  );
}
