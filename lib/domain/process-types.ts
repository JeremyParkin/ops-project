import type { EntityRecord, EntityType, IsoUtcTimestamp } from "./types";

export type ProcessNodeType = "human_task";
export type ProcessRunStatus = "active" | "completed";
export type ProcessStepRunStatus = "pending" | "active" | "completed";

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
  config: Record<string, never>;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type ProcessEdge = {
  id: string;
  workspaceId: string;
  processTemplateId: string;
  sourceNodeId: string;
  targetNodeId: string;
  createdAt: IsoUtcTimestamp;
};

// A template with its nodes already linearized by walking process_edges
// from the node with no incoming edge. This is the shape the template
// editor and process-start logic actually want to work with.
export type ProcessTemplateWithSteps = ProcessTemplate & {
  steps: ProcessNode[];
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
  name: string;
  config: Record<string, never>;
  status: ProcessStepRunStatus;
  startedAt?: IsoUtcTimestamp;
  completedAt?: IsoUtcTimestamp;
};

export type ProcessRunWithSteps = ProcessRun & {
  steps: ProcessStepRun[];
};
