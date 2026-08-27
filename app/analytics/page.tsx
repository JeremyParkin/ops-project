import Link from "next/link";
import { redirect } from "next/navigation";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { StackedTrendChart } from "@/app/components/analytics-trend-chart";
import { PageHeader, SectionHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import {
  ANALYTICS_PERIOD_DAYS,
  DEFAULT_ANALYTICS_PERIOD_DAYS,
  getBottleneckMetrics,
  getOperationalSummary,
  getThroughputTrend,
  getWorkloadByPerson,
  getWorkloadByTeam,
  parseAnalyticsPeriodDays,
} from "@/lib/domain/analytics-repository";
import { getManagedPeopleContext } from "@/lib/domain/manager-portfolio-repository";
import { listEntityTypes } from "@/lib/domain/metadata-repository";

export const dynamic = "force-dynamic";

function formatDuration(seconds: number | null) {
  if (seconds === null) return "No completed work yet";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

function formatRate(rate: number | null) {
  return rate === null ? "No dated work" : `${Math.round(rate * 100)}%`;
}

function formatBucketLabel(bucketStart: string) {
  const date = new Date(`${bucketStart}T00:00:00Z`);

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { workspaceId } = await getActiveWorkspaceId();
  const permissions = await getWorkspacePermissionContext(workspaceId);

  if (!permissions?.capabilities.has("operations.view")) {
    redirect("/");
  }

  const [entityTypes, people, params] = await Promise.all([
    listEntityTypes({ workspaceId }),
    getManagedPeopleContext({ workspaceId }),
    searchParams,
  ]);

  if (people.length === 0) {
    redirect("/");
  }

  if (params.period !== undefined && parseAnalyticsPeriodDays(params.period) === undefined) {
    redirect("/analytics");
  }

  const periodDays = parseAnalyticsPeriodDays(params.period) ?? DEFAULT_ANALYTICS_PERIOD_DAYS;

  const [summary, trend, bottlenecks, peopleWorkload, teamWorkload] = await Promise.all([
    getOperationalSummary({ workspaceId, periodDays }),
    getThroughputTrend({ workspaceId, periodDays }),
    getBottleneckMetrics({ workspaceId, periodDays }),
    getWorkloadByPerson({ workspaceId, periodDays }),
    getWorkloadByTeam({ workspaceId, periodDays }),
  ]);

  const buckets = trend.map((point) => formatBucketLabel(point.bucketStart));

  return (
    <WorkspacePageLayout
      navigation={<WorkspaceNavigation entityTypes={entityTypes} activeSection="analytics" />}
    >
      <PageHeader
        eyebrow="Operations"
        title="Operational Analytics"
        description="Workload, throughput, and timeliness for your direct reports and active teams you lead -- measuring work, not people."
      />

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-4 text-sm text-stone">
        Reflects your current reporting structure and active team leadership. If your team has
        changed recently, historical numbers follow people currently in your scope, not who
        managed them at the time the work happened. Figures below are raw, traceable counts and
        medians -- not a performance or efficiency score.
      </section>

      <section className="mx-auto flex w-full max-w-6xl items-center gap-2" aria-label="Analytics period">
        {ANALYTICS_PERIOD_DAYS.map((days) => (
          <Link
            key={days}
            href={days === DEFAULT_ANALYTICS_PERIOD_DAYS ? "/analytics" : `/analytics?period=${days}`}
            className={
              periodDays === days
                ? "bg-brass px-3 py-2 text-sm font-medium text-graphite"
                : "border border-grit px-3 py-2 text-sm text-stone hover:text-graphite"
            }
          >
            Last {days} days
          </Link>
        ))}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader title="Workload snapshot" description="Current, point-in-time state" />
        <div className="mt-4 grid gap-px border border-grit bg-grit sm:grid-cols-4">
          {[
            ["Active human tasks", summary.activeHumanTasks],
            ["Active approvals", summary.activeApprovals],
            ["Overdue now", summary.overdueCount],
            ["Overdue rate", formatRate(summary.overdueRate)],
          ].map(([label, value]) => (
            <div key={String(label)} className="bg-white p-4">
              <p className="text-2xl font-semibold text-graphite">{value}</p>
              <p className="mt-1 text-sm text-stone">{label}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Throughput and timeliness"
          description={`Completed work in the last ${periodDays} days`}
        />
        <div className="mt-4 grid gap-px border border-grit bg-grit sm:grid-cols-3">
          {[
            ["Completed human work", summary.completedHumanWorkSteps],
            ["Completed processes", summary.completedRuns],
            ["Median completion time", formatDuration(summary.medianStepDurationSeconds)],
          ].map(([label, value]) => (
            <div key={String(label)} className="bg-white p-4">
              <p className="text-2xl font-semibold text-graphite">{value}</p>
              <p className="mt-1 text-sm text-stone">{label}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-stone">
          Median approval turnaround: {formatDuration(summary.medianApprovalTurnaroundSeconds)}. Median
          process cycle time: {formatDuration(summary.medianCycleTimeSeconds)}.
        </p>
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader title="Throughput trend" description="Completed human work and processes, by period" />
        {trend.every((point) => point.completedHumanWorkSteps === 0 && point.completedRuns === 0) ? (
          <p className="mt-4 text-sm text-stone">No completed work in this period yet.</p>
        ) : (
          <div className="mt-4">
            <StackedTrendChart
              buckets={buckets}
              series={[
                { label: "Completed steps", colorVar: "var(--color-brass-deep)" },
                { label: "Completed processes", colorVar: "var(--color-graphite)" },
              ]}
              values={[
                trend.map((point) => point.completedHumanWorkSteps),
                trend.map((point) => point.completedRuns),
              ]}
            />
          </div>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Timeliness trend"
          description="On-time vs. late completions among dated work, by period"
        />
        {trend.every((point) => point.onTimeCompletions === 0 && point.lateCompletions === 0) ? (
          <p className="mt-4 text-sm text-stone">No dated work completed in this period yet.</p>
        ) : (
          <div className="mt-4">
            <StackedTrendChart
              buckets={buckets}
              series={[
                { label: "On time", colorVar: "var(--color-status-sage)" },
                { label: "Late", colorVar: "var(--color-status-slate)" },
              ]}
              values={[
                trend.map((point) => point.onTimeCompletions),
                trend.map((point) => point.lateCompletions),
              ]}
            />
          </div>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader
          title="Bottlenecks"
          description="Median dwell time by process step, including wait/condition-wait time"
        />
        {bottlenecks.length === 0 ? (
          <p className="mt-4 text-sm text-stone">No process step activity for this scope yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead className="bg-slab text-xs font-semibold uppercase tracking-wide text-stone">
                <tr>
                  <th scope="col" className="p-3">Process / Step</th>
                  <th scope="col" className="p-3">Median time</th>
                  <th scope="col" className="p-3">Currently active</th>
                  <th scope="col" className="p-3">Currently overdue</th>
                </tr>
              </thead>
              <tbody>
                {bottlenecks.map((row) => (
                  <tr key={`${row.processTemplateId}:${row.sourceNodeId}`} className="border-t border-grit align-top">
                    <td className="p-3 text-sm text-graphite">
                      <Link
                        href={`/processes/${row.processTemplateId}/edit`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.processTemplateName}
                      </Link>
                      <p className="mt-1 text-xs text-stone">{row.nodeName}</p>
                    </td>
                    <td className="p-3 text-sm text-stone">{formatDuration(row.medianDurationSeconds)}</td>
                    <td className="p-3 text-sm text-stone">{row.currentActiveCount}</td>
                    <td className="p-3 text-sm text-stone">{row.currentOverdueCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
        <SectionHeader title="Workload by person" description="Current active work and work completed in this period" />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead className="bg-slab text-xs font-semibold uppercase tracking-wide text-stone">
              <tr>
                <th scope="col" className="p-3">Person</th>
                <th scope="col" className="p-3">Active</th>
                <th scope="col" className="p-3">Overdue</th>
                <th scope="col" className="p-3">Completed in period</th>
              </tr>
            </thead>
            <tbody>
              {peopleWorkload.map((row) => (
                <tr key={row.userId} className="border-t border-grit">
                  <td className="p-3 text-sm text-graphite">
                    <Link
                      href={`/team-work?person=${row.userId}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {row.email}
                    </Link>
                  </td>
                  <td className="p-3 text-sm text-stone">{row.activeHumanTasks + row.activeApprovals}</td>
                  <td className="p-3 text-sm text-stone">{row.overdueCount}</td>
                  <td className="p-3 text-sm text-stone">{row.completedInPeriod}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {teamWorkload.length > 0 ? (
        <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
          <SectionHeader
            title="Workload by team"
            description="Teams you currently lead. A person on multiple teams appears in each -- these rows are contextual and are not summed into the totals above."
          />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead className="bg-slab text-xs font-semibold uppercase tracking-wide text-stone">
                <tr>
                  <th scope="col" className="p-3">Team</th>
                  <th scope="col" className="p-3">Members</th>
                  <th scope="col" className="p-3">Active</th>
                  <th scope="col" className="p-3">Overdue</th>
                  <th scope="col" className="p-3">Completed in period</th>
                </tr>
              </thead>
              <tbody>
                {teamWorkload.map((row) => (
                  <tr key={row.teamId} className="border-t border-grit">
                    <td className="p-3 text-sm text-graphite">
                      <Link
                        href={`/team-work?scope=team&id=${row.teamId}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.teamName}
                      </Link>
                    </td>
                    <td className="p-3 text-sm text-stone">{row.memberCount}</td>
                    <td className="p-3 text-sm text-stone">{row.activeHumanTasks + row.activeApprovals}</td>
                    <td className="p-3 text-sm text-stone">{row.overdueCount}</td>
                    <td className="p-3 text-sm text-stone">{row.completedInPeriod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </WorkspacePageLayout>
  );
}
