import { describe, expect, it } from "vitest";
import { mapWorkspaceAdministrativeHistoryRpcRow } from "./workspace-administrative-history-repository";

describe("Workspace Administrative History repository mapping", () => {
  it("normalizes the complete snake_case RPC row", () => {
    const mapped = mapWorkspaceAdministrativeHistoryRpcRow({
      event_id: "governance:event-1", source_family: "governance", source_event_id: "event-1",
      occurred_at: "2026-01-01T00:00:00Z", event_type: "field_created", category: "Schema",
      subject_kind: "field", subject_id: "field-1", subject_label: "Region", actor_user_id: "actor-1",
      effective_user_id: null, real_user_id: null, authority_kind: "human", summary_key: "field_created",
      details: { type: "text" }, correlation_id: "operation-1",
    });

    expect(mapped).toEqual({
      eventId: "governance:event-1", sourceFamily: "governance", sourceEventId: "event-1",
      occurredAt: "2026-01-01T00:00:00Z", eventType: "field_created", category: "Schema",
      subjectKind: "field", subjectId: "field-1", subjectLabel: "Region", actorUserId: "actor-1",
      effectiveUserId: null, realUserId: null, authorityKind: "human", summaryKey: "field_created",
      details: { type: "text" }, correlationId: "operation-1",
    });
  });

  it("rejects missing required identity fields", () => {
    expect(() => mapWorkspaceAdministrativeHistoryRpcRow({
      event_id: "", source_family: "governance", source_event_id: "event-1", occurred_at: "2026-01-01T00:00:00Z",
      event_type: "field_created", category: "Schema", subject_kind: null, subject_id: null, subject_label: null,
      actor_user_id: null, effective_user_id: null, real_user_id: null, authority_kind: null,
      summary_key: "field_created", details: {}, correlation_id: null,
    })).toThrow("event_id");
  });
});
