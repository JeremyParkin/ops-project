import { createServerSupabaseClient } from "@/lib/supabase/server";
import { webhookEventTypes, type WebhookEventType } from "./webhook-events";

export type WebhookSubscription = {
  id: string;
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  active: boolean;
  secretPreview: string;
  createdAt: string;
};

type WebhookSubscriptionRow = {
  id: string;
  name: string;
  url: string;
  event_types: string[];
  active: boolean;
  secret_preview: string;
  created_at: string;
};

function toWebhookSubscription(row: WebhookSubscriptionRow): WebhookSubscription {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    eventTypes: row.event_types.filter((eventType): eventType is WebhookEventType =>
      (webhookEventTypes as readonly string[]).includes(eventType),
    ),
    active: row.active,
    secretPreview: row.secret_preview,
    createdAt: row.created_at,
  };
}

export async function listWebhookSubscriptions({ workspaceId }: { workspaceId: string }): Promise<WebhookSubscription[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_webhook_subscriptions_authorized", { p_workspace_id: workspaceId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as WebhookSubscriptionRow[]).map(toWebhookSubscription);
}

export async function createWebhookSubscription({
  workspaceId,
  name,
  url,
  eventTypes,
  signingSecret,
}: {
  workspaceId: string;
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  signingSecret: string;
}): Promise<WebhookSubscription> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_webhook_subscription_authorized", {
    p_workspace_id: workspaceId,
    p_name: name,
    p_url: url,
    p_event_types: eventTypes,
    p_signing_secret: signingSecret,
  });
  if (error) throw new Error(error.message);
  const row = (data as WebhookSubscriptionRow[] | null)?.[0];
  if (!row) throw new Error("Webhook creation did not return a subscription.");
  return toWebhookSubscription(row);
}

export async function updateWebhookSubscription({
  workspaceId,
  subscriptionId,
  name,
  url,
  eventTypes,
  active,
}: {
  workspaceId: string;
  subscriptionId: string;
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  active: boolean;
}): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_webhook_subscription_authorized", {
    p_workspace_id: workspaceId,
    p_subscription_id: subscriptionId,
    p_name: name,
    p_url: url,
    p_event_types: eventTypes,
    p_active: active,
  });
  if (error) throw new Error(error.message);
}

export async function regenerateWebhookSubscriptionSecret({
  workspaceId,
  subscriptionId,
  signingSecret,
}: {
  workspaceId: string;
  subscriptionId: string;
  signingSecret: string;
}): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("regenerate_webhook_subscription_secret_authorized", {
    p_workspace_id: workspaceId,
    p_subscription_id: subscriptionId,
    p_signing_secret: signingSecret,
  });
  if (error) throw new Error(error.message);
}

export type WebhookDelivery = {
  id: string;
  eventType: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt: string;
  lastAttemptedAt: string | null;
  lastResponseStatus: number | null;
  lastFailureSummary: string | null;
  createdAt: string;
};

type WebhookDeliveryRow = {
  id: string;
  event_type: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_attempted_at: string | null;
  last_response_status: number | null;
  last_failure_summary: string | null;
  created_at: string;
};

export async function listWebhookDeliveries({
  workspaceId,
  subscriptionId,
  limit = 50,
}: {
  workspaceId: string;
  subscriptionId: string;
  limit?: number;
}): Promise<WebhookDelivery[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_webhook_deliveries_authorized", {
    p_workspace_id: workspaceId,
    p_subscription_id: subscriptionId,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as WebhookDeliveryRow[]).map((row) => ({
    id: row.id,
    eventType: row.event_type,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptedAt: row.last_attempted_at,
    lastResponseStatus: row.last_response_status,
    lastFailureSummary: row.last_failure_summary,
    createdAt: row.created_at,
  }));
}
