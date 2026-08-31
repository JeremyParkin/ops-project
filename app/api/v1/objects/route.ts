import { apiErrorResponse, apiJsonResponse, authenticateApiRequest, parseLimitParam } from "@/lib/domain/api-key-auth";
import { listApiObjects } from "@/lib/domain/api-read-repository";

export const dynamic = "force-dynamic";

// GET /api/v1/objects -- list active business object types, cursor-paginated.
export async function GET(request: Request) {
  try {
    const auth = await authenticateApiRequest(request);
    const url = new URL(request.url);
    const limit = parseLimitParam(url.searchParams);
    const cursor = url.searchParams.get("cursor");

    const page = await listApiObjects({ keyHash: auth.keyHash, limit, cursor });
    return apiJsonResponse(page);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
