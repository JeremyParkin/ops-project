import { describe, expect, it } from "vitest";
import { buildWebhookPayload, type WebhookDeliveryEventRow } from "./webhook-payload";

function row(overrides: Partial<WebhookDeliveryEventRow> = {}): WebhookDeliveryEventRow {
  return {
    deliveryId: "delivery-1",
    eventId: "event-1",
    eventType: "process_started",
    eventOccurredAt: "2026-08-30T12:00:00.000Z",
    workspaceId: "workspace-1",
    actorUserId: null,
    realActorUserId: null,
    entityTypeId: null,
    entityRecordId: null,
    processTemplateId: null,
    processRunId: null,
    processStepRunId: null,
    metadata: {},
    ...overrides,
  };
}

describe("buildWebhookPayload", () => {
  it("carries the delivery id at the top level and the event id/type/timestamp/workspace inside event", () => {
    const payload = buildWebhookPayload(row());
    expect(payload.id).toBe("delivery-1");
    expect(payload.event.id).toBe("event-1");
    expect(payload.event.type).toBe("process_started");
    expect(payload.event.occurred_at).toBe("2026-08-30T12:00:00.000Z");
    expect(payload.event.workspace_id).toBe("workspace-1");
  });

  it("includes raw actor ids, never a resolved label", () => {
    const payload = buildWebhookPayload(row({ actorUserId: "user-1", realActorUserId: "user-2" }));
    expect(payload.event.actor_user_id).toBe("user-1");
    expect(payload.event.real_actor_user_id).toBe("user-2");
  });

  it("omits ref keys whose source column is null", () => {
    const payload = buildWebhookPayload(row({ processRunId: "run-1" }));
    expect(payload.event.refs).toEqual({ process_run_id: "run-1" });
  });

  it("includes every non-null ref column", () => {
    const payload = buildWebhookPayload(
      row({
        entityTypeId: "et-1",
        entityRecordId: "er-1",
        processTemplateId: "pt-1",
        processRunId: "pr-1",
        processStepRunId: "psr-1",
      }),
    );
    expect(payload.event.refs).toEqual({
      entity_type_id: "et-1",
      entity_record_id: "er-1",
      process_template_id: "pt-1",
      process_run_id: "pr-1",
      process_step_run_id: "psr-1",
    });
  });

  it("passes metadata through unchanged", () => {
    const payload = buildWebhookPayload(row({ metadata: { outcome: "approved" } }));
    expect(payload.event.metadata).toEqual({ outcome: "approved" });
  });
});
