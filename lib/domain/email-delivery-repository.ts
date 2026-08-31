import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { EmailDeliveryOutcome, PreparedWorkspaceInvitationEmailDelivery } from "./email-dispatch";

type SupabaseRpcClient = Pick<SupabaseClient, "rpc">;

export type OutboundEmailDeliveryLogEntry = {
  id: string;
  purpose: "workspace_invitation";
  recipientEmail: string;
  status: "pending" | "accepted" | "failed" | "superseded";
  attempts: number;
  nextAttemptAt: string;
  lastAttemptedAt: string | null;
  lastResponseStatus: number | null;
  lastFailureSummary: string | null;
  provider: "resend";
  providerMessageId: string | null;
  createdAt: string;
  acceptedAt: string | null;
  failedAt: string | null;
  supersededAt: string | null;
};

type DeliveryLogRow = {
  id: string;
  purpose: "workspace_invitation";
  recipient_email: string;
  status: "pending" | "accepted" | "failed" | "superseded";
  attempts: number;
  next_attempt_at: string;
  last_attempted_at: string | null;
  last_response_status: number | null;
  last_failure_summary: string | null;
  provider: "resend";
  provider_message_id: string | null;
  created_at: string;
  accepted_at: string | null;
  failed_at: string | null;
  superseded_at: string | null;
};

type ClaimedDeliveryRow = {
  delivery_id: string;
};

type PreparedDeliveryRow = {
  delivery_id: string;
  workspace_id: string;
  invitation_id: string;
  invitation_token: string;
  recipient_email: string;
  workspace_name: string;
  role_name: string;
  expires_at: string;
};

export async function listOutboundEmailDeliveries({
  workspaceId,
  limit = 50,
}: {
  workspaceId: string;
  limit?: number;
}): Promise<OutboundEmailDeliveryLogEntry[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_outbound_email_deliveries_authorized", {
    p_workspace_id: workspaceId,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as DeliveryLogRow[]).map((row) => ({
    id: row.id,
    purpose: row.purpose,
    recipientEmail: row.recipient_email,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptedAt: row.last_attempted_at,
    lastResponseStatus: row.last_response_status,
    lastFailureSummary: row.last_failure_summary,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    failedAt: row.failed_at,
    supersededAt: row.superseded_at,
  }));
}

export async function claimDueOutboundEmailDeliveryIds({
  supabase,
  limit = 25,
}: {
  supabase: SupabaseRpcClient;
  limit?: number;
}): Promise<string[]> {
  const { data, error } = await supabase.rpc("claim_due_outbound_email_deliveries_system", {
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ClaimedDeliveryRow[]).map((row) => row.delivery_id);
}

export async function prepareWorkspaceInvitationEmailDelivery({
  supabase,
  deliveryId,
}: {
  supabase: SupabaseRpcClient;
  deliveryId: string;
}): Promise<PreparedWorkspaceInvitationEmailDelivery | null> {
  const { data, error } = await supabase.rpc("prepare_workspace_invitation_email_delivery_system", {
    p_delivery_id: deliveryId,
  });
  if (error) throw new Error(error.message);

  const row = ((data ?? []) as PreparedDeliveryRow[])[0];
  if (!row) return null;

  return {
    deliveryId: row.delivery_id,
    workspaceId: row.workspace_id,
    invitationId: row.invitation_id,
    invitationToken: row.invitation_token,
    recipientEmail: row.recipient_email,
    workspaceName: row.workspace_name,
    roleName: row.role_name,
    expiresAt: row.expires_at,
  };
}

export async function recordOutboundEmailDeliveryAttempt({
  supabase,
  deliveryId,
  outcome,
}: {
  supabase: SupabaseRpcClient;
  deliveryId: string;
  outcome: EmailDeliveryOutcome;
}): Promise<void> {
  const { error } = await supabase.rpc("record_outbound_email_delivery_attempt_system", {
    p_delivery_id: deliveryId,
    p_accepted: outcome.accepted,
    p_response_status: outcome.responseStatus,
    p_failure_summary: outcome.failureSummary,
    p_retryable: outcome.retryable,
    p_retry_after_seconds: outcome.retryAfterSeconds,
    p_provider_message_id: outcome.providerMessageId,
  });
  if (error) throw new Error(error.message);
}
