// The webhookable subset of workspace_events' event_type vocabulary (0064/
// 0065/0068). Deliberately narrower than the full vocabulary: step_due_soon/
// step_overdue are notification-only noise, recurrence_started_process is
// excluded for now (no concrete product need yet -- easy to add later), and
// impersonation_started/impersonation_ended are session-lifecycle audit
// events, not operational events an external system should react to. Kept
// in sync with the CHECK constraint's inline vocabulary in migration 0073.
export const webhookEventTypes = ["process_started", "process_completed", "approval_decided", "step_assigned"] as const;

export type WebhookEventType = (typeof webhookEventTypes)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (webhookEventTypes as readonly string[]).includes(value);
}

export const webhookEventTypeLabels: Record<WebhookEventType, string> = {
  process_started: "Process started",
  process_completed: "Process completed",
  approval_decided: "Approval decided",
  step_assigned: "Step assigned",
};
