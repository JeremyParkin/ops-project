"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { updateUserPreferences } from "@/lib/domain/user-preferences-repository";
import type { UserTheme } from "@/lib/domain/user-preferences-types";

export type PersonalSettingsActionState = { success: boolean; message: string };

export async function updatePersonalSettingsAction(
  _previousState: PersonalSettingsActionState,
  formData: FormData,
): Promise<PersonalSettingsActionState> {
  const theme = formData.get("theme");
  const timezone = formData.get("timezone");
  const notifyCommentMentions = formData.get("notifyCommentMentions") === "on";
  const notifyInputRequestStatusUpdates = formData.get("notifyInputRequestStatusUpdates") === "on";
  if (theme !== "system" && theme !== "light" && theme !== "dark") {
    return { success: false, message: "Choose a valid theme." };
  }
  if (typeof timezone !== "string") {
    return { success: false, message: "Choose a timezone or use your device timezone." };
  }

  try {
    const { workspaceId } = await getActiveWorkspaceId();
    const impersonation = await resolveImpersonationContext(workspaceId);
    if (impersonation.isImpersonating) {
      return { success: false, message: "Exit impersonation before changing personal settings." };
    }
    await updateUserPreferences({
      theme: theme as UserTheme,
      timezone: timezone || null,
      notifyCommentMentions,
      notifyInputRequestStatusUpdates,
    });
    revalidatePath("/settings/personal");
    revalidatePath("/", "layout");
    return { success: true, message: "Personal settings updated." };
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Unable to save personal settings: /, "") : "Unable to update personal settings.";
    return { success: false, message };
  }
}
