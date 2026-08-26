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

  // A resumed wait or dispatched condition wait may have activated a
  // downstream action node -- the SQL cascade above deliberately leaves it
  // active-and-uncascaded (see private.activate_process_step_run). Drain it
  // through the same canonical executor an interactive retry uses, just
  // under this route's own admin client instead of a user session: identity
  // only in, never action config, and the discovery query below only ever
  // returns which step runs to execute, never performs a mutation itself.
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
      ...(actionExecutionError ? { actionExecutionError } : {}),
    },
  });
}
