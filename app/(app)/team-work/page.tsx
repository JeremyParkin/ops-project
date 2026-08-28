import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader, SectionHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { ProcessDueAt } from "@/app/components/process-due-at";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import {
  getManagedPeopleContext,
  getManagedWorkPortfolio,
  resolveManagedWorkFilter,
  type ManagedWorkItem,
} from "@/lib/domain/manager-portfolio-repository";
import { listEntityTypes } from "@/lib/domain/metadata-repository";

export const dynamic = "force-dynamic";

function TeamWorkRow({
  item,
  attention,
  originEntityTypeName,
}: {
  item: ManagedWorkItem;
  attention: string;
  originEntityTypeName?: string;
}) {
  const provenance = [
    ...(item.person.isDirectReport ? ["Direct report"] : []),
    ...item.person.teamSources.map((team) => `Team: ${team.teamName}`),
  ];

  return (
    <tr className="border-t border-grit align-top">
      <td className="p-3 text-sm text-graphite">
        <p className="font-medium">{item.person.email}</p>
        <p className="mt-1 text-xs text-stone">{provenance.join(", ")}</p>
      </td>
      <td className="p-3 text-sm text-graphite">
        <p className="font-medium">{item.stepRun.name}</p>
        {item.stepRun.nodeType === "approval" ? (
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-brass-deep">
            Approval
          </p>
        ) : null}
      </td>
      <td className="p-3 text-sm text-stone">{item.run.processTemplateName}</td>
      <td className="p-3 text-sm text-stone">
        <Link href={item.originHref} className="underline-offset-4 hover:text-graphite hover:underline">
          {item.originRecordLabel}
        </Link>
        {originEntityTypeName ? ` · ${originEntityTypeName}` : ""}
      </td>
      <td className="p-3 text-sm text-stone">
        {item.stepRun.dueAt ? <ProcessDueAt dueAt={item.stepRun.dueAt} /> : "No due date"}
      </td>
      <td className="p-3 text-sm">
        <p className={attention === "Overdue" ? "font-semibold text-red-700" : "text-stone"}>
          {attention}
        </p>
        <Link
          href={`/process-runs/${item.run.id}`}
          className="mt-2 inline-block text-xs font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
        >
          View process
        </Link>
      </td>
    </tr>
  );
}

function WorkSection({
  title,
  description,
  items,
  entityTypeNameById,
}: {
  title: string;
  description: string;
  items: ManagedWorkItem[];
  entityTypeNameById: Map<string, string>;
}) {
  return (
    <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
      <SectionHeader title={title} description={description} />
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-stone">No work in this section.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="bg-slab text-xs font-semibold uppercase tracking-wide text-stone">
              <tr>
                <th scope="col" className="p-3">Person</th>
                <th scope="col" className="p-3">Work</th>
                <th scope="col" className="p-3">Process</th>
                <th scope="col" className="p-3">Record</th>
                <th scope="col" className="p-3">Due</th>
                <th scope="col" className="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <TeamWorkRow
                  key={item.stepRun.id}
                  item={item}
                  attention={title}
                  originEntityTypeName={entityTypeNameById.get(item.run.originEntityTypeId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function TeamWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; id?: string; person?: string }>;
}) {
  const { workspaceId } = await getActiveWorkspaceId();
  const permissions = await getWorkspacePermissionContext(workspaceId);

  if (!permissions?.capabilities.has("operations.view")) {
    redirect("/");
  }

  const [allEntityTypes, people, params] = await Promise.all([
    listEntityTypes({ workspaceId, includeArchived: true }),
    getManagedPeopleContext({ workspaceId }),
    searchParams,
  ]);
  const entityTypeNameById = new Map(
    allEntityTypes.map((entityType) => [entityType.id, entityType.name]),
  );

  if (people.length === 0) {
    redirect("/");
  }

  const filter = resolveManagedWorkFilter({
    people,
    scope: params.scope,
    id: params.id,
    person: params.person,
  });

  if (!filter) {
    redirect("/team-work");
  }

  const portfolio = await getManagedWorkPortfolio({ workspaceId, people, filter });
  const ledTeams = new Map(
    people.flatMap((person) => person.teamSources.map((team) => [team.teamId, team] as const)),
  );
  const selectedPersonId = filter.kind === "person" ? filter.userId : "";

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="Operations"
        title="Team Work"
        description="Assigned process work for your direct reports and active teams you lead."
      />

      <section className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 border border-grit bg-white p-4" aria-label="Team Work filters">
        <Link href="/team-work" className={filter.kind === "all" ? "bg-brass px-3 py-2 text-sm font-medium text-graphite" : "border border-grit px-3 py-2 text-sm text-stone hover:text-graphite"}>
          All people
        </Link>
        <Link href="/team-work?scope=direct" className={filter.kind === "direct" ? "bg-brass px-3 py-2 text-sm font-medium text-graphite" : "border border-grit px-3 py-2 text-sm text-stone hover:text-graphite"}>
          Direct reports
        </Link>
        {[...ledTeams.values()].map((team) => (
          <Link key={team.teamId} href={`/team-work?scope=team&id=${team.teamId}`} className={filter.kind === "team" && filter.teamId === team.teamId ? "bg-brass px-3 py-2 text-sm font-medium text-graphite" : "border border-grit px-3 py-2 text-sm text-stone hover:text-graphite"}>
            {team.teamName}
          </Link>
        ))}
        <form method="get" className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor="team-work-person">Individual</label>
          <select id="team-work-person" name="person" defaultValue={selectedPersonId} className="border border-grit bg-paper px-2 py-2 text-sm text-graphite">
            <option value="">Individual</option>
            {people.map((person) => <option key={person.userId} value={person.userId}>{person.email}</option>)}
          </select>
          <button type="submit" className="border border-grit px-3 py-2 text-sm font-medium text-graphite hover:bg-slab">View</button>
        </form>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-px border border-grit bg-grit sm:grid-cols-4" aria-label="Team Work summary">
        {[
          ["Overdue", portfolio.overdue.length],
          ["Ready now", portfolio.readyNow.length],
          ["Upcoming", portfolio.upcoming.length],
          ["People with work", new Set([...portfolio.overdue, ...portfolio.readyNow, ...portfolio.upcoming].map((item) => item.person.userId)).size],
        ].map(([label, count]) => (
          <div key={String(label)} className="bg-white p-4">
            <p className="text-2xl font-semibold text-graphite">{count}</p>
            <p className="mt-1 text-sm text-stone">{label}</p>
          </div>
        ))}
      </section>

      <WorkSection title="Overdue" description={`${portfolio.overdue.length} active step${portfolio.overdue.length === 1 ? "" : "s"}`} items={portfolio.overdue} entityTypeNameById={entityTypeNameById} />
      <WorkSection title="Ready now" description={`${portfolio.readyNow.length} active step${portfolio.readyNow.length === 1 ? "" : "s"}`} items={portfolio.readyNow} entityTypeNameById={entityTypeNameById} />
      <WorkSection title="Upcoming" description={`${portfolio.upcoming.length} deterministically reachable step${portfolio.upcoming.length === 1 ? "" : "s"}`} items={portfolio.upcoming} entityTypeNameById={entityTypeNameById} />
    </WorkspacePageLayout>
  );
}
