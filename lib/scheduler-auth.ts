import { timingSafeEqual } from "node:crypto";

// Shared bearer-secret check for internal scheduler-invoked routes
// (process-waits, webhook-deliveries). Each route reads its own env var --
// this is a shared helper, not a shared secret, so the two routes stay
// independently rotatable.
export function hasValidSchedulerSecret(request: Request, envVarName: string): boolean {
  const secret = process.env[envVarName];
  const authorization = request.headers.get("authorization");
  const received = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (!secret || !received) return false;

  const expectedBuffer = Buffer.from(secret);
  const receivedBuffer = Buffer.from(received);

  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}
