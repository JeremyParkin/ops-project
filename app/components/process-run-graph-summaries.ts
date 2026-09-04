import type { ProcessParallelJoinObligation, ProcessStepRun } from "@/lib/domain/process-types";

// Shared between the run detail List rows and the Graph view's node
// cards/panel, so the two surfaces can never describe the same runtime
// state differently. Every function here is pure prose derived from the
// already-fetched ProcessRunWithSteps — no new data, no new semantics.

export function statusBadgeClass(status: ProcessStepRun["status"]) {
  if (status === "completed") {
    return "border-status-sage/40 bg-status-sage/10 text-status-sage";
  }

  if (status === "active") {
    return "border-brass-deep/50 bg-brass-light/20 text-brass-deep";
  }

  return "border-grit bg-chalk text-stone";
}

export function waitRuleLabel(step: ProcessStepRun) {
  const rule = step.config.waitRule;

  if (!rule) return "Automatic wait";

  if (rule.kind === "duration") {
    return `${rule.amount} ${rule.unit === "calendar_days" ? "calendar day" : "hour"}${rule.amount === 1 ? "" : "s"} after activation`;
  }

  if (rule.kind === "weekdays") {
    return `${rule.amount} weekday${rule.amount === 1 ? "" : "s"} after activation`;
  }

  if (rule.target === "nth_weekday_next_month") {
    return `${rule.ordinal}th weekday of next month at ${rule.time} ${rule.timeZone}`;
  }

  if (rule.target === "first_day_of_week_next_month") {
    return `First day-of-week target at ${rule.time} ${rule.timeZone}`;
  }

  return `${rule.date} at ${rule.time} ${rule.timeZone}`;
}

export function joinObligationsByJoinId(joinObligations: ProcessParallelJoinObligation[]) {
  const map = new Map<string, ProcessParallelJoinObligation[]>();

  joinObligations.forEach((obligation) => {
    const current = map.get(obligation.joinStepRunId) ?? [];
    current.push(obligation);
    map.set(obligation.joinStepRunId, current);
  });

  return map;
}

// The secondary summary line for a step's card/row — mirrors the per-node-
// type ternary that used to live inline in the List view exactly, so
// extracting it changed no rendered text.
export function stepSummaryLine(
  step: ProcessStepRun,
  obligationsByJoinId: Map<string, ProcessParallelJoinObligation[]>,
): string {
  if (step.nodeType === "human_task" || step.nodeType === "approval") {
    return step.assigneeLabel ? `Assigned to ${step.assigneeLabel}` : "Unassigned";
  }

  if (step.nodeType === "wait") {
    return "Wait resumes automatically.";
  }

  if (step.nodeType === "condition_wait") {
    return step.conditionWaitResult?.status === "blocked"
      ? (step.conditionWaitResult.message ?? "Waiting for a valid condition target.")
      : "Waiting for its conditions to be satisfied.";
  }

  if (step.nodeType === "external_event_wait") {
    return "Waiting for external event.";
  }

  if (step.nodeType === "action") {
    if (step.actionResult?.status === "failed") {
      return step.actionResult.errorMessage ?? "Action failed. Retry when ready.";
    }

    if (step.actionResult?.status === "succeeded") {
      return step.actionResult.resultMessage ?? "Action completed.";
    }

    return "Runs automatically.";
  }

  if (step.nodeType === "parallel_split") {
    return "Parallel paths activate automatically.";
  }

  const obligations = obligationsByJoinId.get(step.id) ?? [];
  const arrived = obligations.filter((obligation) => obligation.arrivedAt).length;

  if (obligations.length === 0) {
    return "Parallel join advances automatically.";
  }

  if (step.status === "completed") {
    return `${arrived} of ${obligations.length} branches joined.`;
  }

  if (step.status === "cancelled") {
    return `Cancelled with ${arrived} of ${obligations.length} branches joined.`;
  }

  return `Waiting for ${arrived} of ${obligations.length} branches.`;
}

// Mirrors the routing-outcome prose that used to live inline in the List
// view exactly (same ternary, same wording), now a pure function so the
// Graph panel can show identical decision/history text.
export function routingResultLabel(
  step: ProcessStepRun,
  stepById: Map<string, ProcessStepRun>,
): string | undefined {
  const result = step.routingResult;

  if (!result) {
    return undefined;
  }

  const outcomeText =
    result.outcome === "approval_outcome"
      ? `Decision: ${step.approvalOutcomeLabel ?? result.approvalOutcomeLabel ?? "Recorded"}`
      : result.outcome === "condition_satisfied"
        ? "Condition satisfied"
        : result.outcome === "external_event_received"
          ? "External event accepted"
          : result.outcome === "action_succeeded"
            ? "Action completed"
            : result.outcome === "parallel_split"
              ? "Parallel branches activated"
              : result.outcome === "parallel_join"
                ? "Parallel paths joined"
                : result.outcome === "default_fallback"
                  ? "Otherwise route"
                  : result.outcome === "matched_condition"
                    ? "Conditional route matched"
                    : "Continued to next step";

  const targetStepRunId = result.targetStepRunId;
  const targetName =
    targetStepRunId && stepById.get(targetStepRunId) ? `: ${stepById.get(targetStepRunId)?.name}` : "";

  return `${outcomeText}${targetName}`;
}

// A run step is human-actionable when its own action would move it forward
// (human_task/approval, currently active) and the viewer is authorized —
// unassigned steps are open to any member, assigned ones only to their
// assignee. Mirrors the exact same condition the List view already uses
// for showing CompleteStepButton/ApprovalDecisionButtons.
export function isActionableForViewer(step: ProcessStepRun, currentUserId: string) {
  if (step.status !== "active") {
    return false;
  }

  if (step.nodeType !== "human_task" && step.nodeType !== "approval") {
    return false;
  }

  return !step.assigneeUserId || step.assigneeUserId === currentUserId;
}

// An action step's automatic execution failed and is waiting for someone to
// retry it. Action nodes have no assignee (structurally, per the runtime
// shape check), so this is open to any workspace member — unlike
// isActionableForViewer, which is assignee-scoped.
export function isRetryableActionStep(step: ProcessStepRun) {
  return step.nodeType === "action" && step.status === "active" && step.actionResult?.status === "failed";
}
