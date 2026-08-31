import { apiErrorResponse, apiJsonResponse, authenticateApiRequest, notFoundResponse } from "@/lib/domain/api-key-auth";
import { getApiRecord } from "@/lib/domain/api-read-repository";

export const dynamic = "force-dynamic";

// GET /api/v1/objects/:entityTypeId/records/:recordId -- one active record.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ entityTypeId: string; recordId: string }> },
) {
  try {
    const auth = await authenticateApiRequest(request);
    const { entityTypeId, recordId } = await params;

    const record = await getApiRecord({ keyHash: auth.keyHash, entityTypeId, recordId });
    if (!record) return notFoundResponse("Record not found.");

    return apiJsonResponse(record);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
