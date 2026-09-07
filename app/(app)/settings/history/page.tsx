import { WorkspaceAdministrativeHistoryClient } from "@/app/components/workspace-administrative-history-client";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { listWorkspaceAdministrativeHistory } from "@/lib/domain/workspace-administrative-history-repository";
import type { WorkspaceAdministrativeHistoryFilters } from "@/lib/domain/workspace-administrative-history-repository";

export const dynamic = "force-dynamic";

const categories = new Set(["Schema", "Access", "Organization", "People & Identity", "Sensitive Configuration", "Support / Impersonation"]);

function dateBounds(days: string | undefined) {
  if (!days || days === "all") return {};
  const parsed = Number(days);
  if (!Number.isInteger(parsed) || ![7, 30, 90].includes(parsed)) return {};
  return { startAt: new Date(Date.now() - parsed * 24 * 60 * 60 * 1000).toISOString() };
}

export default async function AdministrativeHistoryPage({ searchParams }: { searchParams: Promise<{ category?: string; days?: string }> }) {
  const { workspaceId } = await getActiveWorkspaceId();
  const { category: rawCategory, days } = await searchParams;
  const datePreset = days && ["7", "30", "90"].includes(days) ? days : "all";
  const category = rawCategory && categories.has(rawCategory) ? rawCategory : undefined;
  const filters: WorkspaceAdministrativeHistoryFilters = { ...dateBounds(datePreset) };
  if (category) filters.category = category;
  const [permissions, impersonation] = await Promise.all([
    getWorkspacePermissionContext(workspaceId),
    resolveImpersonationContext(workspaceId),
  ]);
  const canRead = permissions?.capabilities.has("workspace.audit.read") ?? false;
  let historyContent = null;
  if (canRead && !impersonation.isImpersonating) {
    let result;
    try {
      result = await listWorkspaceAdministrativeHistory({ workspaceId, filters });
    } catch {
      historyContent = <p className="border border-grit bg-paper p-5 text-sm text-graphite">Administrative history couldn’t be loaded.</p>;
    }
    if (result) {
      historyContent = <WorkspaceAdministrativeHistoryClient initialEvents={result.events} initialCursor={result.nextCursor} initialFilters={filters} initialDatePreset={datePreset} />;
    }
  }

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="Configure"
        title="Administrative history"
        description="Shows supported administrative and configuration changes recorded by Kinema. Record edits and operational run history remain available in their own activity and runtime views."
      />
      {!canRead ? (
        <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
          <h2 className="text-lg font-semibold text-graphite">Administrative history is managed by workspace administrators.</h2>
        </section>
      ) : impersonation.isImpersonating ? (
        <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
          <h2 className="text-lg font-semibold text-graphite">Administrative history isn’t available while impersonating.</h2>
        </section>
      ) : (
        historyContent
      )}
    </WorkspacePageLayout>
  );
}
