import Link from "next/link";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import {
  listWorkspaceHealthFindings,
  workspaceHealthCheckTypes,
  type WorkspaceHealthCheckType,
  type WorkspaceHealthFinding,
} from "@/lib/domain/workspace-health-repository";

export const dynamic = "force-dynamic";

const checkGroupCopy: Record<WorkspaceHealthCheckType, { heading: string; description: string }> = {
  no_active_fields: {
    heading: "Business objects with no active fields",
    description: "Nothing can be recorded against these objects until at least one field is active.",
  },
  missing_display_field: {
    heading: "Business objects with no usable display field",
    description: "Records show only a shortened id instead of a readable label wherever they appear.",
  },
  recurrence_unreachable: {
    heading: "Recurrence rules that can never fire",
    description: "These rules are marked active but structurally can never produce another occurrence.",
  },
  stuck_process_run: {
    heading: "Process runs stuck with no active or pending steps",
    description: "These runs are still active but have no work left to advance them.",
  },
  deactivated_assignee: {
    heading: "Active steps assigned to a deactivated member",
    description: "Nobody can act on these steps until they are reassigned.",
  },
};

function FindingRow({ finding }: { finding: WorkspaceHealthFinding }) {
  const labelParts = [
    finding.entityTypeName,
    finding.recordLabel,
    finding.processTemplateName,
    finding.memberEmail,
  ].filter(Boolean);

  return (
    <li className="border border-grit bg-paper p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-graphite">{finding.title}</p>
          <p className="mt-1 text-sm text-stone">{finding.detail}</p>
          {labelParts.length ? (
            <p className="mt-1 text-xs text-stone">{labelParts.join(" · ")}</p>
          ) : null}
        </div>
        <Link
          href={finding.fixHref}
          className="h-8 shrink-0 border border-graphite px-3 text-xs font-medium leading-8 text-graphite hover:bg-slab"
        >
          Fix
        </Link>
      </div>
    </li>
  );
}

export default async function WorkspaceHealthPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const [permissions, impersonation] = await Promise.all([
    getWorkspacePermissionContext(workspaceId),
    resolveImpersonationContext(workspaceId),
  ]);

  // Governance-adjacent and deliberately unreachable while impersonating --
  // same posture as /settings itself (8E.2): the nav link is already
  // hidden, but a direct URL must be blocked too.
  const canView = !impersonation.isImpersonating && (permissions?.capabilities.has("workspace.manage_settings") ?? false);

  if (!canView) {
    return (
      <WorkspacePageLayout>
        <PageHeader
          eyebrow="Configure"
          title="Workspace Health"
          description="Deterministic structural findings for this workspace."
        />
        <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
          <h2 className="text-lg font-semibold text-graphite">
            {impersonation.isImpersonating ? "Not available while impersonating." : "Workspace Health is managed by workspace administrators."}
          </h2>
        </section>
      </WorkspacePageLayout>
    );
  }

  const findings = await listWorkspaceHealthFindings({ workspaceId });
  const needsAttentionCount = findings.filter((finding) => finding.severity === "needs_attention").length;
  const worthReviewingCount = findings.filter((finding) => finding.severity === "worth_reviewing").length;

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="Configure"
        title="Workspace Health"
        description="Deterministic structural findings only -- no score, no AI assessment, nothing here changes automatically."
      />

      <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
        {findings.length === 0 ? (
          <p className="text-sm text-graphite">Everything looks healthy.</p>
        ) : (
          <>
            <p className="text-sm text-graphite">
              <span className="font-semibold">{needsAttentionCount}</span> needing attention
              {" · "}
              <span className="font-semibold">{worthReviewingCount}</span> worth reviewing
            </p>

            <div className="mt-6 grid gap-8">
              {workspaceHealthCheckTypes.map((checkType) => {
                const group = findings.filter((finding) => finding.checkType === checkType);
                if (group.length === 0) return null;
                const copy = checkGroupCopy[checkType];

                return (
                  <div key={checkType}>
                    <h2 className="text-lg font-semibold text-graphite">{copy.heading}</h2>
                    <p className="mt-1 text-sm text-stone">{copy.description}</p>
                    <ul className="mt-3 grid gap-2">
                      {group.map((finding) => <FindingRow key={finding.findingId} finding={finding} />)}
                    </ul>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </WorkspacePageLayout>
  );
}
