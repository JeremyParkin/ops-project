import type { IsoUtcTimestamp } from "./types";

export type NotificationEventType = "step_assigned" | "step_due_soon" | "step_overdue";

export type WorkspaceNotification = {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  eventType: NotificationEventType;
  processTemplateId?: string;
  processRunId?: string;
  processStepRunId?: string;
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
