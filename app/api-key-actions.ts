"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspaceId, requireWorkspaceCapability } from "@/lib/auth/workspace";
import { apiKeyPreview, generateApiKey, hashApiKey } from "@/lib/domain/api-key-signing";
import { createApiKey, revokeApiKey } from "@/lib/domain/api-key-repository";
import type { ApiKeyPurpose } from "@/lib/domain/api-key-repository";

export type ApiKeyActionState = { success: boolean; message: string; secret?: string };

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const separator = error.message.indexOf(": ");
    return separator >= 0 ? error.message.slice(separator + 2) : error.message;
  }
  return fallback;
}

async function activeIntegrationsWorkspace() {
  const { workspaceId } = await getActiveWorkspaceId();
  await requireWorkspaceCapability(workspaceId, "workspace.manage_integrations");
  return workspaceId;
}

export async function createApiKeyAction(
  _previousState: ApiKeyActionState,
  formData: FormData,
): Promise<ApiKeyActionState> {
  const name = getText(formData, "name");
  const purpose = getText(formData, "purpose") as ApiKeyPurpose;
  if (!name) return { success: false, message: "Enter a name for this key." };
  if (purpose !== "records_read" && purpose !== "process_waits_complete") {
    return { success: false, message: "Choose what this key is for." };
  }

  try {
    const workspaceId = await activeIntegrationsWorkspace();
    const rawKey = generateApiKey();
    await createApiKey({ workspaceId, name, keyHash: hashApiKey(rawKey), keyPreview: apiKeyPreview(rawKey), purpose });
    revalidatePath("/settings/integrations");
    return { success: true, message: "API key created. Copy it now -- it will not be shown again.", secret: rawKey };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to create the API key.") };
  }
}

export async function revokeApiKeyAction(
  _previousState: ApiKeyActionState,
  formData: FormData,
): Promise<ApiKeyActionState> {
  const keyId = getText(formData, "keyId");
  if (!keyId) return { success: false, message: "Choose a key." };

  try {
    const workspaceId = await activeIntegrationsWorkspace();
    await revokeApiKey({ workspaceId, keyId });
    revalidatePath("/settings/integrations");
    return { success: true, message: "API key revoked." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to revoke the API key.") };
  }
}
