import Link from "next/link";
import { ProcessDueAt } from "@/app/components/process-due-at";
import {
  PageHeader,
  SectionHeader,
  WorkspacePageLayout,
} from "@/app/components/page-primitives";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { listMyWorkItems, type MyWorkItem } from "@/lib/domain/process-repository";
import { listAssignedRecordWork, type AssignedRecordWorkItem } from "@/lib/domain/work-repository";

export const dynamic = "force-dynamic";

// Record Work due dates are plain calendar dates (YYYY-MM-DD), and
// "overdue" is already computed server-side against workspaces.timezone --
// unlike ProcessDueAt's timestamp, there is no viewer-timezone question to
// defer to hydration for. Formatted with an explicit UTC timeZone so the
// displayed calendar day never shifts against the stored date string.
function formatAssignedRecordDueDate(dueDate: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dueDate}T00:00:00Z`));
}

// Worker-facing composition only -- the underlying domain models stay
// exactly as separate as they already are (a ProcessStepRun is never a
// Record Work item and vice versa). This union exists purely to let one
// "Needs attention" list interleave both kinds by priority, with each row
// still visibly identifying what it actually is and linking to its own
// correct surface. Record Work has no "not yet ready" state to invent, so
// it is never a candidate for "Coming later" -- see buildAttentionItems.
type AttentionItem =
  | { kind: "process"; dueAtMs: number | null; overdue: boolean; item: MyWorkItem; originEntityTypeName?: string }
  | { kind: "record"; dueAtMs: number | null; overdue: boolean; item: AssignedRecordWorkItem };

// Overdue items first (both kinds mixed together), then by due date
// ascending, then items with no due date last -- Array.prototype.sort is
// stable, so within each of those buckets the original relative order
// (Process's own overdue/ready-now ordering, then Record Work's own order)
// is preserved rather than re-shuffled.
function buildAttentionItems({
  activeProcessItems,
  assignedRecords,
  entityTypeNameById,
}: {
  activeProcessItems: MyWorkItem[];
  assignedRecords: AssignedRecordWorkItem[];
  entityTypeNameById: Map<string, string>;
}): AttentionItem[] {
  const processItems: AttentionItem[] = activeProcessItems.map((item) => {
    const dueAtMs = item.stepRun.dueAt ? Date.parse(item.stepRun.dueAt) : null;
    return {
      kind: "process",
      dueAtMs,
      overdue: dueAtMs !== null && dueAtMs < Date.now(),
      item,
      originEntityTypeName: entityTypeNameById.get(item.run.originEntityTypeId),
    };
  });
  const recordItems: AttentionItem[] = assignedRecords.map((item) => ({
    kind: "record",
    dueAtMs: item.dueDate ? Date.parse(`${item.dueDate}T00:00:00Z`) : null,
    overdue: item.isOverdue,
    item,
  }));

  return [...processItems, ...recordItems].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueAtMs !== null && b.dueAtMs !== null) return a.dueAtMs - b.dueAtMs;
    if (a.dueAtMs !== null) return -1;
    if (b.dueAtMs !== null) return 1;
    return 0;
  });
}

// Every row here is currently actionable (Process "active" steps and every
// Record Work row the projection returns are both, by construction,
// current work) -- overdue is a per-item accent, not a separate section or
// a different button treatment.
function AttentionItemRow({ attentionItem }: { attentionItem: AttentionItem }) {
  if (attentionItem.kind === "process") {
    const { item, overdue, originEntityTypeName } = attentionItem;
    return (
      <li className="border border-grit border-l-4 border-l-brass-deep p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-graphite">{item.stepRun.name}</p>
          <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-stone">Process step</span>
        </div>
        {item.stepRun.nodeType === "approval" ? (
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-brass-deep">Approval</p>
        ) : null}
        <p className="mt-1 text-sm text-stone">{item.run.processTemplateName}</p>
        <p className="mt-1 text-sm text-stone">
          <Link href={item.originHref} className="underline-offset-4 hover:underline">
            {item.originRecordLabel}
          </Link>
          {originEntityTypeName ? ` · ${originEntityTypeName}` : ""}
        </p>
        {item.stepRun.dueAt ? (
          <p className={`mt-1 text-xs font-medium ${overdue ? "text-red-700" : "text-stone"}`}>
            <ProcessDueAt dueAt={item.stepRun.dueAt} />
            {overdue ? " · Overdue" : ""}
          </p>
        ) : null}
        <div className="mt-2">
          <Link
            href={`/process-runs/${item.run.id}`}
            className="inline-flex h-8 items-center justify-center bg-brass px-3 text-xs font-medium text-graphite hover:bg-brass-deep hover:text-paper"
          >
            Open
          </Link>
        </div>
      </li>
    );
  }

  const { item, overdue } = attentionItem;
  return (
    <li className="border border-grit border-l-4 border-l-brass-deep p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-graphite">
          <Link href={item.href} className="underline-offset-4 hover:underline">
            {item.recordLabel}
          </Link>
        </p>
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-stone">
          {item.entityTypeName}
        </span>
      </div>
      {item.dueDate ? (
        <p className={`mt-1 text-xs font-medium ${overdue ? "text-red-700" : "text-stone"}`}>
          Due {formatAssignedRecordDueDate(item.dueDate)}
          {overdue ? " · Overdue" : ""}
        </p>
      ) : null}
      <div className="mt-2">
        <Link
          href={item.href}
          className="text-xs font-medium text-stone underline-offset-4 hover:underline"
        >
          Open record
        </Link>
      </div>
    </li>
  );
}

// Pending Process steps only -- genuinely not-yet-ready, unlike everything
// in "Needs attention". Record Work never renders here: its model has no
// "assigned but not yet actionable" state to represent.
function ComingLaterItemRow({
  item,
  originEntityTypeName,
}: {
  item: MyWorkItem;
  originEntityTypeName?: string;
}) {
  return (
    <li className="border border-grit p-3">
      <p className="text-sm font-semibold text-graphite">{item.stepRun.name}</p>
      {item.stepRun.nodeType === "approval" ? (
        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-brass-deep">Approval</p>
      ) : null}
      <p className="mt-1 text-sm text-stone">{item.run.processTemplateName}</p>
      <p className="mt-1 text-sm text-stone">
        <Link href={item.originHref} className="underline-offset-4 hover:underline">
          {item.originRecordLabel}
        </Link>
        {originEntityTypeName ? ` · ${originEntityTypeName}` : ""}
      </p>
      <div className="mt-2">
        <Link
          href={`/process-runs/${item.run.id}`}
          className="text-xs font-medium text-stone underline-offset-4 hover:underline"
        >
          View process
        </Link>
      </div>
    </li>
  );
}

export default async function MyWorkPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const impersonation = await resolveImpersonationContext(workspaceId);
  const [allEntityTypes, summary, assignedRecords] = await Promise.all([
    listEntityTypes({ workspaceId, includeArchived: true }),
    listMyWorkItems({
      workspaceId,
      effectiveUserId: impersonation.isImpersonating ? impersonation.effectiveUserId : undefined,
    }),
    // list_assigned_record_work_authorized resolves the effective user
    // (impersonation-aware) server-side via private.current_effective_user
    // -- no client-supplied id needed here, unlike listMyWorkItems.
    listAssignedRecordWork({ workspaceId }),
  ]);
  const entityTypeNameById = new Map(
    allEntityTypes.map((entityType) => [entityType.id, entityType.name]),
  );

  const attentionItems = buildAttentionItems({
    activeProcessItems: [...summary.overdue, ...summary.readyNow],
    assignedRecords,
    entityTypeNameById,
  });

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="My Work"
        title="My Work"
        description="Process steps and business records assigned to you in this workspace."
      />

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Needs attention"
          description={`${attentionItems.length} item${attentionItems.length === 1 ? "" : "s"}`}
        />
        {attentionItems.length === 0 ? (
          <p className="mt-4 text-sm text-stone">Nothing needs your attention right now.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {attentionItems.map((attentionItem) => (
              <AttentionItemRow
                key={
                  attentionItem.kind === "process"
                    ? `process:${attentionItem.item.stepRun.id}`
                    : `record:${attentionItem.item.entityTypeId}:${attentionItem.item.recordId}`
                }
                attentionItem={attentionItem}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Coming later"
          description={`${summary.upcoming.length} step${summary.upcoming.length === 1 ? "" : "s"}`}
        />
        {summary.upcoming.length === 0 ? (
          <p className="mt-4 text-sm text-stone">Nothing coming later.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {summary.upcoming.map((item) => (
              <ComingLaterItemRow
                key={item.stepRun.id}
                item={item}
                originEntityTypeName={entityTypeNameById.get(item.run.originEntityTypeId)}
              />
            ))}
          </ul>
        )}
      </section>
    </WorkspacePageLayout>
  );
}
