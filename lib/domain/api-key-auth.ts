import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { hashApiKey } from "./api-key-signing";

export type ApiErrorCode =
  | "invalid_api_key"
  | "rate_limited"
  | "insufficient_scope"
  | "invalid_limit"
  | "invalid_cursor"
  | "invalid_idempotency_key"
  | "not_found"
  | "conflict"
  | "internal_error";

export class ApiKeyAuthError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ApiKeyRequestContext = {
  keyHash: string;
  workspaceId: string;
  keyId: string;
  scopes: string[];
};

type RateLimitRow = { key_id: string; workspace_id: string; scopes: string[]; allowed: boolean };

// The one call every /api/v1 request makes before touching any data:
// resolves + rate-limits the key in a single, separately-transacted RPC
// (check_api_key_rate_limit_for_api_key, migration 0074) that always
// commits its last_used_at/rate-counter mutation, whether or not the
// caller is over limit -- see that migration's header for why this can't
// be one RPC with the data read. Never falls back to cookie/session auth:
// this only ever calls the service-role admin client with a hashed bearer
// key, nothing derived from request cookies.
export async function authenticateApiRequest(request: Request): Promise<ApiKeyRequestContext> {
  const authorization = request.headers.get("authorization");
  const rawKey = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";

  if (!rawKey) {
    throw new ApiKeyAuthError(401, "invalid_api_key", "Missing or malformed Authorization header.");
  }

  const keyHash = hashApiKey(rawKey);
  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase.rpc("check_api_key_rate_limit_for_api_key", { p_key_hash: keyHash });

  if (error) {
    if (error.message.includes("invalid_api_key")) {
      throw new ApiKeyAuthError(401, "invalid_api_key", "Invalid or revoked API key.");
    }
    throw new ApiKeyAuthError(500, "internal_error", "Unable to authenticate the request.");
  }

  const row = (data as RateLimitRow[] | null)?.[0];
  if (!row) {
    throw new ApiKeyAuthError(500, "internal_error", "Unable to authenticate the request.");
  }
  if (!row.allowed) {
    throw new ApiKeyAuthError(429, "rate_limited", "Rate limit exceeded. Try again shortly.");
  }

  return { keyHash, workspaceId: row.workspace_id, keyId: row.key_id, scopes: row.scopes };
}

// Maps an error from one of the four data-serving RPCs. Each independently
// re-derives its workspace from the key hash (private.resolve_api_key_
// workspace), so "invalid_api_key" can in principle recur here even though
// authenticateApiRequest already checked it once -- e.g. the key was
// revoked in the gap between the two calls. That's correct, not redundant:
// the data RPC's own authorization does not trust the earlier call.
export function mapApiDataError(error: { message: string }): ApiKeyAuthError {
  if (error.message.includes("invalid_api_key")) {
    return new ApiKeyAuthError(401, "invalid_api_key", "Invalid or revoked API key.");
  }
  if (error.message.includes("insufficient_scope")) {
    return new ApiKeyAuthError(403, "insufficient_scope", "This API key does not have the required scope.");
  }
  if (error.message.includes("invalid_limit")) {
    return new ApiKeyAuthError(400, "invalid_limit", "limit must be an integer between 1 and 200.");
  }
  return new ApiKeyAuthError(500, "internal_error", "Unexpected error.");
}

// Every /api/v1 response carries this workspace data behind a bearer key --
// an intermediate cache or proxy that ignored the Authorization header
// could otherwise serve one caller's response to a different caller hitting
// the same URL. Applied to success responses and error responses alike, not
// just the happy path.
const NO_STORE_HEADERS: HeadersInit = { "Cache-Control": "private, no-store" };

export function apiJsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiKeyAuthError) {
    const headers: HeadersInit = {
      ...NO_STORE_HEADERS,
      ...(error.code === "rate_limited" ? { "Retry-After": "60" } : {}),
    };
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
  }
  console.error("Unexpected /api/v1 error", error);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Unexpected error." } },
    { status: 500, headers: NO_STORE_HEADERS },
  );
}

export function notFoundResponse(message = "Not found."): NextResponse {
  return NextResponse.json({ error: { code: "not_found", message } }, { status: 404, headers: NO_STORE_HEADERS });
}

export function parseLimitParam(searchParams: URLSearchParams): number {
  const raw = searchParams.get("limit");
  if (!raw) return 50;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new ApiKeyAuthError(400, "invalid_limit", "limit must be an integer between 1 and 200.");
  }
  return parsed;
}
