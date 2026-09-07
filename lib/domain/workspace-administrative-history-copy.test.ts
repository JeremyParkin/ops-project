import { describe, expect, it } from "vitest";
import { formatWorkspaceAdministrativeHistoryEvent } from "./workspace-administrative-history-copy";
import type { WorkspaceAdministrativeHistoryEvent } from "./workspace-administrative-history-repository";

function event(overrides: Partial<WorkspaceAdministrativeHistoryEvent>): WorkspaceAdministrativeHistoryEvent {
  return {
    eventId: "governance:1", sourceFamily: "governance", sourceEventId: "1", occurredAt: "2026-01-01T00:00:00Z",
    eventType: "workspace_role_updated", category: "Access", subjectKind: "workspace_role", subjectId: "1", subjectLabel: "Reviewer",
    actorUserId: "actor", effectiveUserId: null, realUserId: null, authorityKind: "human", summaryKey: "workspace_role_updated", details: {}, correlationId: null,
    ...overrides,
  };
}

describe("Workspace Administrative History copy", () => {
  it("formats a mapped Field event with product language", () => {
    expect(formatWorkspaceAdministrativeHistoryEvent(event({
      eventType: "field_created", summaryKey: "field_created", category: "Schema", subjectKind: "field", subjectLabel: "Region",
    })).title).toBe("Added field “Region”");
  });

  it("uses product terminology and historical labels", () => {
    expect(formatWorkspaceAdministrativeHistoryEvent(event({ eventType: "workflow_created", category: "Schema", subjectKind: "workflow", subjectLabel: "Notify owner" })).title).toBe("Created Automation “Notify owner”");
  });

  it("renders role capability changes without raw event vocabulary", () => {
    expect(formatWorkspaceAdministrativeHistoryEvent(event({ details: { old_capabilities: ["operations.view"], new_capabilities: ["workspace.audit.read"] } })).title).toBe("Updated role “Reviewer”");
  });

  it("uses deterministic impersonation reasons", () => {
    expect(formatWorkspaceAdministrativeHistoryEvent(event({ eventType: "impersonation_ended", category: "Support / Impersonation", subjectKind: "user", subjectLabel: "Taylor", effectiveUserId: "target", details: { reason: "target_deactivated" } })).title).toContain("account was deactivated");
  });
});
