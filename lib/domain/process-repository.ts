import { getCurrentUser } from "@/lib/auth/workspace";
import { getEntityContext } from "./metadata-repository";
import { getEntityRecord, getRecordLabel } from "./record-repository";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type {
  ProcessBranchCondition,
  ProcessEdge,
  ProcessDueRule,
  ProcessNodeConfig,
  ProcessNode,
  ProcessNodeType,
  ProcessParallelJoinObligation,
  ProcessRun,
  ProcessRunStatus,
  ProcessRunWithSteps,
  ProcessStepRun,
  ProcessStepRunRoute,
  ProcessStepRunRoutingResult,
  ProcessStepRunStatus,
  ProcessTemplate,
  ProcessTemplateWithSteps,
  WorkspaceMemberIdentity,
} from "./process-types";

type ProcessTemplateRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  applies_to_entity_type_id: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type ProcessNodeRow = {
  id: string;
  workspace_id: string;
  process_template_id: string;
  node_type: ProcessNodeType;
  name: string;
  position: number;
  parallel_group_id: string | null;
  assignee_user_id: string | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type ProcessEdgeRow = {
  id: string;
  workspace_id: string;
  process_template_id: string;
  source_node_id: string;
  target_node_id: string;
  priority: number;
  condition_config: ProcessBranchCondition[] | null;
  is_default: boolean;
  is_parallel: boolean;
  approval_outcome_id: string | null;
  approval_outcome_label: string | null;
  created_at: string;
};

type ProcessRunRow = {
  id: string;
  workspace_id: string;
  process_template_id: string;
  process_template_name: string;
  process_template_description: string | null;
  origin_entity_type_id: string;
  origin_record_id: string;
  status: ProcessRunStatus;
  started_at: string;
  completed_at: string | null;
};

type ProcessStepRunRow = {
  id: string;
  workspace_id: string;
  process_run_id: string;
  source_node_id: string | null;
  step_index: number;
  node_type: ProcessNodeType;
  parallel_group_id: string | null;
  parallel_branch_token: string | null;
  name: string;
  config: Record<string, unknown>;
  status: ProcessStepRunStatus;
  started_at: string | null;
  due_at: string | null;
  completed_at: string | null;
  assignee_user_id: string | null;
  assignee_label: string | null;
  approval_outcome_id: string | null;
  approval_outcome_label: string | null;
  decided_at: string | null;
  decided_by_user_id: string | null;
  decided_by_label: string | null;
  routing_result: ProcessStepRunRoutingResult | null;
};

type ProcessStepRunRouteRow = {
  id: string;
  workspace_id: string;
  process_run_id: string;
  source_step_run_id: string;
  target_step_run_id: string;
  source_node_id: string | null;
  target_node_id: string | null;
  priority: number;
  condition_config: ProcessBranchCondition[] | null;
  condition_summary: string | null;
  is_default: boolean;
  is_parallel: boolean;
  approval_outcome_id: string | null;
  approval_outcome_label: string | null;
};

type ProcessParallelJoinObligationRow = {
  id: string;
  workspace_id: string;
  process_run_id: string;
  join_step_run_id: string;
  parallel_group_id: string;
  branch_token: string;
  arrived_at: string | null;
  arrival_source_step_run_id: string | null;
};

export type ProcessTemplateStepInput = {
  clientKey: string;
  nodeId: string | null;
  nodeType: ProcessNodeType;
  parallelGroupId?: string;
  name: string;
  assigneeUserId: string | null;
  dueRule?: ProcessDueRule;
  routes: Array<{
    targetStepKey: string;
    isDefault: boolean;
    isParallel?: boolean;
    approvalOutcomeId?: string;
    approvalOutcomeLabel?: string;
    conditions: ProcessBranchCondition[];
  }>;
};

function mapProcessNodeConfig(config: Record<string, unknown>): ProcessNodeConfig {
  const dueRule = config.due_rule;

  if (
    typeof dueRule !== "object" ||
    dueRule === null ||
    Array.isArray(dueRule) ||
    typeof (dueRule as Record<string, unknown>).amount !== "number" ||
    ((dueRule as Record<string, unknown>).unit !== "hours" &&
      (dueRule as Record<string, unknown>).unit !== "days")
  ) {
    return {};
  }

  const dueRuleRecord = dueRule as Record<string, unknown>;

  return {
    dueRule: {
      amount: dueRuleRecord.amount as number,
      unit: dueRuleRecord.unit as ProcessDueRule["unit"],
    },
  };
}

function mapProcessTemplate(row: ProcessTemplateRow): ProcessTemplate {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description ?? undefined,
    appliesToEntityTypeId: row.applies_to_entity_type_id,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProcessNode(row: ProcessNodeRow): ProcessNode {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processTemplateId: row.process_template_id,
    nodeType: row.node_type,
    name: row.name,
    position: row.position,
    parallelGroupId: row.parallel_group_id ?? undefined,
    assigneeUserId: row.assignee_user_id ?? undefined,
    config: mapProcessNodeConfig(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProcessRun(row: ProcessRunRow): ProcessRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processTemplateId: row.process_template_id,
    processTemplateName: row.process_template_name,
    processTemplateDescription: row.process_template_description ?? undefined,
    originEntityTypeId: row.origin_entity_type_id,
    originRecordId: row.origin_record_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function mapProcessStepRun(row: ProcessStepRunRow): ProcessStepRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processRunId: row.process_run_id,
    sourceNodeId: row.source_node_id ?? undefined,
    stepIndex: row.step_index,
    nodeType: row.node_type,
    parallelGroupId: row.parallel_group_id ?? undefined,
    parallelBranchToken: row.parallel_branch_token ?? undefined,
    name: row.name,
    config: mapProcessNodeConfig(row.config),
    status: row.status,
    startedAt: row.started_at ?? undefined,
    dueAt: row.due_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    assigneeUserId: row.assignee_user_id ?? undefined,
    assigneeLabel: row.assignee_label ?? undefined,
    approvalOutcomeId: row.approval_outcome_id ?? undefined,
    approvalOutcomeLabel: row.approval_outcome_label ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    decidedByUserId: row.decided_by_user_id ?? undefined,
    decidedByLabel: row.decided_by_label ?? undefined,
    routingResult: row.routing_result ?? undefined,
  };
}

function mapProcessStepRunRoute(row: ProcessStepRunRouteRow): ProcessStepRunRoute {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processRunId: row.process_run_id,
    sourceStepRunId: row.source_step_run_id,
    targetStepRunId: row.target_step_run_id,
    sourceNodeId: row.source_node_id ?? undefined,
    targetNodeId: row.target_node_id ?? undefined,
    priority: row.priority,
    conditions: row.condition_config ?? undefined,
    conditionSummary: row.condition_summary ?? undefined,
    isDefault: row.is_default,
    isParallel: row.is_parallel,
    approvalOutcomeId: row.approval_outcome_id ?? undefined,
    approvalOutcomeLabel: row.approval_outcome_label ?? undefined,
  };
}

function mapProcessParallelJoinObligation(
  row: ProcessParallelJoinObligationRow,
): ProcessParallelJoinObligation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processRunId: row.process_run_id,
    joinStepRunId: row.join_step_run_id,
    parallelGroupId: row.parallel_group_id,
    branchToken: row.branch_token,
    arrivedAt: row.arrived_at ?? undefined,
    arrivalSourceStepRunId: row.arrival_source_step_run_id ?? undefined,
  };
}

export async function listProcessTemplates({
  workspaceId,
  includeArchived = false,
}: {
  workspaceId: string;
  includeArchived?: boolean;
}) {
  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from("process_templates")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (!includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query.returns<ProcessTemplateRow[]>();

  if (error) {
    throw new Error(`Unable to load process templates: ${error.message}`);
  }

  return data.map(mapProcessTemplate);
}

export async function listApplicableProcessTemplatesForEntityType({
  workspaceId,
  entityTypeId,
}: {
  workspaceId: string;
  entityTypeId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("process_templates")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("applies_to_entity_type_id", entityTypeId)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .returns<ProcessTemplateRow[]>();

  if (error) {
    throw new Error(`Unable to load applicable process templates: ${error.message}`);
  }

  return data.map(mapProcessTemplate);
}

export async function getProcessTemplateWithSteps({
  workspaceId,
  processTemplateId,
}: {
  workspaceId: string;
  processTemplateId: string;
}): Promise<ProcessTemplateWithSteps> {
  const supabase = await createServerSupabaseClient();
  const [{ data: templateRow, error: templateError }, { data: nodeRows, error: nodeError }, { data: edgeRows, error: edgeError }] =
    await Promise.all([
      supabase
        .from("process_templates")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("id", processTemplateId)
        .maybeSingle<ProcessTemplateRow>(),
      supabase
        .from("process_nodes")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("process_template_id", processTemplateId)
        .order("position", { ascending: true })
        .returns<ProcessNodeRow[]>(),
      supabase
        .from("process_edges")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("process_template_id", processTemplateId)
        .order("priority", { ascending: true })
        .returns<ProcessEdgeRow[]>(),
    ]);

  if (templateError) {
    throw new Error(`Unable to load process template: ${templateError.message}`);
  }

  if (!templateRow) {
    throw new Error("Unable to load process template: template not found.");
  }

  if (nodeError) {
    throw new Error(`Unable to load process template steps: ${nodeError.message}`);
  }

  if (edgeError) {
    throw new Error(`Unable to load process template chain: ${edgeError.message}`);
  }

  const nodes = nodeRows.map(mapProcessNode);
  const edges: ProcessEdge[] = edgeRows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    processTemplateId: row.process_template_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    priority: row.priority,
    conditionConfig: row.condition_config ?? undefined,
    isDefault: row.is_default,
    isParallel: row.is_parallel,
    approvalOutcomeId: row.approval_outcome_id ?? undefined,
    approvalOutcomeLabel: row.approval_outcome_label ?? undefined,
    createdAt: row.created_at,
  }));

  return {
    ...mapProcessTemplate(templateRow),
    steps: nodes,
    edges,
  };
}

export async function saveProcessTemplate({
  workspaceId,
  processTemplateId,
  name,
  description,
  appliesToEntityTypeId,
  steps,
}: {
  workspaceId: string;
  processTemplateId?: string;
  name: string;
  description?: string;
  appliesToEntityTypeId: string;
  steps: ProcessTemplateStepInput[];
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("save_process_template_authorized", {
    p_workspace_id: workspaceId,
    p_process_template_id: processTemplateId ?? null,
    p_name: name,
    p_description: description ?? null,
    p_applies_to_entity_type_id: appliesToEntityTypeId,
    p_steps: steps.map((step) => ({
      client_key: step.clientKey,
      node_id: step.nodeId,
      node_type: step.nodeType,
      parallel_group_id: step.parallelGroupId ?? null,
      name: step.name,
      assignee_user_id: step.assigneeUserId,
      due_rule: step.dueRule
        ? { amount: step.dueRule.amount, unit: step.dueRule.unit }
        : null,
      routes: step.routes.map((route) => ({
        target_client_key: route.targetStepKey,
        is_default: route.isDefault,
        is_parallel: route.isParallel === true,
        approval_outcome_id: route.approvalOutcomeId ?? null,
        approval_outcome_label: route.approvalOutcomeLabel ?? null,
        conditions: route.conditions,
      })),
    })),
  });

  if (error) {
    throw new Error(`Unable to save process template: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to save process template: unexpected RPC response.");
  }

  return data;
}

export async function archiveProcessTemplate({
  workspaceId,
  processTemplateId,
}: {
  workspaceId: string;
  processTemplateId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("archive_process_template_authorized", {
    p_workspace_id: workspaceId,
    p_process_template_id: processTemplateId,
  });

  if (error) {
    throw new Error(`Unable to archive process template: ${error.message}`);
  }
}

export async function restoreProcessTemplate({
  workspaceId,
  processTemplateId,
}: {
  workspaceId: string;
  processTemplateId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("restore_process_template_authorized", {
    p_workspace_id: workspaceId,
    p_process_template_id: processTemplateId,
  });

  if (error) {
    throw new Error(`Unable to restore process template: ${error.message}`);
  }
}

export async function deleteProcessTemplateIfSafe({
  workspaceId,
  processTemplateId,
}: {
  workspaceId: string;
  processTemplateId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "delete_process_template_if_safe_authorized",
    {
      p_workspace_id: workspaceId,
      p_process_template_id: processTemplateId,
    },
  );

  if (error) {
    throw new Error(`Unable to delete process template: ${error.message}`);
  }

  const resultRows = data as Array<{
    deleted: boolean;
    run_count: number;
    workflow_count: number;
  }> | null;
  const result = resultRows?.[0];

  if (!result) {
    throw new Error("Unable to delete process template: unexpected RPC response.");
  }

  return {
    deleted: result.deleted,
    runCount: result.run_count,
    workflowCount: result.workflow_count,
  };
}

export async function startProcessRun({
  workspaceId,
  processTemplateId,
  originEntityTypeId,
  originRecordId,
}: {
  workspaceId: string;
  processTemplateId: string;
  originEntityTypeId: string;
  originRecordId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("start_process_run_authorized", {
    p_workspace_id: workspaceId,
    p_process_template_id: processTemplateId,
    p_origin_entity_type_id: originEntityTypeId,
    p_origin_record_id: originRecordId,
  });

  if (error) {
    throw new Error(`Unable to start process: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to start process: unexpected RPC response.");
  }

  return data;
}

export async function completeProcessStepRun({
  workspaceId,
  processRunId,
  stepRunId,
}: {
  workspaceId: string;
  processRunId: string;
  stepRunId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("complete_process_step_run_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_step_run_id: stepRunId,
  });

  if (error) {
    throw new Error(`Unable to complete step: ${error.message}`);
  }
}

export async function decideProcessApproval({
  workspaceId,
  processRunId,
  stepRunId,
  outcomeId,
}: {
  workspaceId: string;
  processRunId: string;
  stepRunId: string;
  outcomeId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("decide_process_approval_authorized", {
    p_workspace_id: workspaceId,
    p_process_run_id: processRunId,
    p_step_run_id: stepRunId,
    p_outcome_id: outcomeId,
  });

  if (error) {
    throw new Error(`Unable to decide approval: ${error.message}`);
  }
}

export async function getProcessRunWithSteps({
  workspaceId,
  processRunId,
}: {
  workspaceId: string;
  processRunId: string;
}): Promise<ProcessRunWithSteps> {
  const supabase = await createServerSupabaseClient();
  const [
    { data: runRow, error: runError },
    { data: stepRows, error: stepError },
    { data: routeRows, error: routeError },
    { data: obligationRows, error: obligationError },
  ] =
    await Promise.all([
      supabase
        .from("process_runs")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("id", processRunId)
        .maybeSingle<ProcessRunRow>(),
      supabase
        .from("process_step_runs")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("process_run_id", processRunId)
        .order("step_index", { ascending: true })
        .returns<ProcessStepRunRow[]>(),
      supabase
        .from("process_step_run_routes")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("process_run_id", processRunId)
        .order("priority", { ascending: true })
        .returns<ProcessStepRunRouteRow[]>(),
      supabase
        .from("process_parallel_join_obligations")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("process_run_id", processRunId)
        .returns<ProcessParallelJoinObligationRow[]>(),
    ]);

  if (runError) {
    throw new Error(`Unable to load process run: ${runError.message}`);
  }

  if (!runRow) {
    throw new Error("Unable to load process run: run not found.");
  }

  if (stepError) {
    throw new Error(`Unable to load process run steps: ${stepError.message}`);
  }

  if (routeError) {
    throw new Error(`Unable to load process run routes: ${routeError.message}`);
  }

  if (obligationError) {
    throw new Error(`Unable to load process join obligations: ${obligationError.message}`);
  }

  return {
    ...mapProcessRun(runRow),
    steps: stepRows.map(mapProcessStepRun),
    routes: routeRows.map(mapProcessStepRunRoute),
    joinObligations: obligationRows.map(mapProcessParallelJoinObligation),
  };
}

export async function listProcessRunsForOrigin({
  workspaceId,
  originEntityTypeId,
  originRecordId,
}: {
  workspaceId: string;
  originEntityTypeId: string;
  originRecordId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("process_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("origin_entity_type_id", originEntityTypeId)
    .eq("origin_record_id", originRecordId)
    .order("started_at", { ascending: false })
    .returns<ProcessRunRow[]>();

  if (error) {
    throw new Error(`Unable to load process runs for record: ${error.message}`);
  }

  return data.map(mapProcessRun);
}

export async function getEntityTypeProcessTemplateSummary({
  workspaceId,
  entityTypeId,
}: {
  workspaceId: string;
  entityTypeId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("process_templates")
    .select("name")
    .eq("workspace_id", workspaceId)
    .eq("applies_to_entity_type_id", entityTypeId)
    .returns<Array<{ name: string }>>();

  if (error) {
    throw new Error(`Unable to count process template references: ${error.message}`);
  }

  return {
    total: data.length,
    references: data.map((template) => ({ templateName: template.name })),
  };
}

export async function getRecordProcessRunSummary({
  workspaceId,
  entityTypeId,
  recordId,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("process_runs")
    .select("process_template_name")
    .eq("workspace_id", workspaceId)
    .eq("origin_entity_type_id", entityTypeId)
    .eq("origin_record_id", recordId)
    .returns<Array<{ process_template_name: string }>>();

  if (error) {
    throw new Error(`Unable to count process run references: ${error.message}`);
  }

  return {
    total: data.length,
    references: data.map((run) => ({ templateName: run.process_template_name })),
  };
}

export async function listWorkspaceMemberIdentities({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<WorkspaceMemberIdentity[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "list_workspace_member_identities_authorized",
    { p_workspace_id: workspaceId },
  );

  if (error) {
    throw new Error(`Unable to load workspace members: ${error.message}`);
  }

  const rows = data as Array<{ user_id: string; email: string }> | null;

  return (rows ?? []).map((row) => ({ userId: row.user_id, email: row.email }));
}

export type MyWorkItem = {
  stepRun: ProcessStepRun;
  run: ProcessRun;
  originRecordLabel: string;
  originHref: string;
};

export type MyWorkSummary = {
  overdue: MyWorkItem[];
  readyNow: MyWorkItem[];
  upcoming: MyWorkItem[];
};

function compareActiveMyWorkItems(left: MyWorkItem, right: MyWorkItem) {
  if (left.stepRun.dueAt && right.stepRun.dueAt) {
    const dueComparison = left.stepRun.dueAt.localeCompare(right.stepRun.dueAt);

    if (dueComparison !== 0) {
      return dueComparison;
    }
  } else if (left.stepRun.dueAt) {
    return -1;
  } else if (right.stepRun.dueAt) {
    return 1;
  }

  const runComparison = left.run.startedAt.localeCompare(right.run.startedAt);

  return runComparison !== 0
    ? runComparison
    : left.stepRun.stepIndex - right.stepRun.stepIndex;
}

// "My Work" is a convenience filter over data every workspace member can
// already see (via Process Run detail), not a new visibility boundary — the
// current user is always resolved server-side via getCurrentUser(), never
// accepted from the caller, so this can never be used to look up someone
// else's assignments.
export async function listMyWorkItems({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<MyWorkSummary> {
  const user = await getCurrentUser();

  if (!user) {
    return { overdue: [], readyNow: [], upcoming: [] };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("process_step_runs")
    .select("*, process_runs!inner(*)")
    .eq("workspace_id", workspaceId)
    .eq("assignee_user_id", user.id)
    .in("status", ["active", "pending"])
    .eq("process_runs.status", "active")
    .order("started_at", { foreignTable: "process_runs", ascending: true })
    .order("step_index", { ascending: true })
    .returns<Array<ProcessStepRunRow & { process_runs: ProcessRunRow }>>();

  if (error) {
    throw new Error(`Unable to load My Work: ${error.message}`);
  }

  const entries = data.map((row) => ({
    stepRun: mapProcessStepRun(row),
    run: mapProcessRun(row.process_runs),
  }));

  if (entries.length === 0) {
    return { overdue: [], readyNow: [], upcoming: [] };
  }

  const runIds = [...new Set(entries.map((entry) => entry.run.id))];
  const [{ data: runStepRows, error: runStepError }, { data: routeRows, error: routeError }] =
    await Promise.all([
      supabase
        .from("process_step_runs")
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("process_run_id", runIds)
        .returns<ProcessStepRunRow[]>(),
      supabase
        .from("process_step_run_routes")
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("process_run_id", runIds)
        .returns<ProcessStepRunRouteRow[]>(),
    ]);

  if (runStepError) {
    throw new Error(`Unable to load process run paths for My Work: ${runStepError.message}`);
  }

  if (routeError) {
    throw new Error(`Unable to load process run routes for My Work: ${routeError.message}`);
  }

  const allStepsByRunId = new Map<string, ProcessStepRun[]>();
  runStepRows.forEach((row) => {
    const steps = allStepsByRunId.get(row.process_run_id) ?? [];
    steps.push(mapProcessStepRun(row));
    allStepsByRunId.set(row.process_run_id, steps);
  });
  const routesBySourceStepRunId = new Map<string, ProcessStepRunRoute[]>();
  routeRows.forEach((row) => {
    const route = mapProcessStepRunRoute(row);
    const routes = routesBySourceStepRunId.get(route.sourceStepRunId) ?? [];
    routes.push(route);
    routesBySourceStepRunId.set(route.sourceStepRunId, routes);
  });
  const deterministicUpcomingStepIds = new Set<string>();

  allStepsByRunId.forEach((steps) => {
    const stepById = new Map(steps.map((step) => [step.id, step]));
    const activeSteps = steps.filter(
      (step) =>
        step.status === "active" &&
        (step.nodeType === "human_task" || step.nodeType === "approval"),
    );

    activeSteps.forEach((activeStep) => {
      let currentStep: ProcessStepRun | undefined = activeStep;

      // A route becomes knowable only when it has one ordinary unconditional
      // successor. Conditional splits and unsatisfied parallel joins stay out
      // of Upcoming until their runtime path has actually advanced.
      while (currentStep) {
        const routes = routesBySourceStepRunId.get(currentStep.id) ?? [];

        if (routes.length !== 1 || !routes[0].isDefault || routes[0].isParallel) {
          break;
        }

        const nextStep = stepById.get(routes[0].targetStepRunId);

        if (
          !nextStep ||
          nextStep.status !== "pending" ||
          (nextStep.nodeType !== "human_task" && nextStep.nodeType !== "approval")
        ) {
          break;
        }

        deterministicUpcomingStepIds.add(nextStep.id);
        currentStep = nextStep;
      }
    });
  });

  const uniqueOrigins = new Map<string, { entityTypeId: string; recordId: string }>();

  entries.forEach((entry) => {
    const key = `${entry.run.originEntityTypeId}:${entry.run.originRecordId}`;
    uniqueOrigins.set(key, {
      entityTypeId: entry.run.originEntityTypeId,
      recordId: entry.run.originRecordId,
    });
  });

  const entityTypeIds = [
    ...new Set([...uniqueOrigins.values()].map((origin) => origin.entityTypeId)),
  ];
  const entityContextByTypeId = new Map(
    await Promise.all(
      entityTypeIds.map(async (entityTypeId) => {
        const context = await getEntityContext({ workspaceId, entityTypeId });
        return [entityTypeId, context] as const;
      }),
    ),
  );

  const labelByOriginKey = new Map(
    await Promise.all(
      [...uniqueOrigins.entries()].map(async ([key, origin]) => {
        const context = entityContextByTypeId.get(origin.entityTypeId);

        if (!context) {
          return [key, "Record"] as const;
        }

        try {
          const record = await getEntityRecord({
            workspaceId,
            entityTypeId: origin.entityTypeId,
            recordId: origin.recordId,
            fields: context.fields,
          });

          return [
            key,
            getRecordLabel({ entityType: context.entityType, fields: context.fields, record }),
          ] as const;
        } catch {
          return [key, "Record"] as const;
        }
      }),
    ),
  );

  const items: MyWorkItem[] = entries
    .filter(
      (entry) =>
        entry.stepRun.status === "active" || deterministicUpcomingStepIds.has(entry.stepRun.id),
    )
    .map((entry) => {
    const key = `${entry.run.originEntityTypeId}:${entry.run.originRecordId}`;

    return {
      stepRun: entry.stepRun,
      run: entry.run,
      originRecordLabel: labelByOriginKey.get(key) ?? "Record",
      originHref: `/entities/${entry.run.originEntityTypeId}/records/${entry.run.originRecordId}`,
    };
    });

  const now = Date.now();
  const activeItems = items.filter((item) => item.stepRun.status === "active");
  const overdue = activeItems
    .filter((item) => item.stepRun.dueAt && Date.parse(item.stepRun.dueAt) < now)
    .sort(compareActiveMyWorkItems);
  const readyNow = activeItems
    .filter((item) => !item.stepRun.dueAt || Date.parse(item.stepRun.dueAt) >= now)
    .sort(compareActiveMyWorkItems);

  return {
    overdue,
    readyNow,
    upcoming: items.filter((item) => item.stepRun.status === "pending"),
  };
}
