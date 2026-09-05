"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspaceId, requireWorkspaceCapability } from "@/lib/auth/workspace";
import { setPersonEntityType } from "@/lib/domain/person-link-repository";
import { setWorkspaceTimezone } from "@/lib/domain/recurrence-repository";

export type WorkspaceSettingsActionState = { success: boolean; message: string };

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const separator = error.message.indexOf(": ");
    return separator >= 0 ? error.message.slice(separator + 2) : error.message;
  }
  return fallback;
}

export async function setWorkspaceTimezoneAction(
  _previousState: WorkspaceSettingsActionState,
  formData: FormData,
): Promise<WorkspaceSettingsActionState> {
  const timezone = formData.get("timezone");

  if (typeof timezone !== "string" || !timezone.trim()) {
    return { success: false, message: "Choose a timezone." };
  }

  try {
    const { workspaceId } = await getActiveWorkspaceId();
    await requireWorkspaceCapability(workspaceId, "workspace.manage_settings");
    await setWorkspaceTimezone({ workspaceId, timezone: timezone.trim() });
    revalidatePath("/settings");
    return { success: true, message: "Workspace timezone updated." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the workspace timezone.") };
  }
}

export async function setPersonEntityTypeAction(
  _previousState: WorkspaceSettingsActionState,
  formData: FormData,
): Promise<WorkspaceSettingsActionState> {
  const entityTypeId = formData.get("entityTypeId");
  const value = typeof entityTypeId === "string" && entityTypeId ? entityTypeId : null;

  try {
    const { workspaceId } = await getActiveWorkspaceId();
    await requireWorkspaceCapability(workspaceId, "schema.manage");
    await setPersonEntityType({ workspaceId, entityTypeId: value });
    revalidatePath("/settings");
    return { success: true, message: value ? "Person type set." : "Person type cleared." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to set the Person type.") };
  }
}
