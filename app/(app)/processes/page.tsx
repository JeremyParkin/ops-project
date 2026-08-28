import Link from "next/link";
import {
  archiveProcessTemplateAction,
  deleteProcessTemplateAction,
  restoreProcessTemplateAction,
} from "@/app/process-actions";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { ProcessRowActions } from "@/app/components/process-row-actions";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { listProcessTemplates } from "@/lib/domain/process-repository";

export const dynamic = "force-dynamic";

export default async function ProcessesPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const [allEntityTypes, processTemplates] = await Promise.all([
    listEntityTypes({ workspaceId, includeArchived: true }),
    listProcessTemplates({ workspaceId, includeArchived: true }),
  ]);
  const entityNameById = new Map(
    allEntityTypes.map((entityType) => [entityType.id, entityType.name]),
  );

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="Configure"
        title="Process Templates"
        description="Reusable, repeatable sequences of human-task steps that can be started from a compatible record."
        actions={
          <Link
            href="/processes/new"
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
          >
            New Process Template
          </Link>
        }
      />
      <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">Name</th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Applies to
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
                {processTemplates.map((template) => {
                  const actionContext = {
                    workspaceId,
                    processTemplateId: template.id,
                  };
                  const isArchived = Boolean(template.archivedAt);

                  return (
                    <tr key={template.id} className={isArchived ? "bg-slate-50 text-slate-500" : ""}>
                      <td className="px-4 py-3">
                        <Link
                          href={`/processes/${template.id}/edit`}
                          className="font-medium text-slate-950 underline-offset-4 hover:underline"
                        >
                          {template.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {entityNameById.get(template.appliesToEntityTypeId) ?? "Unknown entity"}
                      </td>
                      <td className="px-4 py-3">{isArchived ? "Archived" : "Active"}</td>
                      <td className="px-4 py-3">
                        <ProcessRowActions
                          isArchived={isArchived}
                          archiveProcessTemplateAction={archiveProcessTemplateAction.bind(
                            null,
                            actionContext,
                          )}
                          restoreProcessTemplateAction={restoreProcessTemplateAction.bind(
                            null,
                            actionContext,
                          )}
                          deleteProcessTemplateAction={deleteProcessTemplateAction.bind(
                            null,
                            actionContext,
                          )}
                        />
                      </td>
                    </tr>
                  );
                })}
                {processTemplates.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-slate-500" colSpan={4}>
                      No process templates yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
      </section>
    </WorkspacePageLayout>
  );
}
