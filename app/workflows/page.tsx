import Link from "next/link";
import {
  deleteWorkflow,
  disableWorkflow,
  enableWorkflow,
} from "@/app/actions";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { WorkflowRowActions } from "@/app/components/workflow-row-actions";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import {
  listRecentWorkflowExecutionLogs,
  listWorkflows,
} from "@/lib/domain/workflow-repository";
import type { WorkflowAction } from "@/lib/domain/workflow-types";

export const dynamic = "force-dynamic";

function describeWorkflowAction(
  action: WorkflowAction,
  entityNameById: Map<string, string>,
) {
  if (action.actionType === "update_record") {
    return "Update triggering record";
  }

  if (action.actionType === "update_related_record") {
    return "Update related record";
  }

  if (action.actionType === "start_process") {
    return "Start process";
  }

  return `Create record in ${
    action.actionTargetEntityTypeId
      ? entityNameById.get(action.actionTargetEntityTypeId) ?? "Unknown entity"
      : "Unknown entity"
  }`;
}

export default async function WorkflowsPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const [entityTypes, allEntityTypes, workflows, logs] = await Promise.all([
    listEntityTypes({ workspaceId }),
    listEntityTypes({
      workspaceId,
      includeArchived: true,
    }),
    listWorkflows({ workspaceId }),
    listRecentWorkflowExecutionLogs({ workspaceId }),
  ]);
  const entityNameById = new Map(
    allEntityTypes.map((entityType) => [entityType.id, entityType.name]),
  );
  const workflowNameById = new Map(
    workflows.map((workflow) => [workflow.id, workflow.name]),
  );

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <WorkspaceNavigation entityTypes={entityTypes} activeSection="workflows" />
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
                Configure
              </p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-950">
                Automations
              </h1>
            </div>
            <Link
              href="/workflows/new"
              className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
            >
              New Automation
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Name
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    When
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Then
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Status
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {workflows.map((workflow) => {
                  const actionContext = {
                    workflowId: workflow.id,
                  };

                  return (
                  <tr key={workflow.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/workflows/${workflow.id}/edit`}
                        className="font-medium text-slate-950 underline-offset-4 hover:underline"
                      >
                        {workflow.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {workflow.triggerType === "record_updated"
                        ? "Record updated in"
                        : "Record created in"}{" "}
                      {entityNameById.get(workflow.triggerEntityTypeId) ??
                        "Unknown entity"}
                    </td>
                    <td className="px-4 py-3">
                      {describeWorkflowAction(workflow.actions[0], entityNameById)}
                      {workflow.actions.length > 1
                        ? ` (+${workflow.actions.length - 1} more)`
                        : ""}
                    </td>
                    <td className="px-4 py-3">
                      {workflow.enabled ? "Enabled" : "Disabled"}
                    </td>
                    <td className="px-4 py-3">
                      <WorkflowRowActions
                        enabled={workflow.enabled}
                        enableWorkflowAction={enableWorkflow.bind(
                          null,
                          actionContext,
                        )}
                        disableWorkflowAction={disableWorkflow.bind(
                          null,
                          actionContext,
                        )}
                        deleteWorkflowAction={deleteWorkflow.bind(
                          null,
                          actionContext,
                        )}
                      />
                    </td>
                  </tr>
                  );
                })}
                {workflows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-slate-500" colSpan={5}>
                      No automations yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
          <h2 className="mb-4 text-xl font-semibold text-slate-950">
            Recent Execution Logs
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Automation
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Status
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Result
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Started
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-3">
                      {workflowNameById.get(log.workflowId) ?? "Automation"}
                    </td>
                    <td className="px-4 py-3">{log.status}</td>
                    <td className="px-4 py-3">
                      {log.errorMessage ??
                        log.resultMessage ??
                        (log.createdRecordId
                          ? "Record created"
                          : log.actionRecordId
                            ? "Record updated"
                            : "Completed")}
                      {log.actionResults.length > 1 ? (
                        <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
                          {log.actionResults.map((result) => (
                            <li key={result.index}>
                              Action {result.index + 1} ({result.actionType}):{" "}
                              {result.status}
                              {result.errorMessage
                                ? ` — ${result.errorMessage}`
                                : result.resultMessage
                                  ? ` — ${result.resultMessage}`
                                  : result.createdRecordId
                                    ? " — record created"
                                    : result.processRunId
                                      ? " — process started"
                                    : result.actionRecordId
                                      ? " — record updated"
                                      : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">{log.startedAt}</td>
                  </tr>
                ))}
                {logs.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-slate-500" colSpan={4}>
                      No executions logged yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
