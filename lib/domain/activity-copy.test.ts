import { describe, expect, it } from "vitest";
import { formatActivityEvent } from "./activity-copy";
import type { RecordActivityEvent } from "./activity-types";

function baseEvent(overrides: Partial<RecordActivityEvent> = {}): RecordActivityEvent {
  return {
    id: "event-1",
    eventType: "process_started",
    createdAt: "2026-08-30T09:15:00.000Z",
    isRecurrenceStarted: false,
    ...overrides,
  };
}

describe("formatActivityEvent", () => {
  it("renders a manual process start with the acting human implied by an actor", () => {
    const copy = formatActivityEvent(
      baseEvent({
        eventType: "process_started",
        actorUserId: "user-1",
        processRunId: "run-1",
        processRunName: "Monthly Client Report",
      }),
    );

    expect(copy.title).toBe("Monthly Client Report started");
    expect(copy.meta).toBeUndefined();
    expect(copy.href).toBe("/process-runs/run-1");
  });

  it("renders a workflow-triggered process start as automatic, with no actor implied", () => {
    const copy = formatActivityEvent(
      baseEvent({
        eventType: "process_started",
        actorUserId: undefined,
        processRunName: "Monthly Client Report",
        isRecurrenceStarted: false,
      }),
    );

    expect(copy.title).toBe("Monthly Client Report started automatically");
    expect(copy.meta).toBeUndefined();
  });

  it("renders a recurrence-triggered process start as automatic with a Scheduled meta line", () => {
    const copy = formatActivityEvent(
      baseEvent({
        eventType: "process_started",
        actorUserId: undefined,
        processRunName: "Monthly Client Report",
        isRecurrenceStarted: true,
      }),
    );

    expect(copy.title).toBe("Monthly Client Report started automatically");
    expect(copy.meta).toBe("Scheduled");
  });

  it("falls back to a generic process name when the run name is missing", () => {
    const copy = formatActivityEvent(baseEvent({ eventType: "process_started", processRunName: undefined }));

    expect(copy.title).toBe("Process started automatically");
  });

  it("renders process completion with no actor phrasing at all", () => {
    const copy = formatActivityEvent(
      baseEvent({ eventType: "process_completed", processRunName: "Monthly Client Report", processRunId: "run-1" }),
    );

    expect(copy.title).toBe("Monthly Client Report completed");
    expect(copy.href).toBe("/process-runs/run-1");
  });

  it("renders assignment with the durable assignee label", () => {
    const copy = formatActivityEvent(
      baseEvent({
        eventType: "step_assigned",
        stepName: "Review Summary",
        assigneeLabel: "alex@example.com",
      }),
    );

    expect(copy.title).toBe("alex@example.com was assigned Review Summary");
  });

  it("falls back gracefully when assignment has no resolvable assignee label", () => {
    const copy = formatActivityEvent(
      baseEvent({ eventType: "step_assigned", stepName: "Review Summary", assigneeLabel: undefined }),
    );

    expect(copy.title).toBe("Review Summary was assigned");
  });

  it("renders an approval decision with step, outcome, and actor", () => {
    const copy = formatActivityEvent(
      baseEvent({
        eventType: "approval_decided",
        stepName: "Budget Approval",
        approvalOutcomeLabel: "Approved",
        actorLabel: "sarah@example.com",
        processRunId: "run-1",
      }),
    );

    expect(copy.title).toBe("Budget Approval approved by sarah@example.com");
    expect(copy.href).toBe("/process-runs/run-1");
  });

  it("renders an approval decision without an actor label gracefully", () => {
    const copy = formatActivityEvent(
      baseEvent({
        eventType: "approval_decided",
        stepName: "Budget Approval",
        approvalOutcomeLabel: "Rejected",
        actorLabel: undefined,
      }),
    );

    expect(copy.title).toBe("Budget Approval rejected");
  });

  it("never reduces an approval decision to a generic completion phrase", () => {
    const copy = formatActivityEvent(
      baseEvent({
        eventType: "approval_decided",
        stepName: "Budget Approval",
        approvalOutcomeLabel: "Needs Revision",
        actorLabel: "sarah@example.com",
      }),
    );

    expect(copy.title).toContain("needs revision");
    expect(copy.title).not.toContain("completed");
  });
});
