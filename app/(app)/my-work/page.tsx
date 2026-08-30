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

export const dynamic = "force-dynamic";

// "Ready now" rows get a restrained Brass Deep left edge — the one
// deliberate accent on this page — "Upcoming" rows stay plain and quiet.
function MyWorkItemRow({
  item,
  primary,
  originEntityTypeName,
}: {
  item: MyWorkItem;
  primary: boolean;
  originEntityTypeName?: string;
}) {
  return (
    <li
      className={`border border-grit p-3 ${primary ? "border-l-4 border-l-brass-deep" : ""}`}
    >
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
      {item.stepRun.dueAt ? (
        <p className="mt-1 text-xs font-medium text-stone">
          <ProcessDueAt dueAt={item.stepRun.dueAt} />
        </p>
      ) : null}
      <div className="mt-2">
        <Link
          href={`/process-runs/${item.run.id}`}
          className={
            primary
              ? "inline-flex h-8 items-center justify-center bg-brass px-3 text-xs font-medium text-graphite hover:bg-brass-deep hover:text-paper"
              : "text-xs font-medium text-stone underline-offset-4 hover:underline"
          }
        >
          {primary ? "Open" : "View process"}
        </Link>
      </div>
    </li>
  );
}

export default async function MyWorkPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const impersonation = await resolveImpersonationContext(workspaceId);
  const [allEntityTypes, summary] = await Promise.all([
    listEntityTypes({ workspaceId, includeArchived: true }),
    listMyWorkItems({
      workspaceId,
      effectiveUserId: impersonation.isImpersonating ? impersonation.effectiveUserId : undefined,
    }),
  ]);
  const entityTypeNameById = new Map(
    allEntityTypes.map((entityType) => [entityType.id, entityType.name]),
  );

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="My Work"
        title="My Work"
        description="Process steps assigned to you in this workspace."
      />

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Overdue"
          description={`${summary.overdue.length} step${summary.overdue.length === 1 ? "" : "s"}`}
        />
        {summary.overdue.length === 0 ? (
          <p className="mt-4 text-sm text-stone">Nothing overdue. You&apos;re on track.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {summary.overdue.map((item) => (
              <MyWorkItemRow
                key={item.stepRun.id}
                item={item}
                primary
                originEntityTypeName={entityTypeNameById.get(item.run.originEntityTypeId)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Ready now"
          description={`${summary.readyNow.length} step${summary.readyNow.length === 1 ? "" : "s"}`}
        />
        {summary.readyNow.length === 0 ? (
          <p className="mt-4 text-sm text-stone">No steps are ready for you right now.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {summary.readyNow.map((item) => (
              <MyWorkItemRow
                key={item.stepRun.id}
                item={item}
                primary
                originEntityTypeName={entityTypeNameById.get(item.run.originEntityTypeId)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Upcoming"
          description={`${summary.upcoming.length} step${summary.upcoming.length === 1 ? "" : "s"}`}
        />
        {summary.upcoming.length === 0 ? (
          <p className="mt-4 text-sm text-stone">Nothing upcoming.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {summary.upcoming.map((item) => (
              <MyWorkItemRow
                key={item.stepRun.id}
                item={item}
                primary={false}
                originEntityTypeName={entityTypeNameById.get(item.run.originEntityTypeId)}
              />
            ))}
          </ul>
        )}
      </section>
    </WorkspacePageLayout>
  );
}
