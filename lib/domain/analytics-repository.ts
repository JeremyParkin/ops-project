import { createServerSupabaseClient } from "@/lib/supabase/server";

export const ANALYTICS_PERIOD_DAYS = [7, 30, 90] as const;
export type AnalyticsPeriodDays = (typeof ANALYTICS_PERIOD_DAYS)[number];
export const DEFAULT_ANALYTICS_PERIOD_DAYS: AnalyticsPeriodDays = 30;

export function parseAnalyticsPeriodDays(value: string | undefined): AnalyticsPeriodDays | undefined {
  const parsed = Number(value);

  return (ANALYTICS_PERIOD_DAYS as readonly number[]).includes(parsed)
    ? (parsed as AnalyticsPeriodDays)
    : undefined;
}

export type OperationalSummary = {
  activeHumanTasks: number;
  activeApprovals: number;
  overdueCount: number;
  // null when no in-scope active human_task/approval step currently has a
  // due_at at all -- undated work is never counted in the denominator.
  overdueRate: number | null;
  completedHumanWorkSteps: number;
  completedRuns: number;
  medianStepDurationSeconds: number | null;
  medianApprovalTurnaroundSeconds: number | null;
  medianCycleTimeSeconds: number | null;
};

export type ThroughputTrendPoint = {
  bucketStart: string;
  completedHumanWorkSteps: number;
  completedRuns: number;
  onTimeCompletions: number;
  lateCompletions: number;
};

export type BottleneckRow = {
  processTemplateId: string;
  processTemplateName: string;
  sourceNodeId: string;
  nodeName: string;
  nodeType: string;
  medianDurationSeconds: number | null;
  historicalCount: number;
  currentActiveCount: number;
  currentOverdueCount: number;
};

export type PersonWorkloadRow = {
  userId: string;
  email: string;
  activeHumanTasks: number;
  activeApprovals: number;
  overdueCount: number;
  completedInPeriod: number;
};

export type TeamWorkloadRow = {
  teamId: string;
  teamName: string;
  memberCount: number;
  activeHumanTasks: number;
  activeApprovals: number;
  overdueCount: number;
  completedInPeriod: number;
};

type OperationalSummaryRow = {
  active_human_tasks: number;
  active_approvals: number;
  overdue_count: number;
  overdue_rate: number | null;
  completed_human_work_steps: number;
  completed_runs: number;
  median_step_duration_seconds: number | null;
  median_approval_turnaround_seconds: number | null;
  median_cycle_time_seconds: number | null;
};

type ThroughputTrendRow = {
  bucket_start: string;
  completed_human_work_steps: number;
  completed_runs: number;
  on_time_completions: number;
  late_completions: number;
};

type BottleneckRpcRow = {
  process_template_id: string;
  process_template_name: string;
  source_node_id: string;
  node_name: string;
  node_type: string;
  median_duration_seconds: number | null;
  historical_count: number;
  current_active_count: number;
  current_overdue_count: number;
};

type PersonWorkloadRpcRow = {
  user_id: string;
  email: string;
  active_human_tasks: number;
  active_approvals: number;
  overdue_count: number;
  completed_in_period: number;
};

type TeamWorkloadRpcRow = {
  team_id: string;
  team_name: string;
  member_count: number;
  active_human_tasks: number;
  active_approvals: number;
  overdue_count: number;
  completed_in_period: number;
};

// Every analytics RPC derives scope from the authenticated caller
// (private.managed_user_ids -> auth.uid()) and checks operations.view
// server-side; callers never submit a person/team scope directly.
export async function getOperationalSummary({
  workspaceId,
  periodDays,
}: {
  workspaceId: string;
  periodDays: AnalyticsPeriodDays;
}): Promise<OperationalSummary> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_operational_summary_authorized", {
    p_workspace_id: workspaceId,
    p_period_days: periodDays,
  });

  if (error) throw new Error(error.message);

  const row = ((data ?? []) as OperationalSummaryRow[])[0];

  if (!row) {
    throw new Error("Unable to load operational summary.");
  }

  return {
    activeHumanTasks: row.active_human_tasks,
    activeApprovals: row.active_approvals,
    overdueCount: row.overdue_count,
    overdueRate: row.overdue_rate,
    completedHumanWorkSteps: row.completed_human_work_steps,
    completedRuns: row.completed_runs,
    medianStepDurationSeconds: row.median_step_duration_seconds,
    medianApprovalTurnaroundSeconds: row.median_approval_turnaround_seconds,
    medianCycleTimeSeconds: row.median_cycle_time_seconds,
  };
}

export async function getThroughputTrend({
  workspaceId,
  periodDays,
}: {
  workspaceId: string;
  periodDays: AnalyticsPeriodDays;
}): Promise<ThroughputTrendPoint[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_throughput_trend_authorized", {
    p_workspace_id: workspaceId,
    p_period_days: periodDays,
  });

  if (error) throw new Error(error.message);

  return ((data ?? []) as ThroughputTrendRow[]).map((row) => ({
    bucketStart: row.bucket_start,
    completedHumanWorkSteps: row.completed_human_work_steps,
    completedRuns: row.completed_runs,
    onTimeCompletions: row.on_time_completions,
    lateCompletions: row.late_completions,
  }));
}

export async function getBottleneckMetrics({
  workspaceId,
  periodDays,
}: {
  workspaceId: string;
  periodDays: AnalyticsPeriodDays;
}): Promise<BottleneckRow[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_bottleneck_metrics_authorized", {
    p_workspace_id: workspaceId,
    p_period_days: periodDays,
  });

  if (error) throw new Error(error.message);

  return ((data ?? []) as BottleneckRpcRow[]).map((row) => ({
    processTemplateId: row.process_template_id,
    processTemplateName: row.process_template_name,
    sourceNodeId: row.source_node_id,
    nodeName: row.node_name,
    nodeType: row.node_type,
    medianDurationSeconds: row.median_duration_seconds,
    historicalCount: row.historical_count,
    currentActiveCount: row.current_active_count,
    currentOverdueCount: row.current_overdue_count,
  }));
}

// Deduplicated by person -- use for portfolio-level totals.
export async function getWorkloadByPerson({
  workspaceId,
  periodDays,
}: {
  workspaceId: string;
  periodDays: AnalyticsPeriodDays;
}): Promise<PersonWorkloadRow[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_workload_by_person_authorized", {
    p_workspace_id: workspaceId,
    p_period_days: periodDays,
  });

  if (error) throw new Error(error.message);

  return ((data ?? []) as PersonWorkloadRpcRow[]).map((row) => ({
    userId: row.user_id,
    email: row.email,
    activeHumanTasks: row.active_human_tasks,
    activeApprovals: row.active_approvals,
    overdueCount: row.overdue_count,
    completedInPeriod: row.completed_in_period,
  }));
}

// Limited to teams the caller currently leads. Rows may overlap a person
// across multiple teams -- contextual per-team rows only, never summed
// into a portfolio total.
export async function getWorkloadByTeam({
  workspaceId,
  periodDays,
}: {
  workspaceId: string;
  periodDays: AnalyticsPeriodDays;
}): Promise<TeamWorkloadRow[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_workload_by_team_authorized", {
    p_workspace_id: workspaceId,
    p_period_days: periodDays,
  });

  if (error) throw new Error(error.message);

  return ((data ?? []) as TeamWorkloadRpcRow[]).map((row) => ({
    teamId: row.team_id,
    teamName: row.team_name,
    memberCount: row.member_count,
    activeHumanTasks: row.active_human_tasks,
    activeApprovals: row.active_approvals,
    overdueCount: row.overdue_count,
    completedInPeriod: row.completed_in_period,
  }));
}
