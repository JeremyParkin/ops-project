import { createHash } from "node:crypto";
import { apiErrorResponse, apiJsonResponse, authenticateApiRequest, ApiKeyAuthError } from "@/lib/domain/api-key-auth";
import {
  ExternalProcessWaitEventError,
  receiveExternalProcessWaitEvent,
} from "@/lib/domain/process-repository";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mapExternalWaitError(error: ExternalProcessWaitEventError) {
  if (error.code === "invalid_idempotency_key") {
    return new ApiKeyAuthError(400, "invalid_idempotency_key", "Idempotency-Key is required.");
  }
  if (error.code === "insufficient_scope") {
    return new ApiKeyAuthError(403, "insufficient_scope", error.message);
  }
  if (error.code === "external_wait_not_found") {
    return new ApiKeyAuthError(404, "not_found", "Not found.");
  }
  return new ApiKeyAuthError(409, "conflict", error.message);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ externalWaitId: string }> },
) {
  try {
    const auth = await authenticateApiRequest(request);
    const { externalWaitId } = await params;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";

    if (!isUuid(externalWaitId)) {
      throw new ApiKeyAuthError(404, "not_found", "Not found.");
    }

    if (!idempotencyKey || idempotencyKey.length > 500) {
      throw new ApiKeyAuthError(400, "invalid_idempotency_key", "Idempotency-Key is required.");
    }

    try {
      await receiveExternalProcessWaitEvent({
        keyHash: auth.keyHash,
        externalWaitId,
        idempotencyKeyHash: sha256(idempotencyKey),
        supabase: createAdminSupabaseClient(),
      });
    } catch (error) {
      if (error instanceof ExternalProcessWaitEventError) {
        throw mapExternalWaitError(error);
      }
      throw error;
    }

    return apiJsonResponse({ status: "accepted" }, 200);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
