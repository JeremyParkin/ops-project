import { createHmac, randomBytes } from "node:crypto";

// 32 random bytes, hex-encoded -- generated here (Node's CSPRNG) rather than
// in Postgres, since this project has never depended on pgcrypto's
// gen_random_bytes and there's no reason to start purely to mint a secret.
export function generateWebhookSigningSecret(): string {
  return randomBytes(32).toString("hex");
}

export function webhookSecretPreview(secret: string): string {
  return secret.slice(-4);
}

// Stripe-style timestamp.body signing: the signature covers the delivery
// timestamp as well as the payload, not just the payload alone, so a
// captured request can't be replayed indefinitely (the receiver is expected
// to reject a signature whose timestamp is too old) and a payload can't be
// silently substituted onto an old timestamp either.
export function computeWebhookSignature({
  secret,
  timestamp,
  body,
}: {
  secret: string;
  timestamp: number;
  body: string;
}): string {
  const signedPayload = `${timestamp}.${body}`;
  const digest = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `sha256=${digest}`;
}
