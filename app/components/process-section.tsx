import Link from "next/link";
import { SectionHeader } from "@/app/components/page-primitives";
import { StartProcessButton } from "@/app/components/start-process-button";
import type { ProcessActionState } from "@/app/process-actions";
import type { ProcessRun, ProcessTemplate } from "@/lib/domain/process-types";

export type ProcessSectionEntry = {
  template: ProcessTemplate;
  latestRun?: ProcessRun;
  stepSummary?: {
    completed: number;
    total: number;
    currentStepName?: string;
    currentStepAssigneeLabel?: string;
  };
  startProcessRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
};

type ProcessSectionProps = {
  entries: ProcessSectionEntry[];
};

export function ProcessSection({ entries }: ProcessSectionProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="border border-slate-200 bg-white p-5">
      <SectionHeader title="Processes" />
      <div className="mt-5 flex flex-col gap-4">
        {entries.map((entry) => {
          const { template, latestRun, stepSummary } = entry;

          return (
            <div key={template.id} className="border border-slate-200 p-4">
              <h3 className="text-sm font-semibold text-slate-950">{template.name}</h3>

              {!latestRun ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-slate-500">Not started</p>
                  <StartProcessButton startProcessRunAction={entry.startProcessRunAction} />
                </div>
              ) : latestRun.status === "active" ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-slate-700">
                      Active
                      {stepSummary
                        ? ` · ${stepSummary.completed} of ${stepSummary.total} steps complete`
                        : ""}
                    </p>
                    {stepSummary?.currentStepName ? (
                      <p className="text-sm text-slate-500">
                        Current: {stepSummary.currentStepName}
                        {stepSummary.currentStepAssigneeLabel
                          ? ` · ${stepSummary.currentStepAssigneeLabel}`
                          : ""}
                      </p>
                    ) : null}
                  </div>
                  <Link
                    href={`/process-runs/${latestRun.id}`}
                    className="text-sm font-medium text-slate-950 underline-offset-4 hover:underline"
                  >
                    Open process
                  </Link>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-slate-700">
                      Completed
                      {stepSummary ? ` · ${stepSummary.completed} of ${stepSummary.total} steps` : ""}
                    </p>
                    <Link
                      href={`/process-runs/${latestRun.id}`}
                      className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
                    >
                      View last run
                    </Link>
                  </div>
                  <StartProcessButton
                    startProcessRunAction={entry.startProcessRunAction}
                    label="Start another run"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
