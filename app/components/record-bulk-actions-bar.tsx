"use client";

import { useActionState, useEffect } from "react";
import { useRecordSelection } from "@/app/components/record-selection-context";
import type { RecordActionState } from "@/lib/domain/record-repository";

type BulkAction = (
  state: RecordActionState,
  formData: FormData,
) => Promise<RecordActionState>;

type RecordBulkActionsBarProps = {
  totalCount: number;
  // Restoring only ever makes sense when at least one currently-rendered
  // row is archived (true whenever "Show archived records" is on and the
  // object has any). Offering it unconditionally would mean a button
  // that's a guaranteed no-op for every selection in the default view.
  showRestoreAction: boolean;
  bulkArchiveAction: BulkAction;
  bulkRestoreAction: BulkAction;
};

const initialActionState: RecordActionState = {
  success: false,
  message: "",
};

export function RecordBulkActionsBar({
  totalCount,
  showRestoreAction,
  bulkArchiveAction,
  bulkRestoreAction,
}: RecordBulkActionsBarProps) {
  const { selectedIds, clear } = useRecordSelection();
  const [archiveState, archiveFormAction, archivePending] = useActionState(
    bulkArchiveAction,
    initialActionState,
  );
  const [restoreState, restoreFormAction, restorePending] = useActionState(
    bulkRestoreAction,
    initialActionState,
  );

  // Selection is local client state -- a successful bulk action doesn't
  // touch it on its own (revalidatePath refreshes the table's own data,
  // not this provider's state), so it's cleared explicitly here once the
  // action that consumed it succeeds. The just-archived/restored records
  // are about to disappear from (or reappear in) the current view anyway,
  // so nothing about keeping them "selected" would remain meaningful.
  useEffect(() => {
    if (archiveState.success) {
      clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveState]);
  useEffect(() => {
    if (restoreState.success) {
      clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreState]);

  const latestMessage = restoreState.message || archiveState.message;
  const latestSuccess = restoreState.message ? restoreState.success : archiveState.success;

  if (selectedIds.size === 0) {
    // Selection clears itself (above) the instant a bulk action succeeds --
    // without this branch, that same clear would unmount the whole bar,
    // including its own success message, before it was ever visible for
    // more than a single render. Show a minimal message-only bar instead,
    // persisting until the next selection/action/navigation, consistent
    // with how other status messages in this app (e.g. RecordRowActions)
    // are never auto-dismissed on a timer.
    if (!latestMessage) {
      return null;
    }

    return (
      <div className="mx-auto flex w-full max-w-6xl items-center border border-t-0 border-grit bg-chalk px-4 py-3 text-sm">
        <p
          className={latestSuccess ? "text-status-sage" : "text-red-700"}
          role="status"
        >
          {latestMessage}
        </p>
      </div>
    );
  }

  const selectedIdList = Array.from(selectedIds);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 border border-t-0 border-grit bg-chalk px-4 py-3 text-sm">
      <span className="font-medium text-graphite">
        {selectedIds.size} of {totalCount} selected
      </span>
      <button
        type="button"
        onClick={clear}
        className="font-medium text-stone underline-offset-4 hover:underline"
      >
        Clear selection
      </button>
      <form
        action={archiveFormAction}
        onSubmit={(event) => {
          if (
            !window.confirm(
              `Archive ${selectedIds.size} record${selectedIds.size === 1 ? "" : "s"}?`,
            )
          ) {
            event.preventDefault();
          }
        }}
      >
        {selectedIdList.map((recordId) => (
          <input key={recordId} type="hidden" name="recordId" value={recordId} />
        ))}
        <button
          type="submit"
          disabled={archivePending}
          className="border border-grit bg-white px-3 py-1.5 text-sm font-medium text-graphite hover:bg-slab/5 disabled:text-stone/50"
        >
          {archivePending ? "Archiving..." : "Archive selected"}
        </button>
      </form>
      {showRestoreAction ? (
        <form
          action={restoreFormAction}
          onSubmit={(event) => {
            if (
              !window.confirm(
                `Restore ${selectedIds.size} record${selectedIds.size === 1 ? "" : "s"}?`,
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          {selectedIdList.map((recordId) => (
            <input key={recordId} type="hidden" name="recordId" value={recordId} />
          ))}
          <button
            type="submit"
            disabled={restorePending}
            className="border border-grit bg-white px-3 py-1.5 text-sm font-medium text-graphite hover:bg-slab/5 disabled:text-stone/50"
          >
            {restorePending ? "Restoring..." : "Restore selected"}
          </button>
        </form>
      ) : null}
      {latestMessage ? (
        <p
          className={latestSuccess ? "text-status-sage" : "text-red-700"}
          role="status"
        >
          {latestMessage}
        </p>
      ) : null}
    </div>
  );
}
