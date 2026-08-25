import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

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

  return NextResponse.json({
    result: {
      ...(timerData ?? { resumed: 0, skipped: 0, failed: 0 }),
      conditions: conditionData ?? { processed: 0, resolved: 0, failed: 0 },
    },
  });
}
