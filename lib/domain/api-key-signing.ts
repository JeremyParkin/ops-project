import { createHash, randomBytes } from "node:crypto";

// A recognizable prefix (helps humans/secret-scanners recognize a Kinema
// key at a glance) plus 32 random bytes from Node's CSPRNG, hex-encoded --
// the same entropy/generation approach as 8F.2's webhook signing secrets.
const KEY_PREFIX = "kinema_live_";

export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("hex")}`;
}

// SHA-256, not bcrypt/argon2 -- this is a 256-bit random secret, not a
// low-entropy human password, so a fast hash is both correct practice and
// necessary for a practical indexed equality lookup at request time (the
// same reasoning applies here as it does for GitHub PATs/Stripe restricted
// keys). The raw key is never stored; only this hash is.
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function apiKeyPreview(rawKey: string): string {
  return rawKey.slice(-4);
}
