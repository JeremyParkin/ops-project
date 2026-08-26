"use client";

import { useState } from "react";
import Link from "next/link";
import { ApprovalDecisionButtons } from "@/app/components/approval-decision-buttons";
import { CompleteStepButton } from "@/app/components/complete-step-button";
import { PageHeader, SectionHeader } from "@/app/components/page-primitives";
import { ProcessDueAt } from "@/app/components/process-due-at";
import { ProcessRunGraphView } from "@/app/components/process-run-graph-view";
import {
  isActionableForViewer,
  joinObligationsByJoinId,
  routingResultLabel,
  statusBadgeClass,
  stepSummaryLine,
  waitRuleLabel,
} from "@/app/components/process-run-graph-summaries";
import type { ProcessActionState } from "@/app/process-actions";
import type { ProcessRunWithSteps } from "@/lib/domain/process-types";

type ProcessRunDetailViewProps = {
  run: ProcessRunWithSteps;
  originLabel: string;
  originHref: string;
  currentUserId: string;
  completeProcessStepRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
  decideProcessApprovalAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

export function ProcessRunDetailView({
  run,
  originLabel,
  originHref,
  currentUserId,
  completeProcessStepRunAction,
  decideProcessApprovalAction,
}: ProcessRunDetailViewProps) {
  const [viewMode, setViewMode] = useState<"list" | "graph">("list");
  const completedCount = run.steps.filter((step) => step.status === "completed").length;
  const skippedCount = run.steps.filter((step) => step.status === "skipped").length;
  const stepById = new Map(run.steps.map((step) => [step.id, step]));
  const obligationsByJoinId = joinObligationsByJoinId(run.joinObligations);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow="Process Run"
        title={run.processTemplateName}
        description={run.processTemplateDescription}
        actions={
          <span
            className={`border px-2 py-1 text-xs font-medium uppercase tracking-wide ${
              run.status === "completed"
                ? "border-status-sage/40 bg-status-sage/10 text-status-sage"
                : "border-status-slate/40 bg-status-slate/10 text-status-slate"
            }`}
          >
            {run.status === "completed" ? "Complete" : "Active"}
          </span>
        }
      />

      <section className="border border-grit bg-white p-5">
        <SectionHeader
          title="Overview"
          description={`${completedCount} of ${run.steps.length} steps complete${
            skippedCount > 0 ? `, ${skippedCount} skipped` : ""
          }`}
        />
        <p className="mt-4 text-sm text-stone">
          Started from{" "}
          <Link href={originHref} className="font-medium text-graphite underline-offset-4 hover:underline">
            {originLabel}
          </Link>
        </p>
      </section>

      <section className="border border-grit bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <SectionHeader title="Steps" />
          <div className="flex items-center gap-1 border border-grit p-1" role="group" aria-label="Steps view">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              aria-pressed={viewMode === "list"}
              className={`px-3 py-1.5 text-sm font-medium ${
                viewMode === "list" ? "bg-brass text-graphite" : "text-stone hover:text-graphite"
              }`}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode("graph")}
              aria-pressed={viewMode === "graph"}
              className={`px-3 py-1.5 text-sm font-medium ${
                viewMode === "graph" ? "bg-brass text-graphite" : "text-stone hover:text-graphite"
              }`}
            >
              Graph
            </button>
          </div>
        </div>

        {viewMode === "list" ? (
          <ol className="flex flex-col gap-3">
            {run.steps.map((step) => (
              <li
                key={step.id}
                className={`flex flex-wrap items-center justify-between gap-3 border p-3 ${
                  step.status === "active"
                    ? "border-grit border-l-4 border-l-brass-deep"
                    : "border-grit"
                }`}
              >
                <div>
                  <span
                    className={`inline-flex items-center border px-2 py-1 text-xs font-medium uppercase tracking-wide ${statusBadgeClass(step.status)}`}
                  >
                    {step.status}
                  </span>
                  <p className="mt-1 text-sm font-medium text-graphite">
                    {step.stepIndex}. {step.name}
                  </p>
                  <p className="mt-1 text-xs text-stone">{stepSummaryLine(step, obligationsByJoinId)}</p>
                  {step.dueAt ? (
                    <p className="mt-1 text-xs text-stone">
                      <ProcessDueAt dueAt={step.dueAt} />
                    </p>
                  ) : null}
                  {step.nodeType === "wait" ? (
                    <p className="mt-1 text-xs text-stone">
                      {waitRuleLabel(step)}
                      {step.resumeAt ? (
                        <>
                          {" · "}
                          <ProcessDueAt
                            dueAt={step.resumeAt}
                            prefix={step.status === "active" ? "Waiting until" : "Scheduled for"}
                          />
                        </>
                      ) : null}
                    </p>
                  ) : null}
                  {step.nodeType === "condition_wait" && step.conditionWaitResult?.targetRecordId ? (
                    <p className="mt-1 text-xs text-stone">Watching current record values.</p>
                  ) : null}
                  {routingResultLabel(step, stepById) ? (
                    <p className="mt-2 text-xs text-stone">{routingResultLabel(step, stepById)}</p>
                  ) : null}
                  {step.decidedAt ? (
                    <p className="mt-1 text-xs text-stone">
                      Decided by {step.decidedByLabel ?? "a workspace member"}
                    </p>
                  ) : null}
                </div>
                {isActionableForViewer(step, currentUserId) ? (
                  step.nodeType === "human_task" ? (
                    <CompleteStepButton
                      stepRunId={step.id}
                      completeProcessStepRunAction={completeProcessStepRunAction}
                    />
                  ) : (
                    <ApprovalDecisionButtons
                      stepRunId={step.id}
                      outcomes={run.routes
                        .filter(
                          (route) =>
                            route.sourceStepRunId === step.id &&
                            route.approvalOutcomeId &&
                            route.approvalOutcomeLabel,
                        )
                        .map((route) => ({
                          id: route.approvalOutcomeId!,
                          label: route.approvalOutcomeLabel!,
                        }))}
                      decideProcessApprovalAction={decideProcessApprovalAction}
                    />
                  )
                ) : step.nodeType === "approval" && step.status === "active" && step.assigneeUserId ? (
                  <p className="text-xs text-stone">Only the assigned member can decide.</p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <ProcessRunGraphView
            run={run}
            currentUserId={currentUserId}
            completeProcessStepRunAction={completeProcessStepRunAction}
            decideProcessApprovalAction={decideProcessApprovalAction}
          />
        )}
      </section>
    </div>
  );
}
