"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspaceId, requireWorkspaceCapability } from "@/lib/auth/workspace";
import { isWebhookEventType, type WebhookEventType } from "@/lib/domain/webhook-events";
import { generateWebhookSigningSecret } from "@/lib/domain/webhook-signing";
import { assertPublicHttpsWebhookUrl, UnsafeWebhookUrlError } from "@/lib/domain/webhook-url-safety";
import {
  createWebhookSubscription,
  regenerateWebhookSubscriptionSecret,
  updateWebhookSubscription,
} from "@/lib/domain/webhook-repository";

export type WebhookActionState = { success: boolean; message: string; secret?: string };

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getEventTypes(formData: FormData): WebhookEventType[] | null {
  const values = formData.getAll("eventType");
  if (values.length === 0 || !values.every((value) => typeof value === "string" && isWebhookEventType(value))) {
    return null;
  }
  return [...new Set(values as WebhookEventType[])];
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof UnsafeWebhookUrlError) return error.message;
  if (error instanceof Error) {
    const separator = error.message.indexOf(": ");
    return separator >= 0 ? error.message.slice(separator + 2) : error.message;
  }
  return fallback;
}

async function activeIntegrationsWorkspace() {
  const { workspaceId } = await getActiveWorkspaceId();
  await requireWorkspaceCapability(workspaceId, "workspace.manage_integrations");
  return workspaceId;
}

export async function createWebhookSubscriptionAction(
  _previousState: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  const name = getText(formData, "name");
  const url = getText(formData, "url");
  const eventTypes = getEventTypes(formData);
  if (!name || !url || !eventTypes) {
    return { success: false, message: "Enter a name, a URL, and choose at least one event type." };
  }

  try {
    const workspaceId = await activeIntegrationsWorkspace();
    await assertPublicHttpsWebhookUrl(url);
    const signingSecret = generateWebhookSigningSecret();
    await createWebhookSubscription({ workspaceId, name, url, eventTypes, signingSecret });
    revalidatePath("/settings/webhooks");
    return { success: true, message: "Webhook created. Copy the signing secret now -- it will not be shown again.", secret: signingSecret };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to create the webhook.") };
  }
}

export async function updateWebhookSubscriptionAction(
  _previousState: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  const subscriptionId = getText(formData, "subscriptionId");
  const name = getText(formData, "name");
  const url = getText(formData, "url");
  const eventTypes = getEventTypes(formData);
  const active = formData.get("active") === "on";
  if (!subscriptionId || !name || !url || !eventTypes) {
    return { success: false, message: "Enter a name, a URL, and choose at least one event type." };
  }

  try {
    const workspaceId = await activeIntegrationsWorkspace();
    await assertPublicHttpsWebhookUrl(url);
    await updateWebhookSubscription({ workspaceId, subscriptionId, name, url, eventTypes, active });
    revalidatePath("/settings/webhooks");
    return { success: true, message: "Webhook updated." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the webhook.") };
  }
}

export async function regenerateWebhookSubscriptionSecretAction(
  _previousState: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  const subscriptionId = getText(formData, "subscriptionId");
  if (!subscriptionId) return { success: false, message: "Choose a webhook." };

  try {
    const workspaceId = await activeIntegrationsWorkspace();
    const signingSecret = generateWebhookSigningSecret();
    await regenerateWebhookSubscriptionSecret({ workspaceId, subscriptionId, signingSecret });
    revalidatePath("/settings/webhooks");
    return {
      success: true,
      message:
        "Secret regenerated. Copy it now -- it will not be shown again. Any delivery still retrying will sign with this new secret from its next attempt on.",
      secret: signingSecret,
    };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to regenerate the secret.") };
  }
}
