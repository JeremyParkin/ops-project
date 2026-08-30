import { getCurrentUser } from "@/lib/auth/workspace";
import { getEntityContext } from "./metadata-repository";
import { getEntityRecord, getRecordLabel } from "./record-repository";
import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";
import { executeSingleAction } from "./workflow-engine";
import type { WorkflowAction, WorkflowFieldMapping } from "./workflow-types";
import type {
  ProcessBranchCondition,
  ProcessConditionWaitRule,
  ProcessEdge,
  ProcessDueRule,
  ProcessWaitRule,
  ProcessNodeConfig,
  ProcessNode,
  ProcessNodeType,
  ProcessParallelJoinObligation,
  ProcessRun,
  ProcessRunStatus,
  ProcessRunWithSteps,
  ProcessStepActionResult,
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
  resume_at: string | null;
  condition_wait_result: ProcessStepRun["conditionWaitResult"] | null;
  completed_at: string | null;
  assignee_user_id: string | null;
  assignee_label: string | null;
  approval_outcome_id: string | null;
  approval_outcome_label: string | null;
  decided_at: string | null;
  decided_by_user_id: string | null;
  decided_by_label: string | null;
  routing_result: ProcessStepRunRoutingResult | null;
  action_result: ProcessStepActionResult | null;
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
  waitRule?: ProcessWaitRule;
  conditionWaitRule?: ProcessConditionWaitRule;
  actionConfig?: WorkflowAction;
  routes: Array<{
    targetStepKey: string;
    isDefault: boolean;
    isParallel?: boolean;
    approvalOutcomeId?: string;
    approvalOutcomeLabel?: string;
    conditions: ProcessBranchCondition[];
  }>;
};

function mapActionConfig(actionConfig: unknown): WorkflowAction | undefined {
  if (typeof actionConfig !== "object" || actionConfig === null || Array.isArray(actionConfig)) {
    return undefined;
  }

  const config = actionConfig as Record<string, unknown>;
  const actionType = config.action_type;

  if (
    actionType !== "create_record" &&
    actionType !== "update_record" &&
    actionType !== "update_related_record" &&
    actionType !== "start_process"
  ) {
    return undefined;
  }

  const rawMappings = Array.isArray(config.field_mappings) ? config.field_mappings : [];

  return {
    actionType,
    actionTargetEntityTypeId:
      typeof config.action_target_entity_type_id === "string" ? config.action_target_entity_type_id : undefined,
    relatedFieldDefinitionId:
      typeof config.related_field_definition_id === "string" ? config.related_field_definition_id : undefined,
    processTemplateId: typeof config.process_template_id === "string" ? config.process_template_id : undefined,
    fieldMappings: rawMappings.flatMap((rawMapping): WorkflowFieldMapping[] => {
      if (typeof rawMapping !== "object" || rawMapping === null) {
        return [];
      }

      const mapping = rawMapping as Record<string, unknown>;
      const rawSource = mapping.source;

      if (typeof rawSource !== "object" || rawSource === null || typeof mapping.target_field_definition_id !== "string") {
        return [];
      }

      const source = rawSource as Record<string, unknown>;
      const targetFieldDefinitionId = mapping.target_field_definition_id;

      if (source.type === "constant") {
        return [{ targetFieldDefinitionId, source: { type: "constant", value: source.value as never } }];
      }
      if (source.type === "source_field" && typeof source.source_field_definition_id === "string") {
        return [
          {
            targetFieldDefinitionId,
            source: { type: "source_field", sourceFieldDefinitionId: source.source_field_definition_id },
          },
        ];
      }
      if (source.type === "template" && typeof source.template === "string") {
        return [{ targetFieldDefinitionId, source: { type: "template", template: source.template } }];
      }
      if (source.type === "unset") {
        return [{ targetFieldDefinitionId, source: { type: "unset" } }];
      }
      if (source.type === "leave_unchanged") {
        return [{ targetFieldDefinitionId, source: { type: "leave_unchanged" } }];
      }
      if (source.type === "clear") {
        return [{ targetFieldDefinitionId, source: { type: "clear" } }];
      }

      return [];
    }),
  };
}

function serializeActionConfig(actionConfig: WorkflowAction | undefined) {
  if (!actionConfig) return null;

  return {
    action_type: actionConfig.actionType,
    action_target_entity_type_id: actionConfig.actionTargetEntityTypeId ?? null,
    related_field_definition_id: actionConfig.relatedFieldDefinitionId ?? null,
    process_template_id: actionConfig.processTemplateId ?? null,
    field_mappings: actionConfig.fieldMappings.map((mapping) => ({
      target_field_definition_id: mapping.targetFieldDefinitionId,
      source:
        mapping.source.type === "constant"
          ? { type: "constant", value: mapping.source.value }
          : mapping.source.type === "source_field"
            ? { type: "source_field", source_field_definition_id: mapping.source.sourceFieldDefinitionId }
            : mapping.source.type === "template"
              ? { type: "template", template: mapping.source.template }
              : { type: mapping.source.type },
    })),
  };
}

function mapProcessNodeConfig(config: Record<string, unknown>): ProcessNodeConfig {
  const dueRule = config.due_rule;
  const waitRule = config.wait_rule;
  const conditionWaitRule = config.condition_wait_rule;
  const actionConfig = mapActionConfig(config.action_config);

  if (actionConfig) {
    return { actionConfig };
  }

  if (typeof conditionWaitRule === "object" && conditionWaitRule !== null && !Array.isArray(conditionWaitRule)) {
    const rule = conditionWaitRule as Record<string, unknown>;
    const target = rule.target;
    const conditions = rule.conditions;
    if (typeof target === "object" && target !== null && !Array.isArray(target) && Array.isArray(conditions)) {
      const targetRecord = target as Record<string, unknown>;
      if (targetRecord.kind === "origin") {
        return { conditionWaitRule: { target: { kind: "origin" }, conditions: conditions as ProcessBranchCondition[] } };
      }
      if (targetRecord.kind === "related" && typeof targetRecord.relation_field_definition_id === "string" && typeof targetRecord.target_entity_type_id === "string") {
        return {
          conditionWaitRule: {
            target: {
              kind: "related",
              relationFieldDefinitionId: targetRecord.relation_field_definition_id,
              targetEntityTypeId: targetRecord.target_entity_type_id,
            },
            conditions: conditions as ProcessBranchCondition[],
          },
        };
      }
    }
  }

  if (typeof waitRule === "object" && waitRule !== null && !Array.isArray(waitRule)) {
    const rule = waitRule as Record<string, unknown>;

    if (
      rule.kind === "duration" &&
      typeof rule.amount === "number" &&
      (rule.unit === "hours" || rule.unit === "calendar_days")
    ) {
      return {
        waitRule: {
          kind: "duration",
          amount: rule.amount,
          unit: rule.unit,
          ...(typeof rule.time_zone === "string" ? { timeZone: rule.time_zone } : {}),
        },
      };
    }

    if (rule.kind === "weekdays" && typeof rule.amount === "number" && typeof rule.time_zone === "string") {
      return { waitRule: { kind: "weekdays", amount: rule.amount, timeZone: rule.time_zone } };
    }

    if (
      rule.kind === "calendar_target" &&
      typeof rule.target === "string" &&
      typeof rule.time === "string" &&
      typeof rule.time_zone === "string"
    ) {
      if (rule.target === "nth_weekday_next_month" && typeof rule.ordinal === "number") {
        return { waitRule: { kind: "calendar_target", target: rule.target, ordinal: rule.ordinal, time: rule.time, timeZone: rule.time_zone } };
      }
      if (rule.target === "first_day_of_week_next_month" && typeof rule.weekday === "number") {
        return { waitRule: { kind: "calendar_target", target: rule.target, weekday: rule.weekday, time: rule.time, timeZone: rule.time_zone } };
      }
      if (rule.target === "specific_datetime" && typeof rule.date === "string") {
        return { waitRule: { kind: "calendar_target", target: rule.target, date: rule.date, time: rule.time, timeZone: rule.time_zone } };
      }
    }
  }

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

function serializeWaitRule(waitRule: ProcessWaitRule | undefined) {
  if (!waitRule) return null;

  if (waitRule.kind === "duration") {
    return {
      kind: waitRule.kind,
      amount: waitRule.amount,
      unit: waitRule.unit,
      ...(waitRule.timeZone ? { time_zone: waitRule.timeZone } : {}),
    };
  }

  if (waitRule.kind === "weekdays") {
    return { kind: waitRule.kind, amount: waitRule.amount, time_zone: waitRule.timeZone };
  }

  if (waitRule.target === "nth_weekday_next_month") {
    return {
      kind: waitRule.kind,
      target: waitRule.target,
      ordinal: waitRule.ordinal,
      time: waitRule.time,
      time_zone: waitRule.timeZone,
    };
  }

  if (waitRule.target === "first_day_of_week_next_month") {
    return {
      kind: waitRule.kind,
      target: waitRule.target,
      weekday: waitRule.weekday,
      time: waitRule.time,
      time_zone: waitRule.timeZone,
    };
  }

  return {
    kind: waitRule.kind,
    target: waitRule.target,
    date: waitRule.date,
    time: waitRule.time,
    time_zone: waitRule.timeZone,
  };
}

function serializeConditionWaitRule(rule: ProcessConditionWaitRule | undefined) {
  if (!rule) return null;
  return {
    target:
      rule.target.kind === "related"
        ? {
            kind: "related",
            relation_field_definition_id: rule.target.relationFieldDefinitionId,
            target_entity_type_id: rule.target.targetEntityTypeId,
          }
        : { kind: "origin" },
    conditions: rule.conditions,
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
    resumeAt: row.resume_at ?? undefined,
    conditionWaitResult: row.condition_wait_result ?? undefined,
    completedAt: row.completed_at ?? undefined,
    assigneeUserId: row.assignee_user_id ?? undefined,
    assigneeLabel: row.assignee_label ?? undefined,
    approvalOutcomeId: row.approval_outcome_id ?? undefined,
    approvalOutcomeLabel: row.approval_outcome_label ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    decidedByUserId: row.decided_by_user_id ?? undefined,
    decidedByLabel: row.decided_by_label ?? undefined,
    routingResult: row.routing_result ?? undefined,
    actionResult: row.action_result ?? undefined,
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
      wait_rule: serializeWaitRule(step.waitRule),
      condition_wait_rule: serializeConditionWaitRule(step.conditionWaitRule),
      action_config: serializeActionConfig(step.actionConfig),
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
  supabase: injectedSupabase,
  originatingProcessStepRunId,
  viaWorkflow = false,
}: {
  workspaceId: string;
  processTemplateId: string;
  originEntityTypeId: string;
  originRecordId: string;
  supabase?: SupabaseServerClient;
  originatingProcessStepRunId?: string;
  // Selects which interactive door into the canonical start implementation
  // this call uses -- both require the same processes.operate capability,
  // they differ only in Activity actor attribution. false (default, the
  // manual "Start Process" button's path) records the acting human as the
  // process_started event's actor. true (workflow-engine.ts only) records
  // no actor: a workflow-triggered start is deterministic automation, not
  // a direct human action, even though it runs under the triggering
  // editor's own session -- attributing it to them would be exactly the
  // "last editor" misattribution Activity is meant to avoid.
  viaWorkflow?: boolean;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc(
    viaWorkflow ? "start_process_run_via_workflow_authorized" : "start_process_run_authorized",
    {
      p_workspace_id: workspaceId,
      p_process_template_id: processTemplateId,
      p_origin_entity_type_id: originEntityTypeId,
      p_origin_record_id: originRecordId,
      p_originating_process_step_run_id: originatingProcessStepRunId ?? null,
    },
  );

  if (error) {
    throw new Error(`Unable to start process: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to start process: unexpected RPC response.");
  }

  await executeActiveProcessActionSteps({ workspaceId, processRunId: data, supabase });

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

  await executeActiveProcessActionSteps({ workspaceId, processRunId, supabase });
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

  await executeActiveProcessActionSteps({ workspaceId, processRunId, supabase });
}

export async function getProcessRunWithSteps({
  workspaceId,
  processRunId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  processRunId: string;
  supabase?: SupabaseServerClient;
}): Promise<ProcessRunWithSteps> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
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

// The canonical system action-step executor (see Automated Action Nodes
// design note): the caller says "execute this active ProcessStepRun," never
// "perform this record mutation." Reads the action to perform only from the
// step's own immutable config snapshot, executes it via the same action
// machinery workflows use, and always ends by calling one of the two
// narrow completion RPCs -- success advances the run through the existing
// canonical continuation helper; failure leaves the step active and visible,
// retryable by any workspace member. Used identically whether the step was
// reached via human completion, approval, timer wait, condition wait,
// another action, or parallel/system advancement -- the only difference
// between an interactive retry and the wait/condition-wait scheduler is
// which `supabase` client is passed in.
async function executeAndCompleteActionStep({
  workspaceId,
  processRunId,
  step,
  originEntityTypeId,
  originRecordId,
  supabase,
}: {
  workspaceId: string;
  processRunId: string;
  step: ProcessStepRun;
  originEntityTypeId: string;
  originRecordId: string;
  supabase: SupabaseServerClient;
}) {
  const attemptedAt = new Date().toISOString();

  if (!step.config.actionConfig) {
    await supabase.rpc("fail_process_action_step_authorized", {
      p_workspace_id: workspaceId,
      p_process_run_id: processRunId,
      p_step_run_id: step.id,
      p_action_result: {
        status: "failed",
        errorMessage: "Action step is missing its configuration.",
        attemptedAt,
      } satisfies ProcessStepActionResult,
    });
    return;
  }

  try {
    const sourceContext = await getEntityContext({
      workspaceId,
      entityTypeId: originEntityTypeId,
      includeArchivedFields: true,
      supabase,
    });
    const originRecord = await getEntityRecord({
      workspaceId,
      entityTypeId: originEntityTypeId,
      recordId: originRecordId,
      fields: sourceContext.fields,
      supabase,
    });
    const result = await executeSingleAction({
      workspaceId,
      sourceContext,
      triggerRecord: originRecord,
      action: step.config.actionConfig,
      context: { supabase, originatingProcessStepRunId: step.id },
    });
    const { error } = await supabase.rpc("complete_process_action_step_authorized", {
      p_workspace_id: workspaceId,
      p_process_run_id: processRunId,
      p_step_run_id: step.id,
      p_action_result: {
        status: "succeeded",
        actionEntityTypeId: result.actionEntityTypeId,
        actionRecordId: result.actionRecordId,
        createdRecordId: result.createdRecordId,
        processTemplateId: result.processTemplateId,
        processRunId: result.processRunId,
        resultMessage: result.resultMessage,
        attemptedAt,
      } satisfies ProcessStepActionResult,
    });

    if (error) {
      throw new Error(`Unable to record action step result: ${error.message}`);
    }
  } catch (executionError) {
    const errorMessage =
      executionError instanceof Error ? executionError.message : "Unknown action execution error.";
    const { error } = await supabase.rpc("fail_process_action_step_authorized", {
      p_workspace_id: workspaceId,
      p_process_run_id: processRunId,
      p_step_run_id: step.id,
      p_action_result: {
        status: "failed",
        errorMessage,
        attemptedAt,
      } satisfies ProcessStepActionResult,
    });

    if (error) {
      throw new Error(`Unable to record action step failure: ${error.message}`);
    }
  }
}

const MAX_ACTION_ACTIVATION_PASSES = 25;

// Drains every currently-active, unresolved action step in one run, one pass
// at a time, until none remain -- covering chained action nodes and several
// parallel branches each landing on their own action step. Called after
// every mutation that can activate a step (start, complete, decide, and the
// wait/condition-wait scheduler after its own dispatch RPCs), so manual and
// workflow-triggered runs -- both of which funnel through these same
// repository functions -- behave identically.
export async function executeActiveProcessActionSteps({
  workspaceId,
  processRunId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  processRunId: string;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());

  for (let pass = 0; pass < MAX_ACTION_ACTIVATION_PASSES; pass += 1) {
    const run = await getProcessRunWithSteps({ workspaceId, processRunId, supabase });
    const pendingSteps = run.steps.filter(
      (step) => step.nodeType === "action" && step.status === "active" && !step.actionResult,
    );

    if (pendingSteps.length === 0) {
      return;
    }

    for (const step of pendingSteps) {
      await executeAndCompleteActionStep({
        workspaceId,
        processRunId,
        step,
        originEntityTypeId: run.originEntityTypeId,
        originRecordId: run.originRecordId,
        supabase,
      });
    }
  }

  throw new Error("Process action execution did not settle after repeated activation.");
}

// The scheduler's discovery query: narrow (identity only, no mutation) and
// cross-run, since one dispatch batch can activate action nodes across many
// runs/workspaces. Execution still goes through the identical canonical
// executor above, run by run -- never a bulk mutation path.
export async function listActiveProcessActionStepRuns({
  supabase,
}: {
  supabase: SupabaseServerClient;
}): Promise<Array<{ workspaceId: string; processRunId: string }>> {
  const { data, error } = await supabase
    .from("process_step_runs")
    .select("workspace_id, process_run_id")
    .eq("node_type", "action")
    .eq("status", "active")
    .is("action_result", null)
    .returns<Array<{ workspace_id: string; process_run_id: string }>>();

  if (error) {
    throw new Error(`Unable to list pending action steps: ${error.message}`);
  }

  const seen = new Set<string>();
  const runs: Array<{ workspaceId: string; processRunId: string }> = [];

  for (const row of data) {
    const key = `${row.workspace_id}:${row.process_run_id}`;

    if (!seen.has(key)) {
      seen.add(key);
      runs.push({ workspaceId: row.workspace_id, processRunId: row.process_run_id });
    }
  }

  return runs;
}

// Retry is the identical canonical executor, scoped to one already-active
// action step -- not a separate code path. A no-op if the step has since
// resolved (completed by a concurrent retry, or the run is no longer active).
export async function retryProcessActionStep({
  workspaceId,
  processRunId,
  stepRunId,
}: {
  workspaceId: string;
  processRunId: string;
  stepRunId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const run = await getProcessRunWithSteps({ workspaceId, processRunId, supabase });
  const step = run.steps.find((candidate) => candidate.id === stepRunId);

  if (!step || step.nodeType !== "action" || step.status !== "active") {
    return;
  }

  await executeAndCompleteActionStep({
    workspaceId,
    processRunId,
    step,
    originEntityTypeId: run.originEntityTypeId,
    originRecordId: run.originRecordId,
    supabase,
  });
  await executeActiveProcessActionSteps({ workspaceId, processRunId, supabase });
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

// This is the shared projection behind personal My Work and the Phase 7C
// management portfolio. It only includes active work and the same
// deterministic pending successors My Work has always exposed.
export async function listAssignedWorkItems({
  workspaceId,
  assigneeUserIds,
}: {
  workspaceId: string;
  assigneeUserIds: string[];
}): Promise<MyWorkSummary> {
  const uniqueAssigneeUserIds = [...new Set(assigneeUserIds)];
  if (uniqueAssigneeUserIds.length === 0) {
    return { overdue: [], readyNow: [], upcoming: [] };
  }

  const supabase = await createServerSupabaseClient();
  // Two queries rather than one embedded select: process_runs.
  // originating_process_step_run_id (added for action-node idempotency) is
  // a second relationship between these two tables, so PostgREST can no
  // longer auto-embed process_runs from process_step_runs without an
  // explicit constraint-name hint -- a plain re-query avoids depending on
  // that generated name at all.
  const { data: assignedStepRows, error: assignedStepError } = await supabase
    .from("process_step_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("assignee_user_id", uniqueAssigneeUserIds)
    .in("status", ["active", "pending"])
    .returns<ProcessStepRunRow[]>();

  if (assignedStepError) {
    throw new Error(`Unable to load My Work: ${assignedStepError.message}`);
  }

  if (assignedStepRows.length === 0) {
    return { overdue: [], readyNow: [], upcoming: [] };
  }

  const assignedRunIds = [...new Set(assignedStepRows.map((row) => row.process_run_id))];
  const { data: activeRunRows, error: activeRunError } = await supabase
    .from("process_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("id", assignedRunIds)
    .eq("status", "active")
    .returns<ProcessRunRow[]>();

  if (activeRunError) {
    throw new Error(`Unable to load My Work: ${activeRunError.message}`);
  }

  const activeRunById = new Map(activeRunRows.map((row) => [row.id, mapProcessRun(row)]));
  const entries = assignedStepRows
    .flatMap((row) => {
      const run = activeRunById.get(row.process_run_id);

      return run ? [{ stepRun: mapProcessStepRun(row), run }] : [];
    })
    .sort(
      (left, right) =>
        left.run.startedAt.localeCompare(right.run.startedAt) ||
        left.stepRun.stepIndex - right.stepRun.stepIndex,
    );

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

// "My Work" is a convenience filter over data every workspace member can
// already see (via Process Run detail), not a new visibility boundary — the
// acting user id is always resolved server-side, never accepted from the
// caller. effectiveUserId lets an impersonation-aware page pass the
// server-verified effective user (from resolveImpersonationContext) instead
// of the real actor's own id — still never client-supplied, just a
// different server-side resolution than getCurrentUser().
export async function listMyWorkItems({
  workspaceId,
  effectiveUserId,
}: {
  workspaceId: string;
  effectiveUserId?: string;
}): Promise<MyWorkSummary> {
  const userId = effectiveUserId ?? (await getCurrentUser())?.id;

  return userId
    ? listAssignedWorkItems({ workspaceId, assigneeUserIds: [userId] })
    : { overdue: [], readyNow: [], upcoming: [] };
}
