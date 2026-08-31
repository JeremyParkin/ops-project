// Opaque keyset-pagination cursor shared by both /api/v1 list endpoints
// (list_objects_for_api_key, list_records_for_api_key both order by
// (created_at, id) ascending). Encoding/decoding lives entirely in the app
// layer -- the SQL functions take two plain typed parameters
// (p_after_created_at, p_after_id), never a cursor string.
export type ApiCursor = { createdAt: string; id: string };

export function encodeApiCursor(cursor: ApiCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

// The RPC is asked to fetch `limit + 1` rows (see the migration's list
// functions) so nextCursor can be truthful: emitted only when a row beyond
// the caller's requested page actually exists, never guessed merely from
// "a full page came back" (which is also true on a genuinely last page
// whose count happens to be an exact multiple of the limit). Trimming back
// to at most `limit` rows for the external response happens here, not in
// the RPC -- the RPC's own contract is "give me the truth plus one lookahead
// row", this function's job is "shape that into an honest page."
export function buildApiPage<Row extends { createdAt: string; id: string }>(
  overFetchedRows: Row[],
  limit: number,
): { rows: Row[]; nextCursor: string | null } {
  const hasMore = overFetchedRows.length > limit;
  const rows = hasMore ? overFetchedRows.slice(0, limit) : overFetchedRows;
  const nextCursor = hasMore
    ? encodeApiCursor({ createdAt: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id })
    : null;
  return { rows, nextCursor };
}

export function decodeApiCursor(raw: string): ApiCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { createdAt?: unknown }).createdAt === "string" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      const { createdAt, id } = parsed as ApiCursor;
      return { createdAt, id };
    }
    return null;
  } catch {
    return null;
  }
}
