import Link from "next/link";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import {
  PageHeader,
  SectionHeader,
  WorkspacePageLayout,
} from "@/app/components/page-primitives";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { listMyWorkItems, type MyWorkItem } from "@/lib/domain/process-repository";

export const dynamic = "force-dynamic";

function MyWorkItemRow({ item, primary }: { item: MyWorkItem; primary: boolean }) {
  return (
    <li className="border border-slate-200 p-3">
      <p className="text-sm font-semibold text-slate-950">{item.stepRun.name}</p>
      <p className="mt-1 text-sm text-slate-600">{item.run.processTemplateName}</p>
      <Link
        href={item.originHref}
        className="mt-1 inline-block text-sm text-slate-500 underline-offset-4 hover:underline"
      >
        {item.originRecordLabel}
      </Link>
      <div className="mt-2">
        <Link
          href={`/process-runs/${item.run.id}`}
          className={
            primary
              ? "inline-flex h-8 items-center justify-center bg-slate-950 px-3 text-xs font-medium text-white hover:bg-slate-800"
              : "text-xs font-medium text-slate-700 underline-offset-4 hover:underline"
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
  const [entityTypes, summary] = await Promise.all([
    listEntityTypes({ workspaceId }),
    listMyWorkItems({ workspaceId }),
  ]);

  return (
    <WorkspacePageLayout
      navigation={<WorkspaceNavigation entityTypes={entityTypes} activeSection="my-work" />}
    >
      <PageHeader
        eyebrow="My Work"
        title="My Work"
        description="Process steps assigned to you in this workspace."
      />

      <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
        <SectionHeader
          title="Ready now"
          description={`${summary.readyNow.length} step${summary.readyNow.length === 1 ? "" : "s"}`}
        />
        {summary.readyNow.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No steps are ready for you right now.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {summary.readyNow.map((item) => (
              <MyWorkItemRow key={item.stepRun.id} item={item} primary />
            ))}
          </ul>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
        <SectionHeader
          title="Upcoming"
          description={`${summary.upcoming.length} step${summary.upcoming.length === 1 ? "" : "s"}`}
        />
        {summary.upcoming.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">Nothing upcoming.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {summary.upcoming.map((item) => (
              <MyWorkItemRow key={item.stepRun.id} item={item} primary={false} />
            ))}
          </ul>
        )}
      </section>
    </WorkspacePageLayout>
  );
}
