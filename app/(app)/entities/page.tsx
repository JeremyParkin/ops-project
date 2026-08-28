import Link from "next/link";
import { redirect } from "next/navigation";
import { EntityTypeBrowser } from "@/app/components/entity-type-browser";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";

export const dynamic = "force-dynamic";

export default async function AllObjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ showArchived?: string; manage?: string }>;
}) {
  const { showArchived: showArchivedParam, manage: manageParam } = await searchParams;
  const { workspaceId } = await getActiveWorkspaceId();
  const permissions = await getWorkspacePermissionContext(workspaceId);
  const canManageSchema = Boolean(permissions?.capabilities.has("schema.manage"));

  // Canonicalize away from an explicit ?manage=true for a caller without
  // schema.manage, the same way the entity page itself does for its own
  // ?manage=true -- an unauthorized caller lands on the plain browsing URL
  // rather than a degraded version of the configuration surface.
  if (manageParam === "true" && !canManageSchema) {
    redirect("/entities");
  }

  const isManaging = manageParam === "true" && canManageSchema;
  const showArchived = isManaging && showArchivedParam === "true";
  const entityTypes = await listEntityTypes({
    workspaceId,
    includeArchived: showArchived,
  });

  return (
    <WorkspacePageLayout>
      {isManaging ? (
        <PageHeader
          eyebrow="Configure"
          title="Data model"
          description="Create and manage the business objects that make up this workspace's data model."
          actions={
            <Link
              href="/entities/new"
              className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
            >
              Create object
            </Link>
          }
        />
      ) : (
        <PageHeader
          eyebrow="Business"
          title="All objects"
          description="Every active business object in this workspace."
        />
      )}
      <section className="mx-auto w-full max-w-6xl">
        <EntityTypeBrowser entityTypes={entityTypes} />
        {isManaging ? (
          <div className="mt-4">
            <Link
              href={showArchived ? "/entities?manage=true" : "/entities?manage=true&showArchived=true"}
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
