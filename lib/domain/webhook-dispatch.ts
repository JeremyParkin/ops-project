import { assertPublicHttpsWebhookUrl } from "./webhook-url-safety";
import { buildWebhookPayload, type WebhookDeliveryEventRow } from "./webhook-payload";
import { computeWebhookSignature } from "./webhook-signing";

// Pure classification of one delivery attempt's outcome, kept separate from
// the actual fetch call so the retry/terminal policy is unit-testable
// without a real network request. Approved policy: retry transport errors,
// timeouts, 429, and 5xx; treat any other non-2xx response (including a 3xx
// -- outbound redirects are never followed, so a 3xx here means the
// receiver tried to redirect us and we refused) as a terminal, non-retryable
// failure.
export type WebhookDeliveryOutcome = {
  success: boolean;
  retryable: boolean;
  responseStatus: number | null;
  failureSummary: string | null;
};

const MAX_FAILURE_SUMMARY_LENGTH = 500;

function truncate(message: string): string {
  return message.length > MAX_FAILURE_SUMMARY_LENGTH ? `${message.slice(0, MAX_FAILURE_SUMMARY_LENGTH)}…` : message;
}

export function classifyWebhookResponse(status: number): WebhookDeliveryOutcome {
  if (status >= 200 && status < 300) {
    return { success: true, retryable: false, responseStatus: status, failureSummary: null };
  }
  if (status === 429 || status >= 500) {
    return {
      success: false,
      retryable: true,
      responseStatus: status,
      failureSummary: truncate(`Received HTTP ${status}`),
    };
  }
  return {
    success: false,
    retryable: false,
    responseStatus: status,
    failureSummary: truncate(`Received HTTP ${status}`),
  };
}

export function classifyWebhookTransportError(error: unknown): WebhookDeliveryOutcome {
  const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    retryable: true,
    responseStatus: null,
    failureSummary: truncate(isTimeout ? "Request timed out" : message),
  };
}

export type ClaimedWebhookDelivery = WebhookDeliveryEventRow & { signingSecret: string; url: string };

const DELIVERY_TIMEOUT_MS = 10_000;

// The one impure piece: performs the real outbound HTTP call. Not unit
// tested directly -- everything it does beyond the fetch call itself
// (URL safety, payload shape, signing, response classification) is already
// covered by pure tests in webhook-url-safety/webhook-payload/webhook-
// signing/this file's own classify* functions; this function is thin
// orchestration over those, exercised by dogfood against a real receiver.
// Re-validates the destination immediately before every attempt (not just
// once at subscription creation) -- DNS can change in the gap between an
// earlier attempt's backoff and this one.
export async function deliverClaimedWebhookDelivery(claimed: ClaimedWebhookDelivery): Promise<WebhookDeliveryOutcome> {
  let url: URL;
  try {
    url = await assertPublicHttpsWebhookUrl(claimed.url);
  } catch (error) {
    return {
      success: false,
      retryable: false,
      responseStatus: null,
      failureSummary:
        error instanceof Error ? truncate(error.message) : "Destination is no longer a safe delivery target.",
    };
  }

  const payload = buildWebhookPayload(claimed);
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeWebhookSignature({ secret: claimed.signingSecret, timestamp, body });

  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-kinema-signature": signature,
        "x-kinema-timestamp": String(timestamp),
        "x-kinema-delivery-id": claimed.deliveryId,
        "x-kinema-event-type": claimed.eventType,
      },
      body,
    });
    return classifyWebhookResponse(response.status);
  } catch (error) {
    return classifyWebhookTransportError(error);
  }
}
