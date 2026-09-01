import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ApiKey = {
  id: string;
  name: string;
  keyPreview: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type ApiKeyPurpose = "records_read" | "process_waits_complete";

type ApiKeyListRow = {
  id: string;
  name: string;
  key_preview: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type ApiKeyCreateRow = {
  id: string;
  name: string;
  key_preview: string;
  scopes: string[];
  created_at: string;
};

export async function listApiKeys({ workspaceId }: { workspaceId: string }): Promise<ApiKey[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_api_keys_authorized", { p_workspace_id: workspaceId });
  if (error) throw new Error(error.message);

  return ((data ?? []) as ApiKeyListRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    keyPreview: row.key_preview,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

export async function createApiKey({
  workspaceId,
  name,
  keyHash,
  keyPreview,
  purpose = "records_read",
}: {
  workspaceId: string;
  name: string;
  keyHash: string;
  keyPreview: string;
  purpose?: ApiKeyPurpose;
}): Promise<ApiKey> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_api_key_authorized", {
    p_workspace_id: workspaceId,
    p_name: name,
    p_key_hash: keyHash,
    p_key_preview: keyPreview,
    p_scope: purpose === "process_waits_complete" ? "process_waits:complete" : "records:read",
  });
  if (error) throw new Error(error.message);

  const row = (data as ApiKeyCreateRow[] | null)?.[0];
  if (!row) throw new Error("API key creation did not return a key.");

  return {
    id: row.id,
    name: row.name,
    keyPreview: row.key_preview,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastUsedAt: null,
    revokedAt: null,
  };
}

export async function revokeApiKey({ workspaceId, keyId }: { workspaceId: string; keyId: string }): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("revoke_api_key_authorized", { p_workspace_id: workspaceId, p_key_id: keyId });
  if (error) throw new Error(error.message);
}
