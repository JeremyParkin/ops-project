import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { buildApiPage, decodeApiCursor } from "./api-cursor";
import { ApiKeyAuthError, mapApiDataError } from "./api-key-auth";

export type ApiObjectSummary = { id: string; name: string; slug: string; createdAt: string };

export type ApiChoiceOption = {
  id: string;
  label: string;
  color: string | null;
  archived: boolean;
};

export type ApiFieldDefinition = {
  id: string;
  key: string;
  name: string;
  type: string;
  required: boolean;
  relatedEntityTypeId: string | null;
  // Present (possibly empty) only for choice fields; archived options are
  // included and flagged, since a consumer resolving a record's stored
  // option id needs those too.
  options?: ApiChoiceOption[];
};

export type ApiObjectDetail = ApiObjectSummary & { updatedAt: string; fields: ApiFieldDefinition[] };

export type ApiRecord = {
  id: string;
  objectId: string;
  values: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ApiPage<T> = { data: T[]; nextCursor: string | null };

type ObjectRow = { id: string; name: string; slug: string; created_at: string };
type ObjectDetailRow = ObjectRow & {
  updated_at: string;
  fields:
    | {
        id: string;
        key: string;
        name: string;
        type: string;
        required: boolean;
        relatedEntityTypeId: string | null;
        options: ApiChoiceOption[] | null;
      }[]
    | null;
};
// record_values, not values -- the RPCs' RETURNS TABLE output column is
// named record_values (an unquoted `values` there is rejected by
// PostgreSQL's grammar, even though entity_records.values itself is a
// perfectly ordinary column name). Mapped back to `values` in ApiRecord --
// the external API contract is unaffected by this internal naming detail.
type RecordRow = { id: string; record_values: Record<string, unknown>; created_at: string; updated_at: string };

// The RPC is called with the caller's real `limit` but is written (see
// migration 0074) to internally fetch `limit + 1` rows -- the lookahead row
// is what lets buildApiPage report nextCursor truthfully instead of
// guessing from "a full page came back" (also true on a genuinely last page
// whose count is an exact multiple of the limit). Trimming back to at most
// `limit` rows happens in buildApiPage, not here and not in the RPC.
async function callPaginatedRpc<Row extends { created_at: string; id: string }>(
  rpcName: string,
  params: Record<string, unknown>,
  limit: number,
): Promise<{ rows: Row[]; nextCursor: string | null }> {
  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase.rpc(rpcName, params);
  if (error) throw mapApiDataError(error);

  const overFetchedRows = (data ?? []) as Row[];
  const page = buildApiPage(
    overFetchedRows.map((row) => ({ ...row, createdAt: row.created_at })),
    limit,
  );
  return { rows: page.rows as Row[], nextCursor: page.nextCursor };
}

function decodeCursorParam(cursor: string | null): { after_created_at: string | null; after_id: string | null } {
  if (!cursor) return { after_created_at: null, after_id: null };
  const decoded = decodeApiCursor(cursor);
  if (!decoded) {
    throw new ApiKeyAuthError(400, "invalid_cursor", "The cursor parameter is malformed.");
  }
  return { after_created_at: decoded.createdAt, after_id: decoded.id };
}

export async function listApiObjects({
  keyHash,
  limit,
  cursor,
}: {
  keyHash: string;
  limit: number;
  cursor: string | null;
}): Promise<ApiPage<ApiObjectSummary>> {
  const after = decodeCursorParam(cursor);
  const { rows, nextCursor } = await callPaginatedRpc<ObjectRow>(
    "list_objects_for_api_key",
    { p_key_hash: keyHash, p_limit: limit, p_after_created_at: after.after_created_at, p_after_id: after.after_id },
    limit,
  );
  return {
    data: rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, createdAt: row.created_at })),
    nextCursor,
  };
}

export async function getApiObject({
  keyHash,
  entityTypeId,
}: {
  keyHash: string;
  entityTypeId: string;
}): Promise<ApiObjectDetail | null> {
  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase.rpc("get_object_for_api_key", {
    p_key_hash: keyHash,
    p_entity_type_id: entityTypeId,
  });
  if (error) throw mapApiDataError(error);

  const row = (data as ObjectDetailRow[] | null)?.[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fields: (row.fields ?? []).map((field) => ({
      id: field.id,
      key: field.key,
      name: field.name,
      type: field.type,
      required: field.required,
      relatedEntityTypeId: field.relatedEntityTypeId ?? null,
      ...(field.type === "choice" ? { options: field.options ?? [] } : {}),
    })),
  };
}

export async function listApiRecords({
  keyHash,
  entityTypeId,
  limit,
  cursor,
}: {
  keyHash: string;
  entityTypeId: string;
  limit: number;
  cursor: string | null;
}): Promise<ApiPage<ApiRecord>> {
  const after = decodeCursorParam(cursor);
  const { rows, nextCursor } = await callPaginatedRpc<RecordRow>(
    "list_records_for_api_key",
    {
      p_key_hash: keyHash,
      p_entity_type_id: entityTypeId,
      p_limit: limit,
      p_after_created_at: after.after_created_at,
      p_after_id: after.after_id,
    },
    limit,
  );
  return {
    data: rows.map((row) => ({
      id: row.id,
      objectId: entityTypeId,
      values: row.record_values,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    nextCursor,
  };
}

export async function getApiRecord({
  keyHash,
  entityTypeId,
  recordId,
}: {
  keyHash: string;
  entityTypeId: string;
  recordId: string;
}): Promise<ApiRecord | null> {
  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase.rpc("get_record_for_api_key", {
    p_key_hash: keyHash,
    p_entity_type_id: entityTypeId,
    p_record_id: recordId,
  });
  if (error) throw mapApiDataError(error);

  const row = (data as RecordRow[] | null)?.[0];
  if (!row) return null;

  return {
    id: row.id,
    objectId: entityTypeId,
    values: row.record_values,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
