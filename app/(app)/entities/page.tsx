import Link from "next/link";
import { EntityTypeBrowser } from "@/app/components/entity-type-browser";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";

export const dynamic = "force-dynamic";

export default async function AllObjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ showArchived?: string }>;
}) {
  const { showArchived: showArchivedParam } = await searchParams;
  const { workspaceId } = await getActiveWorkspaceId();
  const permissions = await getWorkspacePermissionContext(workspaceId);
  const canManageSchema = Boolean(permissions?.capabilities.has("schema.manage"));
  const showArchived = canManageSchema && showArchivedParam === "true";
  const entityTypes = await listEntityTypes({
    workspaceId,
    includeArchived: showArchived,
  });

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="Business"
        title="All objects"
        description="Every business object in this workspace."
        actions={
          canManageSchema ? (
            <Link
              href="/entities/new"
              className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
            >
              Create object
            </Link>
          ) : undefined
        }
      />
      <section className="mx-auto w-full max-w-6xl">
        <EntityTypeBrowser entityTypes={entityTypes} />
        {canManageSchema ? (
          <div className="mt-4">
            <Link
              href={showArchived ? "/entities" : "/entities?showArchived=true"}
              className="text-sm font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
            >
              {showArchived ? "Hide archived objects" : "Show archived objects"}
            </Link>
          </div>
        ) : null}
      </section>
    </WorkspacePageLayout>
  );
}
