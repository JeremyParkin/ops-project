import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { exportEntityRecordsToCsv } from "@/lib/domain/record-export";

export const dynamic = "force-dynamic";

// Membership-level read authorization only -- not records.operate. Export
// is a read (you're extracting data you can already see in the table), and
// this app's permission model already treats reads as membership-wide with
// capability gates reserved for writes; gating a read behind a write
// capability would be a mismatch, not a safety measure. Same-workspace-only
// falls out for free: exportEntityRecordsToCsv scopes every lookup by the
// caller's own resolved workspaceId, never the URL param, so a mismatched
// or foreign entityTypeId simply resolves no rows.
export async function GET(_request: Request, { params }: { params: Promise<{ entityTypeId: string }> }) {
  const { entityTypeId } = await params;
  const { workspaceId } = await getActiveWorkspaceId();

  let result: Awaited<ReturnType<typeof exportEntityRecordsToCsv>>;
  try {
    result = await exportEntityRecordsToCsv({ workspaceId, entityTypeId });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(result.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
}
