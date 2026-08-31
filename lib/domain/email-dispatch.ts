export type PreparedWorkspaceInvitationEmailDelivery = {
  deliveryId: string;
  workspaceId: string;
  invitationId: string;
  invitationToken: string;
  recipientEmail: string;
  workspaceName: string;
  roleName: string;
  expiresAt: string;
};

export type EmailProviderConfig = {
  apiKey: string;
  from: string;
  replyTo?: string;
  appUrl: string;
};

export type EmailDeliveryOutcome = {
  accepted: boolean;
  retryable: boolean;
  responseStatus: number | null;
  failureSummary: string | null;
  retryAfterSeconds: number | null;
  providerMessageId: string | null;
};

const MAX_FAILURE_SUMMARY_LENGTH = 500;
const RESEND_SEND_URL = "https://api.resend.com/emails";
const DELIVERY_TIMEOUT_MS = 10_000;

function truncate(message: string): string {
  return message.length > MAX_FAILURE_SUMMARY_LENGTH ? `${message.slice(0, MAX_FAILURE_SUMMARY_LENGTH)}...` : message;
}

function normalizeAppUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getEmailProviderConfig(): EmailProviderConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  const appUrl = process.env.KINEMA_PUBLIC_APP_URL?.trim();

  if (!apiKey || !from || !appUrl) return null;

  const replyTo = process.env.EMAIL_REPLY_TO?.trim();
  return { apiKey, from, ...(replyTo ? { replyTo } : {}), appUrl: normalizeAppUrl(appUrl) };
}

export function isEmailProviderConfigured(): boolean {
  return getEmailProviderConfig() !== null;
}

export function providerIdempotencyKeyForDelivery(deliveryId: string): string {
  return `kinema-email/${deliveryId}`;
}

export function invitationUrlForToken({ appUrl, token }: { appUrl: string; token: string }): string {
  return `${normalizeAppUrl(appUrl)}/accept-invitation?token=${encodeURIComponent(token)}`;
}

export function renderWorkspaceInvitationEmail({
  delivery,
  appUrl,
}: {
  delivery: PreparedWorkspaceInvitationEmailDelivery;
  appUrl: string;
}): { subject: string; text: string; html: string } {
  const invitationUrl = invitationUrlForToken({ appUrl, token: delivery.invitationToken });
  const expiresAt = new Date(delivery.expiresAt).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const subject = `You're invited to ${delivery.workspaceName} on Kinema`;
  const text = [
    `You have been invited to join ${delivery.workspaceName} on Kinema as ${delivery.roleName}.`,
    "",
    `Accept the invitation: ${invitationUrl}`,
    "",
    `This invitation expires on ${expiresAt}.`,
  ].join("\n");
  const html = [
    `<p>You have been invited to join <strong>${escapeHtml(delivery.workspaceName)}</strong> on Kinema as ${escapeHtml(delivery.roleName)}.</p>`,
    `<p><a href="${escapeHtml(invitationUrl)}">Accept the invitation</a></p>`,
    `<p>This invitation expires on ${escapeHtml(expiresAt)}.</p>`,
  ].join("");

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds);
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;

  const deltaSeconds = Math.ceil((dateMs - Date.now()) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : null;
}

function extractResendErrorType(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as { name?: unknown; error?: { name?: unknown; type?: unknown }; type?: unknown };
    const type = parsed.error?.type ?? parsed.error?.name ?? parsed.type ?? parsed.name;
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  }
}

function extractResendMessageId(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as { id?: unknown; data?: { id?: unknown } };
    const id = parsed.id ?? parsed.data?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function classifyResendResponse({
  status,
  bodyText = "",
  retryAfterHeader = null,
}: {
  status: number;
  bodyText?: string;
  retryAfterHeader?: string | null;
}): EmailDeliveryOutcome {
  if (status >= 200 && status < 300) {
    return {
      accepted: true,
      retryable: false,
      responseStatus: status,
      failureSummary: null,
      retryAfterSeconds: null,
      providerMessageId: extractResendMessageId(bodyText),
    };
  }

  const errorType = extractResendErrorType(bodyText);
  const retryable =
    status === 429 ||
    status >= 500 ||
    (status === 409 && errorType === "concurrent_idempotent_requests");

  return {
    accepted: false,
    retryable,
    responseStatus: status,
    failureSummary: truncate(errorType ? `Received HTTP ${status}: ${errorType}` : `Received HTTP ${status}`),
    retryAfterSeconds: status === 429 ? parseRetryAfter(retryAfterHeader) : null,
    providerMessageId: null,
  };
}

export function classifyEmailTransportError(error: unknown): EmailDeliveryOutcome {
  const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const message = error instanceof Error ? error.message : String(error);
  return {
    accepted: false,
    retryable: true,
    responseStatus: null,
    failureSummary: truncate(isTimeout ? "Request timed out" : message),
    retryAfterSeconds: null,
    providerMessageId: null,
  };
}

export function emailProviderNotConfiguredOutcome(): EmailDeliveryOutcome {
  return {
    accepted: false,
    retryable: false,
    responseStatus: null,
    failureSummary: "Outbound email provider is not configured.",
    retryAfterSeconds: null,
    providerMessageId: null,
  };
}

export async function sendWorkspaceInvitationEmail({
  delivery,
  config,
}: {
  delivery: PreparedWorkspaceInvitationEmailDelivery;
  config: EmailProviderConfig;
}): Promise<EmailDeliveryOutcome> {
  const rendered = renderWorkspaceInvitationEmail({ delivery, appUrl: config.appUrl });
  const body = JSON.stringify({
    from: config.from,
    to: [delivery.recipientEmail],
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    ...(config.replyTo ? { reply_to: [config.replyTo] } : {}),
  });

  try {
    const response = await fetch(RESEND_SEND_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": providerIdempotencyKeyForDelivery(delivery.deliveryId),
      },
      body,
    });
    const bodyText = await response.text();
    return classifyResendResponse({
      status: response.status,
      bodyText,
      retryAfterHeader: response.headers.get("retry-after"),
    });
  } catch (error) {
    return classifyEmailTransportError(error);
  }
}
