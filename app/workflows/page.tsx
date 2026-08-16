import Link from "next/link";
import {
  deleteWorkflow,
  disableWorkflow,
  enableWorkflow,
} from "@/app/actions";
import { EntityNavigation } from "@/app/components/entity-navigation";
import { WorkflowRowActions } from "@/app/components/workflow-row-actions";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import {
  listRecentWorkflowExecutionLogs,
  listWorkflows,
} from "@/lib/domain/workflow-repository";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const [entityTypes, allEntityTypes, workflows, logs] = await Promise.all([
    listEntityTypes({ workspaceId: DEMO_WORKSPACE_ID }),
    listEntityTypes({
      workspaceId: DEMO_WORKSPACE_ID,
      includeArchived: true,
    }),
    listWorkflows({ workspaceId: DEMO_WORKSPACE_ID }),
    listRecentWorkflowExecutionLogs({ workspaceId: DEMO_WORKSPACE_ID }),
  ]);
  const entityNameById = new Map(
    allEntityTypes.map((entityType) => [entityType.id, entityType.name]),
  );
  const workflowNameById = new Map(
    workflows.map((workflow) => [workflow.id, workflow.name]),
  );

  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 text-foreground sm:px-10 lg:flex-row">
      <EntityNavigation entityTypes={entityTypes} />
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
                Workflows
              </p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-950">
                Automations
              </h1>
            </div>
            <Link
              href="/workflows/new"
              className="inline-flex h-10 items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white"
            >
              New Workflow
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
                      {workflow.actionType === "update_record"
                        ? "Update triggering record"
                        : `Create record in ${
                            workflow.actionTargetEntityTypeId
                              ? entityNameById.get(
                                  workflow.actionTargetEntityTypeId,
                                ) ?? "Unknown entity"
                              : "Unknown entity"
                          }`}
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
                      No workflows yet.
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
                    Workflow
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
                      {workflowNameById.get(log.workflowId) ?? "Workflow"}
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
