import type { IsoUtcTimestamp } from "./types";

export type ActivityEventType = "process_started" | "process_completed" | "step_assigned" | "approval_decided";

export type RecordActivityEvent = {
  id: string;
  eventType: ActivityEventType;
  createdAt: IsoUtcTimestamp;
  actorUserId?: string;
  /** Durable (approval_decided) or live-resolved (process_started) label -- see activity-repository.ts. */
  actorLabel?: string;
  processRunId?: string;
  /** process_runs.process_template_name, snapshotted at run start. */
  processRunName?: string;
  processStepRunId?: string;
  /** process_step_runs.name, snapshotted at run start. */
  stepName?: string;
  /** process_step_runs.assignee_label, snapshotted at run start. */
  assigneeLabel?: string;
  /** process_step_runs.approval_outcome_label, snapshotted at decision time. */
  approvalOutcomeLabel?: string;
  isRecurrenceStarted: boolean;
};
