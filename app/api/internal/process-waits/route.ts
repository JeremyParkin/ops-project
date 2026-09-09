import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { hasValidSchedulerSecret } from "@/lib/scheduler-auth";
import {
  executeActiveProcessActionSteps,
  listActiveProcessActionStepRuns,
} from "@/lib/domain/process-repository";

export const dynamic = "force-dynamic";

type NotificationGenerationResult = { created: number; failed: number; error?: string };

// Reports a due-soon/overdue generator's outcome truthfully either way: a
// resolved RPC error or a rejected promise (network-level failure) both
// still produce a visible `error` field in the response body rather than
// being folded into a silent 0/0, so a partial failure never reads as a
// fully successful invocation.
function summarizeNotificationGeneration(
  settled: PromiseSettledResult<{ data: unknown; error: { message: string } | null }>,
  label: string,
): NotificationGenerationResult {
  if (settled.status === "rejected") {
    const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    console.error(`Unable to generate ${label} notifications`, settled.reason);
    return { created: 0, failed: 0, error: message };
  }

  const { data, error } = settled.value;
  if (error) {
    console.error(`Unable to generate ${label} notifications`, error);
    return { created: 0, failed: 0, error: error.message };
  }

  const result = data as { created?: number; failed?: number } | null;
  return { created: result?.created ?? 0, failed: result?.failed ?? 0 };
}

// One invocation of this route does six things:
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
//   5/6. Generate due-soon and overdue step notifications (generate_step_
//      due_soon_notifications_system / generate_step_overdue_notifications_
//      system, limit 100 each) -- these RPCs existed fully implemented and
//      tested since migration 0064/0094 but had no application caller
//      anywhere, so due-soon/overdue notifications have never actually
//      fired outside a test. They read existing active steps' due dates
//      rather than anything 1-4 just wrote, so there's no ordering
//      dependency on those steps either; placed last simply to keep the
//      established resume/drain-first, notify-last shape. Run concurrently
//      via allSettled (not the plain Promise.all steps 1/2 use) specifically
//      so one generator's failure can never prevent the other from being
//      attempted -- unlike 1/2, which are treated as a single hard-fail
//      unit by existing design, these two are independent, best-effort
//      maintenance concerns, matching how step 4 already treats action-node
//      draining as reportable-but-non-blocking.
// Each of the six RPCs is independently `FOR UPDATE SKIP LOCKED` with a
// bounded batch and per-row/per-rule exception isolation, so a duplicate or
// overlapping invocation of this whole route is always safe: every row a
// second invocation would touch either already changed state (recheck fails
// harmlessly) or is already locked by the first invocation (skipped, not
// blocked). The due-soon/overdue RPCs additionally dedupe by
// (workspace_id, dedup_key) with `on conflict ... do nothing`, so rerunning
// never creates a duplicate notification for the same step/generation.
// Actual invocation frequency is a deployment-time decision not committed
// anywhere in this repo (no cron config exists yet) -- recurrence and
// reminder timeliness are bounded by whatever cadence gets configured.
export async function POST(request: Request) {
  if (!hasValidSchedulerSecret(request, "PROCESS_WAIT_SCHEDULER_SECRET")) {
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

  const [dueSoonSettled, overdueSettled] = await Promise.allSettled([
    supabase.rpc("generate_step_due_soon_notifications_system", { p_limit: 100 }),
    supabase.rpc("generate_step_overdue_notifications_system", { p_limit: 100 }),
  ]);

  return NextResponse.json({
    result: {
      ...(timerData ?? { resumed: 0, skipped: 0, failed: 0 }),
      conditions: conditionData ?? { processed: 0, resolved: 0, failed: 0 },
      recurrence: recurrenceData ?? { started: 0, failed: 0 },
      ...(actionExecutionError ? { actionExecutionError } : {}),
      dueSoonNotifications: summarizeNotificationGeneration(dueSoonSettled, "due-soon"),
      overdueNotifications: summarizeNotificationGeneration(overdueSettled, "overdue"),
    },
  });
}
