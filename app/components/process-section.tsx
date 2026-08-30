import Link from "next/link";
import { SectionHeader } from "@/app/components/page-primitives";
import { ProcessDueAt } from "@/app/components/process-due-at";
import { ProcessRecurrencePanel } from "@/app/components/process-recurrence-panel";
import { StartProcessButton } from "@/app/components/start-process-button";
import type { ProcessActionState } from "@/app/process-actions";
import type { ProcessRun, ProcessTemplate } from "@/lib/domain/process-types";
import type { ProcessRecurrenceRule } from "@/lib/domain/recurrence-types";

type RecurrenceAction = (
  state: ProcessActionState,
  formData: FormData,
) => Promise<ProcessActionState>;

export type ProcessSectionEntry = {
  template: ProcessTemplate;
  latestRun?: ProcessRun;
  stepSummary?: {
    completed: number;
    total: number;
    activeStepCount: number;
    currentStepName?: string;
    currentStepAssigneeLabel?: string;
    currentStepDueAt?: string;
  };
  startProcessRunAction: (
    state: ProcessActionState,
    formData: FormData,
  ) => Promise<ProcessActionState>;
  recurrence?: {
    rule?: ProcessRecurrenceRule;
    workspaceTimezone: string;
    createAction: RecurrenceAction;
    updateAction: RecurrenceAction;
    setActiveAction: RecurrenceAction;
  };
};

type ProcessSectionProps = {
  entries: ProcessSectionEntry[];
};

export function ProcessSection({ entries }: ProcessSectionProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="border border-grit bg-white p-5">
      <SectionHeader title="Processes" />
      <div className="mt-5 flex flex-col gap-4">
        {entries.map((entry) => {
          const { template, latestRun, stepSummary } = entry;

          return (
            <div key={template.id} className="border border-grit p-4">
              <h3 className="text-sm font-semibold text-graphite">{template.name}</h3>

              {!latestRun ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-stone">Not started</p>
                  <StartProcessButton startProcessRunAction={entry.startProcessRunAction} />
                </div>
              ) : latestRun.status === "active" ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-stone">
                      Active
                      {stepSummary
                        ? ` · ${stepSummary.completed} of ${stepSummary.total} steps complete`
                        : ""}
                    </p>
                    {stepSummary?.currentStepName ? (
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm text-stone">
                        <span
                          aria-hidden="true"
                          className="inline-block h-1.5 w-1.5 rounded-full bg-brass-deep"
                        />
                        Current: {stepSummary.currentStepName}
                        {stepSummary.currentStepAssigneeLabel
                          ? ` · ${stepSummary.currentStepAssigneeLabel}`
                          : ""}
                      </p>
                    ) : null}
                    {stepSummary && stepSummary.activeStepCount > 1 ? (
                      <p className="mt-0.5 text-sm text-stone">
                        {stepSummary.activeStepCount} active steps
                      </p>
                    ) : null}
                    {stepSummary?.currentStepDueAt ? (
                      <p className="mt-0.5 text-xs text-stone">
                        <ProcessDueAt dueAt={stepSummary.currentStepDueAt} />
                      </p>
                    ) : null}
                  </div>
                  <Link
                    href={`/process-runs/${latestRun.id}`}
                    className="text-sm font-medium text-graphite underline-offset-4 hover:underline"
                  >
                    Open process
                  </Link>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-stone">
                      Completed
                      {stepSummary ? ` · ${stepSummary.completed} of ${stepSummary.total} steps` : ""}
                    </p>
                    <Link
                      href={`/process-runs/${latestRun.id}`}
                      className="text-sm font-medium text-stone underline-offset-4 hover:underline"
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
              {entry.recurrence ? (
                <ProcessRecurrencePanel
                  rule={entry.recurrence.rule}
                  workspaceTimezone={entry.recurrence.workspaceTimezone}
                  createAction={entry.recurrence.createAction}
                  updateAction={entry.recurrence.updateAction}
                  setActiveAction={entry.recurrence.setActiveAction}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
