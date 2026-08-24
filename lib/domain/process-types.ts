import type { EntityRecord, EntityType, IsoUtcTimestamp } from "./types";

export type ProcessNodeType = "human_task" | "approval" | "parallel_split" | "parallel_join";
export type ProcessRunStatus = "active" | "completed";
export type ProcessStepRunStatus = "pending" | "active" | "completed" | "skipped";

export type ProcessDueRule = {
  amount: number;
  unit: "hours" | "days";
};

export type ProcessNodeConfig = {
  dueRule?: ProcessDueRule;
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
