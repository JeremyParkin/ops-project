import { apiErrorResponse, apiJsonResponse, authenticateApiRequest, parseLimitParam } from "@/lib/domain/api-key-auth";
import { listApiRecords } from "@/lib/domain/api-read-repository";

export const dynamic = "force-dynamic";

// GET /api/v1/objects/:entityTypeId/records -- active records for one
// active object, cursor-paginated. A foreign or nonexistent entityTypeId
// simply yields an empty page (list_records_for_api_key's own workspace-
// derived existence check), not a distinct error -- consistent with the
// uniform-404 posture for the single-item routes.
export async function GET(request: Request, { params }: { params: Promise<{ entityTypeId: string }> }) {
  try {
    const auth = await authenticateApiRequest(request);
    const { entityTypeId } = await params;
    const url = new URL(request.url);
    const limit = parseLimitParam(url.searchParams);
    const cursor = url.searchParams.get("cursor");

    const page = await listApiRecords({ keyHash: auth.keyHash, entityTypeId, limit, cursor });
    return apiJsonResponse(page);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
