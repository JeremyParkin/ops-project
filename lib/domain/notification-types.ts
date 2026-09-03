import type { IsoUtcTimestamp } from "./types";

export type NotificationEventType =
  | "step_assigned"
  | "step_due_soon"
  | "step_overdue"
  | "record_comment_mentioned"
  | "process_step_run_comment_mentioned"
  | "record_input_request_created"
  | "record_input_request_responded"
  | "record_input_request_cancelled"
  | "process_step_run_input_request_created"
  | "process_step_run_input_request_responded"
  | "process_step_run_input_request_cancelled";

export type WorkspaceNotification = {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  eventType: NotificationEventType;
  processTemplateId?: string;
  processRunId?: string;
  processStepRunId?: string;
  recordCommentId?: string;
  processStepRunCommentId?: string;
  recordInputRequestId?: string;
  processStepRunInputRequestId?: string;
  entityTypeId?: string;
  entityRecordId?: string;
  title: string;
  destinationHref: string;
  createdAt: IsoUtcTimestamp;
  readAt?: IsoUtcTimestamp;
  /** Origin business-object label + process name, resolved live for display
   * (not stored) -- see notification-repository.ts's batched resolution. */
  context?: {
    processTemplateName?: string;
    originLabel?: string;
    originEntityTypeName?: string;
  };
};
