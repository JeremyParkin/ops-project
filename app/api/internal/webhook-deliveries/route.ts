import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { hasValidSchedulerSecret } from "@/lib/scheduler-auth";
import { deliverClaimedWebhookDelivery, type ClaimedWebhookDelivery } from "@/lib/domain/webhook-dispatch";

export const dynamic = "force-dynamic";

const CLAIM_LIMIT = 25;

type ClaimedRow = {
  delivery_id: string;
  subscription_id: string;
  url: string;
  signing_secret: string;
  attempts: number;
  event_id: string;
  event_type: string;
  event_occurred_at: string;
  workspace_id: string;
  actor_user_id: string | null;
  real_actor_user_id: string | null;
  entity_type_id: string | null;
  entity_record_id: string | null;
  process_template_id: string | null;
  process_run_id: string | null;
  process_step_run_id: string | null;
  metadata: Record<string, unknown>;
};

function toClaimedDelivery(row: ClaimedRow): ClaimedWebhookDelivery {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    eventType: row.event_type,
    eventOccurredAt: row.event_occurred_at,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    realActorUserId: row.real_actor_user_id,
    entityTypeId: row.entity_type_id,
    entityRecordId: row.entity_record_id,
    processTemplateId: row.process_template_id,
    processRunId: row.process_run_id,
    processStepRunId: row.process_step_run_id,
    metadata: row.metadata,
    url: row.url,
    signingSecret: row.signing_secret,
  };
}

// One invocation: claim a bounded batch of due deliveries (each row is
// leased for 2 minutes as part of the claim -- see claim_due_webhook_
// deliveries_system in migration 0073 -- so a crashed/timed-out invocation
// self-heals once the lease expires rather than leaving a row stuck), then
// deliver every claimed row concurrently (each with its own 10s timeout, so
// the whole batch is bounded by ~10s of wall time even in the worst case,
// not CLAIM_LIMIT x 10s sequentially), then record every outcome. A failure
// delivering or recording one row never blocks another -- Promise.allSettled,
// not Promise.all.
export async function POST(request: Request) {
  if (!hasValidSchedulerSecret(request, "WEBHOOK_DISPATCH_SCHEDULER_SECRET")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminSupabaseClient();
  const { data, error: claimError } = await supabase.rpc("claim_due_webhook_deliveries_system", {
    p_limit: CLAIM_LIMIT,
  });

  if (claimError) {
    console.error("Unable to claim due webhook deliveries", claimError);
    return NextResponse.json({ error: "Unable to claim due webhook deliveries" }, { status: 500 });
  }

  const claimed = ((data ?? []) as ClaimedRow[]).map(toClaimedDelivery);

  const results = await Promise.allSettled(
    claimed.map(async (delivery) => {
      const outcome = await deliverClaimedWebhookDelivery(delivery);
      const { error: recordError } = await supabase.rpc("record_webhook_delivery_attempt_system", {
        p_delivery_id: delivery.deliveryId,
        p_success: outcome.success,
        p_response_status: outcome.responseStatus,
        p_failure_summary: outcome.failureSummary,
        p_retryable: outcome.retryable,
      });
      if (recordError) throw new Error(recordError.message);
      return outcome.success;
    }),
  );

  const delivered = results.filter((result) => result.status === "fulfilled" && result.value).length;
  const attempted = results.filter((result) => result.status === "fulfilled").length;
  const recordingFailed = results.filter((result) => result.status === "rejected").length;

  if (recordingFailed > 0) {
    console.error(`Unable to record the outcome of ${recordingFailed} webhook delivery attempt(s)`);
  }

  return NextResponse.json({
    result: { claimed: claimed.length, attempted, delivered, recordingFailed },
  });
}
