import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  executeActiveProcessActionSteps,
  listActiveProcessActionStepRuns,
} from "@/lib/domain/process-repository";

export const dynamic = "force-dynamic";

function hasValidSchedulerSecret(request: Request) {
  const secret = process.env.PROCESS_WAIT_SCHEDULER_SECRET;
  const authorization = request.headers.get("authorization");
  const received = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (!secret || !received) return false;

  const expectedBuffer = Buffer.from(secret);
  const receivedBuffer = Buffer.from(received);

  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

// One invocation of this route does four things, strictly in this order,
// each independently bounded/isolated so a problem in one never blocks the
// others:
//   1. Resume due timer waits (resume_due_process_waits_system, limit 100).
//   2. Dispatch due condition-wait wakeups (dispatch_process_condition_wait_
//      wakeups_system, limit 100). 1 and 2 run concurrently -- they touch
//      disjoint step runs, so there's no ordering dependency between them.
//   3. Discover and start due recurrence occurrences (discover_and_start_
//      recurrence_occurrences_system, limit 100) -- runs after 1/2, not
//      concurrently with them: this step creates entirely new ProcessRuns,
//      as opposed to resuming existing ones, and keeping it last means a
//      recurrence-started run's own first-step activation (including a
//      possible immediate action node) is guaranteed to exist by the time
//      step 4 drains it.
//   4. Drain any action nodes that 1, 2, or 3 activated but left active-and-
//      uncascaded (see private.activate_process_step_run) -- runs last for
//      exactly that reason.
// Each of the four RPCs is independently `FOR UPDATE SKIP LOCKED` with a
// bounded batch and per-row/per-rule exception isolation, so a duplicate or
// overlapping invocation of this whole route is always safe: every row a
// second invocation would touch either already changed state (recheck fails
// harmlessly) or is already locked by the first invocation (skipped, not
// blocked). Actual invocation frequency is a deployment-time decision not
// committed anywhere in this repo (no cron config exists yet) -- recurrence
// and reminder timeliness are bounded by whatever cadence gets configured.
export async function POST(request: Request) {
  if (!hasValidSchedulerSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminSupabaseClient();
  const [{ data: timerData, error: timerError }, { data: conditionData, error: conditionError }] =
    await Promise.all([
      supabase.rpc("resume_due_process_waits_system", { p_limit: 100 }),
      supabase.rpc("dispatch_process_condition_wait_wakeups_system", { p_limit: 100 }),
    ]);

  if (timerError || conditionError) {
    console.error("Unable to dispatch process waits", timerError ?? conditionError);
    return NextResponse.json({ error: "Unable to dispatch process waits" }, { status: 500 });
  }

  const { data: recurrenceData, error: recurrenceError } = await supabase.rpc(
    "discover_and_start_recurrence_occurrences_system",
    { p_limit: 100 },
  );

  if (recurrenceError) {
    console.error("Unable to start due recurrence occurrences", recurrenceError);
    return NextResponse.json({ error: "Unable to start due recurrence occurrences" }, { status: 500 });
  }

  // A resumed wait, dispatched condition wait, or newly-started recurrence
  // run may have activated a downstream action node -- the SQL cascade
  // above deliberately leaves it active-and-uncascaded (see private.
  // activate_process_step_run). Drain it through the same canonical
  // executor an interactive retry uses, just under this route's own admin
  // client instead of a user session: identity only in, never action
  // config, and the discovery query below only ever returns which step
  // runs to execute, never performs a mutation itself.
  let actionExecutionError: string | undefined;

  try {
    const pendingRuns = await listActiveProcessActionStepRuns({ supabase });

    for (const { workspaceId, processRunId } of pendingRuns) {
      await executeActiveProcessActionSteps({ workspaceId, processRunId, supabase });
    }
  } catch (error) {
    actionExecutionError = error instanceof Error ? error.message : "Unknown action execution error.";
    console.error("Unable to drain scheduler-activated action steps", error);
  }

  return NextResponse.json({
    result: {
      ...(timerData ?? { resumed: 0, skipped: 0, failed: 0 }),
      conditions: conditionData ?? { processed: 0, resolved: 0, failed: 0 },
      recurrence: recurrenceData ?? { started: 0, failed: 0 },
      ...(actionExecutionError ? { actionExecutionError } : {}),
    },
  });
}
