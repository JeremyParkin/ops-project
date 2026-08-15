import { redirect } from "next/navigation";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
import { listEntityTypes } from "@/lib/domain/metadata-repository";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    showArchivedEntities?: string;
  }>;
}) {
  const { showArchivedEntities: showArchivedEntitiesParam } =
    await searchParams;
  const showArchivedEntities = showArchivedEntitiesParam === "true";
  const entityTypes = await listEntityTypes({
    workspaceId: DEMO_WORKSPACE_ID,
    includeArchived: showArchivedEntities,
  });
  const firstEntityType = entityTypes[0];

  if (!firstEntityType) {
    redirect(
      showArchivedEntities
        ? "/entities/new?showArchivedEntities=true"
        : "/entities/new",
    );
  }

  redirect(
    showArchivedEntities
      ? `/entities/${firstEntityType.id}?showArchivedEntities=true`
      : `/entities/${firstEntityType.id}`,
  );
}
