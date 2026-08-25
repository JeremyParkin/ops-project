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
  const { data, error } = await supabase.rpc("resume_due_process_waits_system", { p_limit: 100 });

  if (error) {
    console.error("Unable to resume due process waits", error);
    return NextResponse.json({ error: "Unable to resume due waits" }, { status: 500 });
  }

  return NextResponse.json({ result: data ?? { resumed: 0, skipped: 0, failed: 0 } });
}
