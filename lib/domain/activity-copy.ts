import type { RecordActivityEvent } from "./activity-types";

export type ActivityCopy = {
  title: string;
  /** Short secondary text (e.g. "Scheduled") -- omitted when there's nothing useful to add. */
  meta?: string;
  href?: string;
};

function processRunHref(processRunId?: string) {
  return processRunId ? `/process-runs/${processRunId}` : undefined;
}

// Pure event -> human copy. Operational language only, no implementation
// vocabulary (no "step run", "node", "RPC", IDs) -- see Phase 8D.3 scope.
// actorLabel/actorUserId being absent IS the "system-triggered" signal for
// process_started (see the migration's actor-semantics design); there is no
// separate "trigger source" field to branch on.
export function formatActivityEvent(event: RecordActivityEvent): ActivityCopy {
  const runName = event.processRunName ?? "Process";

  switch (event.eventType) {
    case "process_started": {
      const isAutomatic = !event.actorUserId;
      return {
        title: isAutomatic ? `${runName} started automatically` : `${runName} started`,
        meta: event.isRecurrenceStarted ? "Scheduled" : undefined,
        href: processRunHref(event.processRunId),
      };
    }
    case "process_completed":
      return {
        title: `${runName} completed`,
        href: processRunHref(event.processRunId),
      };
    case "step_assigned": {
      const stepName = event.stepName ?? "a step";
      return {
        title: event.assigneeLabel
          ? `${event.assigneeLabel} was assigned ${stepName}`
          : `${stepName} was assigned`,
        href: processRunHref(event.processRunId),
      };
    }
    case "approval_decided": {
      const stepName = event.stepName ?? "Approval";
      const outcome = event.approvalOutcomeLabel?.toLowerCase();
      const decidedBy = event.actorLabel ? ` by ${event.actorLabel}` : "";
      return {
        title: outcome ? `${stepName} ${outcome}${decidedBy}` : `${stepName} decided${decidedBy}`,
        href: processRunHref(event.processRunId),
      };
    }
    case "process_cancelled": {
      const cancelledBy = event.actorLabel ? ` by ${event.actorLabel}` : "";
      return {
        title: `${runName} cancelled${cancelledBy}`,
        meta: event.cancellationReason,
        href: processRunHref(event.processRunId),
      };
    }
    case "step_reassigned": {
      const stepName = event.stepName ?? "a step";
      const from = event.fromAssigneeLabel;
      const to = event.toAssigneeLabel ?? "someone else";
      return {
        title: from ? `${stepName} reassigned from ${from} to ${to}` : `${stepName} reassigned to ${to}`,
        href: processRunHref(event.processRunId),
      };
    }
    default:
      return { title: "Activity", href: processRunHref(event.processRunId) };
  }
}
