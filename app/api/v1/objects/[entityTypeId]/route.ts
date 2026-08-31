import { apiErrorResponse, apiJsonResponse, authenticateApiRequest, notFoundResponse } from "@/lib/domain/api-key-auth";
import { getApiObject } from "@/lib/domain/api-read-repository";

export const dynamic = "force-dynamic";

// GET /api/v1/objects/:entityTypeId -- one active object type plus its
// active field definitions. A foreign or nonexistent entityTypeId is
// indistinguishable from "not found" -- get_object_for_api_key derives its
// own workspace from the key and simply returns no row.
export async function GET(request: Request, { params }: { params: Promise<{ entityTypeId: string }> }) {
  try {
    const auth = await authenticateApiRequest(request);
    const { entityTypeId } = await params;

    const object = await getApiObject({ keyHash: auth.keyHash, entityTypeId });
    if (!object) return notFoundResponse("Object not found.");

    return apiJsonResponse(object);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
