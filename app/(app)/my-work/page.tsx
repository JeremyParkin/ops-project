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

// A distinct row shape from MyWorkItemRow, deliberately: a Record Work
// assignment has no "complete" action here (Status, when configured, is an
// ordinary field on the record itself) and no assignee-only authority --
// the link goes to the record's own detail page, whose existing
// authorization decides what the viewer can actually do there.
function AssignedRecordItemRow({ item }: { item: AssignedRecordWorkItem }) {
  return (
    <li
      className={`border border-grit p-3 ${item.isOverdue ? "border-l-4 border-l-brass-deep" : ""}`}
    >
      <p className="text-sm font-semibold text-graphite">
        <Link href={item.href} className="underline-offset-4 hover:underline">
          {item.recordLabel}
        </Link>
      </p>
      <p className="mt-1 text-sm text-stone">{item.entityTypeName}</p>
      {item.dueDate ? (
        <p className={`mt-1 text-xs font-medium ${item.isOverdue ? "text-red-700" : "text-stone"}`}>
          Due {formatAssignedRecordDueDate(item.dueDate)}
          {item.isOverdue ? " · Overdue" : ""}
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
  const assignedRecordsOverdue = assignedRecords.filter((item) => item.isOverdue);
  const assignedRecordsUpcoming = assignedRecords.filter((item) => !item.isOverdue && item.dueDate);
  const assignedRecordsNoDueDate = assignedRecords.filter((item) => !item.isOverdue && !item.dueDate);

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="My Work"
        title="My Work"
        description="Process steps and business records assigned to you in this workspace."
      />

      <h2 className="mx-auto w-full max-w-6xl text-xl font-semibold text-graphite">Process work</h2>

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

      <h2 className="mx-auto mt-2 w-full max-w-6xl text-xl font-semibold text-graphite">Assigned records</h2>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Overdue"
          description={`${assignedRecordsOverdue.length} record${assignedRecordsOverdue.length === 1 ? "" : "s"}`}
        />
        {assignedRecordsOverdue.length === 0 ? (
          <p className="mt-4 text-sm text-stone">Nothing overdue. You&apos;re on track.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {assignedRecordsOverdue.map((item) => (
              <AssignedRecordItemRow key={`${item.entityTypeId}:${item.recordId}`} item={item} />
            ))}
          </ul>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Upcoming"
          description={`${assignedRecordsUpcoming.length} record${assignedRecordsUpcoming.length === 1 ? "" : "s"}`}
        />
        {assignedRecordsUpcoming.length === 0 ? (
          <p className="mt-4 text-sm text-stone">Nothing due soon.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {assignedRecordsUpcoming.map((item) => (
              <AssignedRecordItemRow key={`${item.entityTypeId}:${item.recordId}`} item={item} />
            ))}
          </ul>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="No due date"
          description={`${assignedRecordsNoDueDate.length} record${assignedRecordsNoDueDate.length === 1 ? "" : "s"}`}
        />
        {assignedRecordsNoDueDate.length === 0 ? (
          <p className="mt-4 text-sm text-stone">Nothing here.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {assignedRecordsNoDueDate.map((item) => (
              <AssignedRecordItemRow key={`${item.entityTypeId}:${item.recordId}`} item={item} />
            ))}
          </ul>
        )}
      </section>
    </WorkspacePageLayout>
  );
}
