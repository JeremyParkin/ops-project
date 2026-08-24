import Link from "next/link";
import { ApprovalDecisionButtons } from "@/app/components/approval-decision-buttons";
import { CompleteStepButton } from "@/app/components/complete-step-button";
import { PageHeader, SectionHeader } from "@/app/components/page-primitives";
import { ProcessDueAt } from "@/app/components/process-due-at";
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

// Pending/completed are semantic (neutral, Sage). Active is the one place
// Brass carries meaning here — actionable work — kept to
// Brass Deep for text/border so it holds contrast on a Paper/white surface;
// Brass itself is reserved for the step's left-edge accent below.
function statusBadgeClass(status: "pending" | "active" | "completed" | "skipped") {
  if (status === "completed") {
    return "border-status-sage/40 bg-status-sage/10 text-status-sage";
  }

  if (status === "active") {
    return "border-brass-deep/50 bg-brass-light/20 text-brass-deep";
  }

  if (status === "skipped") {
    return "border-grit bg-chalk text-stone";
  }

  return "border-grit bg-chalk text-stone";
}

export function ProcessRunDetailView({
  run,
  originLabel,
  originHref,
  currentUserId,
  completeProcessStepRunAction,
  decideProcessApprovalAction,
}: ProcessRunDetailViewProps) {
  const completedCount = run.steps.filter((step) => step.status === "completed").length;
  const skippedCount = run.steps.filter((step) => step.status === "skipped").length;
  const stepById = new Map(run.steps.map((step) => [step.id, step]));
  const obligationsByJoinId = new Map<string, typeof run.joinObligations>();
  run.joinObligations.forEach((obligation) => {
    const current = obligationsByJoinId.get(obligation.joinStepRunId) ?? [];
    current.push(obligation);
    obligationsByJoinId.set(obligation.joinStepRunId, current);
  });

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
        <SectionHeader title="Steps" />
        <ol className="mt-5 flex flex-col gap-3">
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
                {step.nodeType === "human_task" || step.nodeType === "approval" ? (
                  <p className="mt-1 text-xs text-stone">
                    {step.assigneeLabel ? `Assigned to ${step.assigneeLabel}` : "Unassigned"}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-stone">
                    {step.nodeType === "parallel_split"
                      ? "Parallel paths activate automatically."
                      : (() => {
                          const obligations = obligationsByJoinId.get(step.id) ?? [];
                          const arrived = obligations.filter((obligation) => obligation.arrivedAt).length;
                          return obligations.length > 0
                            ? step.status === "completed"
                              ? `${arrived} of ${obligations.length} branches joined.`
                              : `Waiting for ${arrived} of ${obligations.length} branches.`
                            : "Parallel join advances automatically.";
                        })()}
                  </p>
                )}
                {step.dueAt ? (
                  <p className="mt-1 text-xs text-stone">
                    <ProcessDueAt dueAt={step.dueAt} />
                  </p>
                ) : null}
                {step.routingResult ? (
                  <p className="mt-2 text-xs text-stone">
                    {step.routingResult.outcome === "approval_outcome"
                      ? `Decision: ${step.approvalOutcomeLabel ?? step.routingResult.approvalOutcomeLabel ?? "Recorded"}`
                      : step.routingResult.outcome === "parallel_split"
                      ? "Parallel branches activated"
                      : step.routingResult.outcome === "parallel_join"
                        ? "Parallel paths joined"
                      : step.routingResult.outcome === "default_fallback"
                      ? "Otherwise route"
                      : step.routingResult.outcome === "matched_condition"
                        ? "Conditional route matched"
                        : "Continued to next step"}
                    {step.routingResult.targetStepRunId && stepById.get(step.routingResult.targetStepRunId)
                      ? `: ${stepById.get(step.routingResult.targetStepRunId)?.name}`
                      : ""}
                  </p>
                ) : null}
                {step.decidedAt ? (
                  <p className="mt-1 text-xs text-stone">
                    Decided by {step.decidedByLabel ?? "a workspace member"}
                  </p>
                ) : null}
              </div>
              {step.nodeType === "human_task" && step.status === "active" &&
              (!step.assigneeUserId || step.assigneeUserId === currentUserId) ? (
                <CompleteStepButton
                  stepRunId={step.id}
                  completeProcessStepRunAction={completeProcessStepRunAction}
                />
              ) : step.nodeType === "approval" && step.status === "active" ? (
                !step.assigneeUserId || step.assigneeUserId === currentUserId ? (
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
                ) : (
                  <p className="text-xs text-stone">Only the assigned member can decide.</p>
                )
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
