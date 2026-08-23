import Link from "next/link";
import { CompleteStepButton } from "@/app/components/complete-step-button";
import { PageHeader, SectionHeader } from "@/app/components/page-primitives";
import type { ProcessActionState } from "@/app/process-actions";
import type { ProcessRunWithSteps } from "@/lib/domain/process-types";

type ProcessRunDetailViewProps = {
  run: ProcessRunWithSteps;
  originLabel: string;
  originHref: string;
  completeProcessStepRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

function statusBadgeClass(status: "pending" | "active" | "completed") {
  if (status === "completed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }

  if (status === "active") {
    return "border-sky-200 bg-sky-50 text-sky-900";
  }

  return "border-slate-200 bg-slate-50 text-slate-500";
}

export function ProcessRunDetailView({
  run,
  originLabel,
  originHref,
  completeProcessStepRunAction,
}: ProcessRunDetailViewProps) {
  const completedCount = run.steps.filter((step) => step.status === "completed").length;

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
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-sky-200 bg-sky-50 text-sky-900"
            }`}
          >
            {run.status === "completed" ? "Complete" : "Active"}
          </span>
        }
      />

      <section className="border border-slate-200 bg-white p-5">
        <SectionHeader
          title="Overview"
          description={`${completedCount} of ${run.steps.length} steps complete`}
        />
        <p className="mt-4 text-sm text-slate-600">
          Started from{" "}
          <Link href={originHref} className="font-medium text-slate-950 underline-offset-4 hover:underline">
            {originLabel}
          </Link>
        </p>
      </section>

      <section className="border border-slate-200 bg-white p-5">
        <SectionHeader title="Steps" />
        <ol className="mt-5 flex flex-col gap-3">
          {run.steps.map((step) => (
            <li
              key={step.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 p-3"
            >
              <div>
                <span
                  className={`inline-flex items-center border px-2 py-1 text-xs font-medium uppercase tracking-wide ${statusBadgeClass(step.status)}`}
                >
                  {step.status}
                </span>
                <p className="mt-1 text-sm font-medium text-slate-950">
                  {step.stepIndex}. {step.name}
                </p>
              </div>
              {step.status === "active" ? (
                <CompleteStepButton
                  stepRunId={step.id}
                  completeProcessStepRunAction={completeProcessStepRunAction}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
