"use client";

import { useActionState } from "react";
import type { WorkflowActionState } from "@/app/actions";

type WorkflowRowActionsProps = {
  enabled: boolean;
  enableWorkflowAction: (
    state: WorkflowActionState,
    formData: FormData,
  ) => Promise<WorkflowActionState>;
  disableWorkflowAction: (
    state: WorkflowActionState,
    formData: FormData,
  ) => Promise<WorkflowActionState>;
  deleteWorkflowAction: (
    state: WorkflowActionState,
    formData: FormData,
  ) => Promise<WorkflowActionState>;
};

const initialActionState: WorkflowActionState = {
  success: false,
  message: "",
};

export function WorkflowRowActions({
  enabled,
  enableWorkflowAction,
  disableWorkflowAction,
  deleteWorkflowAction,
}: WorkflowRowActionsProps) {
  const [enableState, enableAction, enablePending] = useActionState(
    enableWorkflowAction,
    initialActionState,
  );
  const [disableState, disableAction, disablePending] = useActionState(
    disableWorkflowAction,
    initialActionState,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteWorkflowAction,
    initialActionState,
  );
  const latestMessage =
    deleteState.message || disableState.message || enableState.message;
  const latestSuccess =
    deleteState.message ? deleteState.success : disableState.message
      ? disableState.success
      : enableState.success;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {enabled ? (
          <form action={disableAction}>
            <button
              type="submit"
              disabled={disablePending}
              className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline disabled:text-slate-400"
            >
              {disablePending ? "Disabling..." : "Disable"}
            </button>
          </form>
        ) : (
          <form action={enableAction}>
            <button
              type="submit"
              disabled={enablePending}
              className="text-sm font-medium text-slate-950 underline-offset-4 hover:underline disabled:text-slate-400"
            >
              {enablePending ? "Enabling..." : "Enable"}
            </button>
          </form>
        )}

        <form
          action={deleteAction}
          onSubmit={(event) => {
            if (
              !window.confirm(
                "Delete this workflow? Existing execution logs will also be removed.",
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
