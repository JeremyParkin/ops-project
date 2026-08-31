import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { hasValidSchedulerSecret } from "@/lib/scheduler-auth";
import {
  claimDueOutboundEmailDeliveryIds,
  prepareWorkspaceInvitationEmailDelivery,
  recordOutboundEmailDeliveryAttempt,
} from "@/lib/domain/email-delivery-repository";
import {
  emailProviderNotConfiguredOutcome,
  getEmailProviderConfig,
  sendWorkspaceInvitationEmail,
} from "@/lib/domain/email-dispatch";

export const dynamic = "force-dynamic";

const CLAIM_LIMIT = 25;

// One invocation claims a bounded batch of due outbound email deliveries,
// asks the database to perform the canonical final pre-send check for each
// delivery id, sends only still-current workspace invitations, and records
// whether Resend accepted the request. "Accepted" is provider acceptance, not
// recipient delivery. A concurrent resend can still happen after the final
// check and before/during the provider request; the old token is invalid after
// rotation, so V1 treats that as a narrow UX race rather than an auth leak.
export async function POST(request: Request) {
  if (!hasValidSchedulerSecret(request, "EMAIL_DISPATCH_SCHEDULER_SECRET")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminSupabaseClient();
  let claimedDeliveryIds: string[];
  try {
    claimedDeliveryIds = await claimDueOutboundEmailDeliveryIds({ supabase, limit: CLAIM_LIMIT });
  } catch (error) {
    console.error("Unable to claim due outbound email deliveries", error);
    return NextResponse.json({ error: "Unable to claim due outbound email deliveries" }, { status: 500 });
  }

  const config = getEmailProviderConfig();
  const results = await Promise.allSettled(
    claimedDeliveryIds.map(async (deliveryId) => {
      const delivery = await prepareWorkspaceInvitationEmailDelivery({ supabase, deliveryId });
      if (!delivery) return { attempted: false, accepted: false };

      const outcome = config
        ? await sendWorkspaceInvitationEmail({ delivery, config })
        : emailProviderNotConfiguredOutcome();
      await recordOutboundEmailDeliveryAttempt({ supabase, deliveryId, outcome });
      return { attempted: true, accepted: outcome.accepted };
    }),
  );

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const attempted = fulfilled.filter((result) => result.value.attempted).length;
  const acceptedByProvider = fulfilled.filter((result) => result.value.accepted).length;
  const skipped = fulfilled.filter((result) => !result.value.attempted).length;
  const failedToProcess = results.length - fulfilled.length;

  if (failedToProcess > 0) {
    console.error(`Unable to process ${failedToProcess} outbound email delivery attempt(s)`);
  }

  return NextResponse.json({
    result: {
      claimed: claimedDeliveryIds.length,
      attempted,
      acceptedByProvider,
      skipped,
      failedToProcess,
    },
  });
}
