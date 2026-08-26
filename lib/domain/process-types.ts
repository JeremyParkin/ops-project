import type { EntityRecord, EntityType, IsoUtcTimestamp } from "./types";
import type { WorkflowAction } from "./workflow-types";

export type ProcessNodeType =
  | "human_task"
  | "approval"
  | "wait"
  | "condition_wait"
  | "action"
  | "parallel_split"
  | "parallel_join";
export type ProcessRunStatus = "active" | "completed";
export type ProcessStepRunStatus = "pending" | "active" | "completed" | "skipped";

export type ProcessDueRule = {
  amount: number;
  unit: "hours" | "days";
};

export type ProcessWaitRule =
  | {
      kind: "duration";
      amount: number;
      unit: "hours" | "calendar_days";
      timeZone?: string;
    }
  | {
      kind: "weekdays";
      amount: number;
      timeZone: string;
    }
  | {
      kind: "calendar_target";
      target: "nth_weekday_next_month";
      ordinal: number;
      time: string;
      timeZone: string;
    }
  | {
      kind: "calendar_target";
      target: "first_day_of_week_next_month";
      weekday: number;
      time: string;
      timeZone: string;
    }
  | {
      kind: "calendar_target";
      target: "specific_datetime";
      date: string;
      time: string;
      timeZone: string;
    };

export type ProcessConditionWaitTarget =
  | { kind: "origin" }
  | {
      kind: "related";
      relationFieldDefinitionId: string;
      targetEntityTypeId: string;
    };

export type ProcessConditionWaitRule = {
  target: ProcessConditionWaitTarget;
  conditions: ProcessBranchCondition[];
};

export type ProcessNodeConfig = {
  dueRule?: ProcessDueRule;
  waitRule?: ProcessWaitRule;
  conditionWaitRule?: ProcessConditionWaitRule;
  actionConfig?: WorkflowAction;
};

// Durable result/history snapshot for an 'action' node execution. Mirrors
// WorkflowActionResult's shape without reusing "index" (an action node has
// no sibling actions in v1). status='failed' with the step still 'active' is
// the retryable failure state -- see process_step_runs_action_shape_check.
export type ProcessStepActionResult = {
  status: "succeeded" | "failed";
  actionEntityTypeId?: string;
  actionRecordId?: string;
  createdRecordId?: string;
  processTemplateId?: string;
  processRunId?: string;
  resultMessage?: string;
  errorMessage?: string;
  attemptedAt: IsoUtcTimestamp;
};

export type ProcessBranchConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "before"
  | "after"
  | "is_set"
  | "is_not_set";

export type ProcessBranchCondition = {
  sourceFieldDefinitionId: string;
  operator: ProcessBranchConditionOperator;
  value?: string | number | boolean | null;
};

export type ProcessTemplate = {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  appliesToEntityTypeId: EntityType["id"];
  archivedAt?: IsoUtcTimestamp;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type ProcessNode = {
  id: string;
  workspaceId: string;
  processTemplateId: string;
  nodeType: ProcessNodeType;
  name: string;
  position: number;
  parallelGroupId?: string;
  // Fixed v1 assignment: no assignee, or exactly one current workspace
  // member. Structurally guaranteed (composite FK) to be a member of this
  // same workspace whenever set.
  assigneeUserId?: string;
  config: ProcessNodeConfig;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type WorkspaceMemberIdentity = {
  userId: string;
  email: string;
};

export type ProcessEdge = {
  id: string;
  workspaceId: string;
  processTemplateId: string;
  sourceNodeId: string;
  targetNodeId: string;
  priority: number;
  conditionConfig?: ProcessBranchCondition[];
  isDefault: boolean;
  isParallel: boolean;
  approvalOutcomeId?: string;
  approvalOutcomeLabel?: string;
  createdAt: IsoUtcTimestamp;
};

// Nodes retain stable editor/topological position order; edges describe the
// template graph. A started run snapshots those edges before execution.
export type ProcessTemplateWithSteps = ProcessTemplate & {
  steps: ProcessNode[];
  edges: ProcessEdge[];
};

export type ProcessRun = {
  id: string;
  workspaceId: string;
  processTemplateId: string;
  // Snapshotted at start time so a later template rename/redescribe never
  // rewrites this run's historical meaning.
  processTemplateName: string;
  processTemplateDescription?: string;
  originEntityTypeId: EntityType["id"];
  originRecordId: EntityRecord["id"];
  status: ProcessRunStatus;
  startedAt: IsoUtcTimestamp;
  completedAt?: IsoUtcTimestamp;
};

export type ProcessStepRun = {
  id: string;
  workspaceId: string;
  processRunId: string;
  // Soft reference for traceability only; never relied on for correctness.
  sourceNodeId?: string;
  stepIndex: number;
  nodeType: ProcessNodeType;
  parallelGroupId?: string;
  parallelBranchToken?: string;
  name: string;
  config: ProcessNodeConfig;
  status: ProcessStepRunStatus;
  startedAt?: IsoUtcTimestamp;
  dueAt?: IsoUtcTimestamp;
  resumeAt?: IsoUtcTimestamp;
  conditionWaitResult?: {
    status: "waiting" | "blocked";
    evaluatedAt: IsoUtcTimestamp;
    targetRecordId?: string;
    message?: string;
  };
  completedAt?: IsoUtcTimestamp;
  // Snapshotted at run start: assigneeUserId is used for completion
  // authorization (compared against the acting user), assigneeLabel (the
  // assignee's email at that moment) is what historical UI displays — it
  // never depends on the membership row still existing.
  assigneeUserId?: string;
  assigneeLabel?: string;
  approvalOutcomeId?: string;
  approvalOutcomeLabel?: string;
  decidedAt?: IsoUtcTimestamp;
  decidedByUserId?: string;
  decidedByLabel?: string;
  routingResult?: ProcessStepRunRoutingResult;
  actionResult?: ProcessStepActionResult;
};

export type ProcessStepRunRoute = {
  id: string;
  workspaceId: string;
  processRunId: string;
  sourceStepRunId: string;
  targetStepRunId: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  priority: number;
  conditions?: ProcessBranchCondition[];
  conditionSummary?: string;
  isDefault: boolean;
  isParallel: boolean;
  approvalOutcomeId?: string;
  approvalOutcomeLabel?: string;
};

export type ProcessStepRunRoutingResult = {
  selectedRouteId?: string;
  targetStepRunId?: string;
  selectedRouteIds?: string[];
  targetStepRunIds?: string[];
  outcome:
    | "unconditional"
    | "matched_condition"
    | "default_fallback"
    | "approval_outcome"
    | "condition_satisfied"
    | "action_succeeded"
    | "parallel_split"
    | "parallel_join";
  evaluatedAt: IsoUtcTimestamp;
  approvalOutcomeId?: string;
  approvalOutcomeLabel?: string;
  evaluatedConditions?: Array<{
    fieldName: string;
    operator: ProcessBranchConditionOperator;
    expectedValue?: string | number | boolean | null;
    actualValue?: string | number | boolean | null;
    matched: boolean;
  }>;
};

export type ProcessParallelJoinObligation = {
  id: string;
  workspaceId: string;
  processRunId: string;
  joinStepRunId: string;
  parallelGroupId: string;
  branchToken: string;
  arrivedAt?: IsoUtcTimestamp;
  arrivalSourceStepRunId?: string;
};

export type ProcessRunWithSteps = ProcessRun & {
  steps: ProcessStepRun[];
  routes: ProcessStepRunRoute[];
  joinObligations: ProcessParallelJoinObligation[];
};
