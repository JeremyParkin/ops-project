"use client";

import { useMemo, useState } from "react";
import type { ProcessActionState } from "@/app/process-actions";
import type { ProcessRunWithSteps, ProcessStepRun } from "@/lib/domain/process-types";
import { ApprovalDecisionButtons } from "./approval-decision-buttons";
import { CompleteStepButton } from "./complete-step-button";
import { RetryActionStepButton } from "./retry-action-step-button";
import { toGraphLayoutSteps } from "./process-run-graph-adapter";
import { computeProcessGraphLayout } from "./process-graph-layout";
import { NODE_TYPE_LABELS } from "./process-graph-summaries";
import { ProcessDueAt } from "./process-due-at";
import {
  isActionableForViewer,
  isRetryableActionStep,
  joinObligationsByJoinId,
  routingResultLabel,
  statusBadgeClass,
  stepSummaryLine,
  waitRuleLabel,
} from "./process-run-graph-summaries";

const RUN_NODE_WIDTH = 200;
const RUN_NODE_HEIGHT = 116;

const STATUS_BORDER: Record<ProcessStepRun["status"], string> = {
  completed: "border-status-sage",
  active: "border-brass-deep",
  pending: "border-grit",
  skipped: "border-grit",
};

type ProcessRunGraphViewProps = {
  run: ProcessRunWithSteps;
  currentUserId: string;
  completeProcessStepRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
  decideProcessApprovalAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
  retryProcessActionStepAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

export function ProcessRunGraphView({
  run,
  currentUserId,
  completeProcessStepRunAction,
  decideProcessApprovalAction,
  retryProcessActionStepAction,
}: ProcessRunGraphViewProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const layout = useMemo(
    () =>
      computeProcessGraphLayout(toGraphLayoutSteps(run), {
        nodeWidth: RUN_NODE_WIDTH,
        nodeHeight: RUN_NODE_HEIGHT,
        rowHeight: RUN_NODE_HEIGHT + 44,
      }),
    [run],
  );
  const stepById = useMemo(() => new Map(run.steps.map((step) => [step.id, step])), [run.steps]);
  const obligationsByJoinId = useMemo(
    () => joinObligationsByJoinId(run.joinObligations),
    [run.joinObligations],
  );
  const selectedStep = selectedKey ? stepById.get(selectedKey) : undefined;

  if (run.steps.length === 0) {
    return <p className="border border-grit bg-white p-4 text-sm text-stone">No steps yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div
        className="min-w-0 flex-1 overflow-auto border border-grit bg-paper"
        style={{ maxHeight: "70vh" }}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="absolute left-0 top-0"
            width={layout.width}
            height={layout.height}
            role="presentation"
            aria-hidden="true"
          >
            {layout.edges.map((edge) => {
              const sourceStep = stepById.get(edge.sourceKey);
              const targetStep = stepById.get(edge.targetKey);

              if (!sourceStep) {
                return null;
              }

              // A route's fate is only known once its source step has
              // resolved (routingResult set). Taken routes are strong and
              // full-opacity; siblings that existed but weren't taken are
              // faint; routes out of a step that hasn't resolved yet are a
              // third, neutral "possible" treatment — deliberately not
              // relying on dash pattern alone to carry this distinction,
              // since dashing already means something different in the
              // template graph.
              const result = sourceStep.routingResult;
              const takenRouteIds = result
                ? new Set(result.selectedRouteIds ?? (result.selectedRouteId ? [result.selectedRouteId] : []))
                : null;
              const isTaken = takenRouteIds?.has(edge.id) ?? false;
              const isResolved = takenRouteIds !== null;

              const stroke = isResolved
                ? isTaken
                  ? "var(--color-graphite)"
                  : "var(--color-grit)"
                : "var(--color-grit)";
              const strokeOpacity = isResolved ? (isTaken ? 1 : 0.35) : 0.6;
              const strokeWidth = isTaken ? 2.5 : 1.5;

              return (
                <path
                  key={edge.id}
                  data-testid={`edge-${sourceStep.name}-to-${targetStep?.name ?? "unknown"}`}
                  data-taken={isResolved ? String(isTaken) : "undetermined"}
                  d={edge.path}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={strokeOpacity}
                  strokeWidth={strokeWidth}
                  strokeDasharray={isResolved ? undefined : "4 3"}
                />
              );
            })}
          </svg>

          {layout.nodes.map((node) => {
            const step = stepById.get(node.key);

            if (!step) {
              return null;
            }

            const isSelected = selectedKey === step.id;
            const isSkipped = step.status === "skipped";

            return (
              <button
                key={step.id}
                type="button"
                onClick={() => setSelectedKey(step.id)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSelectedKey(null);
                  }
                }}
                aria-pressed={isSelected}
                aria-label={`${NODE_TYPE_LABELS[step.nodeType]}: ${step.name} (${step.status})`}
                className={`absolute flex flex-col items-start gap-1 overflow-hidden border-2 bg-white p-3 text-left shadow-sm ${
                  isSelected ? "border-brass-deep" : STATUS_BORDER[step.status]
                } ${isSkipped ? "bg-chalk opacity-60" : ""}`}
                style={{ left: node.x, top: node.y, width: RUN_NODE_WIDTH, height: RUN_NODE_HEIGHT }}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-brass-deep">
                    {NODE_TYPE_LABELS[step.nodeType]}
                  </span>
                  <span
                    className={`border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
                      isRetryableActionStep(step)
                        ? "border-red-700/40 bg-red-50 text-red-700"
                        : statusBadgeClass(step.status)
                    }`}
                  >
                    {isRetryableActionStep(step) ? "Failed" : isSkipped ? "Skipped" : step.status}
                  </span>
                </div>
                <span className="line-clamp-1 text-sm font-semibold text-graphite">{step.name}</span>
                <span className="line-clamp-2 text-xs text-stone">
                  {stepSummaryLine(step, obligationsByJoinId)}
                </span>
                {step.dueAt ? (
                  <span className="text-[11px] text-stone">
                    <ProcessDueAt dueAt={step.dueAt} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="w-full flex-shrink-0 border border-grit bg-white p-4 lg:w-96"
        role="region"
        aria-label="Selected step"
      >
        {!selectedStep ? (
          <p className="text-sm text-stone">Select a step on the graph to see its details.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <span
                className={`inline-flex items-center border px-2 py-1 text-xs font-medium uppercase tracking-wide ${
                  isRetryableActionStep(selectedStep)
                    ? "border-red-700/40 bg-red-50 text-red-700"
                    : statusBadgeClass(selectedStep.status)
                }`}
              >
                {isRetryableActionStep(selectedStep)
                  ? "Failed"
                  : selectedStep.status === "skipped"
                    ? "Skipped"
                    : selectedStep.status}
              </span>
              <p className="mt-2 text-xs font-medium uppercase tracking-wide text-stone">
                {NODE_TYPE_LABELS[selectedStep.nodeType]}
              </p>
              <p className="text-sm font-semibold text-graphite">{selectedStep.name}</p>
            </div>

            {selectedStep.nodeType === "human_task" || selectedStep.nodeType === "approval" ? (
              <p className="text-sm text-stone">
                {selectedStep.assigneeLabel ? `Assigned to ${selectedStep.assigneeLabel}` : "Unassigned"}
              </p>
            ) : null}

            {selectedStep.dueAt ? (
              <p className="text-sm text-stone">
                <ProcessDueAt dueAt={selectedStep.dueAt} />
              </p>
            ) : null}

            {selectedStep.nodeType === "wait" ? (
              <p className="text-sm text-stone">
                {waitRuleLabel(selectedStep)}
                {selectedStep.resumeAt ? (
                  <>
                    {" · "}
                    <ProcessDueAt
                      dueAt={selectedStep.resumeAt}
                      prefix={selectedStep.status === "active" ? "Waiting until" : "Scheduled for"}
                    />
                  </>
                ) : null}
              </p>
            ) : null}

            {selectedStep.nodeType === "condition_wait" || selectedStep.nodeType === "external_event_wait" ? (
              <p className="text-sm text-stone">{stepSummaryLine(selectedStep, obligationsByJoinId)}</p>
            ) : null}

            {selectedStep.nodeType === "parallel_join" ? (
              <p className="text-sm text-stone">{stepSummaryLine(selectedStep, obligationsByJoinId)}</p>
            ) : null}

            {routingResultLabel(selectedStep, stepById) ? (
              <p className="border-t border-grit pt-3 text-sm text-stone">
                {routingResultLabel(selectedStep, stepById)}
              </p>
            ) : null}

            {selectedStep.decidedAt ? (
              <p className="text-xs text-stone">Decided by {selectedStep.decidedByLabel ?? "a workspace member"}</p>
            ) : null}

            {isRetryableActionStep(selectedStep) ? (
              <div className="border-t border-grit pt-3">
                <RetryActionStepButton
                  stepRunId={selectedStep.id}
                  retryProcessActionStepAction={retryProcessActionStepAction}
                />
              </div>
            ) : isActionableForViewer(selectedStep, currentUserId) ? (
              <div className="border-t border-grit pt-3">
                {selectedStep.nodeType === "human_task" ? (
                  <CompleteStepButton
                    stepRunId={selectedStep.id}
                    completeProcessStepRunAction={completeProcessStepRunAction}
                  />
                ) : (
                  <ApprovalDecisionButtons
                    stepRunId={selectedStep.id}
                    outcomes={run.routes
                      .filter(
                        (route) =>
                          route.sourceStepRunId === selectedStep.id &&
                          route.approvalOutcomeId &&
                          route.approvalOutcomeLabel,
                      )
                      .map((route) => ({
                        id: route.approvalOutcomeId!,
                        label: route.approvalOutcomeLabel!,
                      }))}
                    decideProcessApprovalAction={decideProcessApprovalAction}
                  />
                )}
              </div>
            ) : selectedStep.status === "active" &&
              (selectedStep.nodeType === "human_task" || selectedStep.nodeType === "approval") &&
              selectedStep.assigneeUserId ? (
              <p className="border-t border-grit pt-3 text-xs text-stone">
                Only the assigned member can {selectedStep.nodeType === "approval" ? "decide" : "complete this"}.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
