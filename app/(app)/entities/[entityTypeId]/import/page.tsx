import Link from "next/link";
import { redirect } from "next/navigation";
import { commitImport, parseImportFile, runImportPreflight } from "@/app/import-actions";
import { ObjectContextNav } from "@/app/components/object-context-nav";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { RecordImportFlow } from "@/app/components/record-import-flow";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { getEntityContext } from "@/lib/domain/metadata-repository";
import { listEntityViews } from "@/lib/domain/view-repository";

export const dynamic = "force-dynamic";

export default async function ImportRecordsPage({
  params,
}: {
  params: Promise<{ entityTypeId: string }>;
}) {
  const { entityTypeId } = await params;
  const { workspaceId } = await getActiveWorkspaceId();
  const permissions = await getWorkspacePermissionContext(workspaceId);

  if (!permissions?.capabilities.has("records.operate")) {
    redirect(`/entities/${entityTypeId}`);
  }

  const context = { workspaceId, entityTypeId };
  const [{ entityType }, views] = await Promise.all([
    getEntityContext(context),
    listEntityViews({ workspaceId, entityTypeId }),
  ]);

  if (entityType.archivedAt) {
    redirect(`/entities/${entityTypeId}`);
  }

  return (
    <WorkspacePageLayout
      contextNav={<ObjectContextNav entityType={entityType} views={views} highlightAll={false} />}
    >
      <Link
        href={`/entities/${entityTypeId}`}
        className="text-sm font-medium text-slate-700 underline-offset-4 hover:underline"
      >
        ← {entityType.name}
      </Link>
      <PageHeader
        eyebrow={entityType.name}
        title="Import CSV"
        description={`Import rows from a CSV file into ${entityType.name}.`}
      />
      <RecordImportFlow
        entityTypeId={entityTypeId}
        entityTypeName={entityType.name}
        parseImportFileAction={parseImportFile.bind(null, context)}
        runImportPreflightAction={runImportPreflight.bind(null, context)}
        commitImportAction={commitImport.bind(null, context)}
      />
    </WorkspacePageLayout>
  );
}
