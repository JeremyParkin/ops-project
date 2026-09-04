import type { IsoUtcTimestamp } from "./types";

export type ActivityEventType =
  | "process_started"
  | "process_completed"
  | "step_assigned"
  | "approval_decided"
  | "process_cancelled"
  | "step_reassigned";

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
  /** process_step_runs.assignee_label -- the step's *current* effective assignee, which may have changed since this event. */
  assigneeLabel?: string;
  /** process_step_runs.approval_outcome_label, snapshotted at decision time. */
  approvalOutcomeLabel?: string;
  isRecurrenceStarted: boolean;
  /** process_runs.cancellation_reason, required at cancellation time. */
  cancellationReason?: string;
  /** step_reassigned event metadata, frozen at reassignment time -- never a live join, since a later reassignment must not corrupt an earlier event's own from/to display. */
  fromAssigneeLabel?: string;
  toAssigneeLabel?: string;
};
