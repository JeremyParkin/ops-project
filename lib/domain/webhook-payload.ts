// The wire shape sent to an external endpoint. Deliberately small and
// stable: raw uuid refs and a raw actor id, never a resolved record/process
// dump and never a resolved actor label/email (no live join at delivery
// time -- a receiver that needs a label is the read-API's job, not this
// one's). refs only ever includes the reference columns that are actually
// non-null on the source workspace_events row, so a receiver never has to
// wonder what a null process_run_id on a step_assigned event means.
export type WebhookDeliveryEventRow = {
  deliveryId: string;
  eventId: string;
  eventType: string;
  eventOccurredAt: string;
  workspaceId: string;
  actorUserId: string | null;
  realActorUserId: string | null;
  entityTypeId: string | null;
  entityRecordId: string | null;
  processTemplateId: string | null;
  processRunId: string | null;
  processStepRunId: string | null;
  metadata: Record<string, unknown>;
};

export type WebhookPayload = {
  id: string;
  event: {
    id: string;
    type: string;
    occurred_at: string;
    workspace_id: string;
    actor_user_id: string | null;
    real_actor_user_id: string | null;
    refs: Record<string, string>;
    metadata: Record<string, unknown>;
  };
};

const REF_FIELDS = [
  ["entityTypeId", "entity_type_id"],
  ["entityRecordId", "entity_record_id"],
  ["processTemplateId", "process_template_id"],
  ["processRunId", "process_run_id"],
  ["processStepRunId", "process_step_run_id"],
] as const;

export function buildWebhookPayload(row: WebhookDeliveryEventRow): WebhookPayload {
  const refs: Record<string, string> = {};
  for (const [sourceKey, refKey] of REF_FIELDS) {
    const value = row[sourceKey];
    if (value) refs[refKey] = value;
  }

  return {
    id: row.deliveryId,
    event: {
      id: row.eventId,
      type: row.eventType,
      occurred_at: row.eventOccurredAt,
      workspace_id: row.workspaceId,
      actor_user_id: row.actorUserId,
      real_actor_user_id: row.realActorUserId,
      refs,
      metadata: row.metadata,
    },
  };
}
