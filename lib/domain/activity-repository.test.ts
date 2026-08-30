import { describe, expect, it } from "vitest";
import { compareNewestFirstWithStableTies } from "./activity-repository";
import type { RecordActivityEvent } from "./activity-types";

function event(overrides: Partial<RecordActivityEvent>): RecordActivityEvent {
  return {
    id: "id",
    eventType: "process_started",
    createdAt: "2026-08-30T09:00:00.000Z",
    isRecurrenceStarted: false,
    ...overrides,
  };
}

describe("compareNewestFirstWithStableTies", () => {
  it("orders strictly by createdAt when timestamps differ", () => {
    const earlier = event({ id: "a", createdAt: "2026-08-30T09:00:00.000Z" });
    const later = event({ id: "b", createdAt: "2026-08-30T09:05:00.000Z" });

    expect([earlier, later].sort(compareNewestFirstWithStableTies)).toEqual([later, earlier]);
  });

  it("breaks a same-instant tie -- assignment reads newer than the run start it followed", () => {
    const started = event({ id: "a", eventType: "process_started", createdAt: "2026-08-30T09:00:00.000Z" });
    const assigned = event({ id: "b", eventType: "step_assigned", createdAt: "2026-08-30T09:00:00.000Z" });

    expect([started, assigned].sort(compareNewestFirstWithStableTies)).toEqual([assigned, started]);
    // Order of the input array must not matter -- this is what "undefined
    // tie order" actually looks like without a stable comparator.
    expect([assigned, started].sort(compareNewestFirstWithStableTies)).toEqual([assigned, started]);
  });

  it("breaks a same-instant tie -- the next step's assignment reads newer than the approval decision that activated it", () => {
    // decide_process_approval_authorized_member inserts approval_decided,
    // then (same transaction) activates the target step, which -- if it's
    // itself a human_task/approval -- inserts step_assigned. The decision
    // is the trigger; the assignment is its direct consequence, so it must
    // render as more recent even though both share one `created_at`. This
    // was the actual bug caught during 8D.3 dogfood (an earlier version of
    // this comparator ranked approval_decided above step_assigned
    // unconditionally, inverting this specific pair).
    const decided = event({ id: "a", eventType: "approval_decided", createdAt: "2026-08-30T09:00:00.000Z" });
    const assigned = event({ id: "b", eventType: "step_assigned", createdAt: "2026-08-30T09:00:00.000Z" });

    expect([decided, assigned].sort(compareNewestFirstWithStableTies)).toEqual([assigned, decided]);
  });

  it("breaks a same-instant tie -- a run completing synchronously after a decision reads newer than the decision", () => {
    const decided = event({ id: "a", eventType: "approval_decided", createdAt: "2026-08-30T09:00:00.000Z" });
    const completed = event({ id: "b", eventType: "process_completed", createdAt: "2026-08-30T09:00:00.000Z" });

    expect([decided, completed].sort(compareNewestFirstWithStableTies)).toEqual([completed, decided]);
  });
});
