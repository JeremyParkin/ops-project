"use server";

import { revalidatePath } from "next/cache";
import { markAllNotificationsRead, markNotificationRead } from "@/lib/domain/notification-repository";

export type NotificationActionState = { success: boolean; message: string };

const initialState: NotificationActionState = { success: true, message: "" };

export async function markNotificationReadAction(
  context: { workspaceId: string },
  _previousState: NotificationActionState,
  formData: FormData,
): Promise<NotificationActionState> {
  const notificationId = formData.get("notificationId");

  if (typeof notificationId !== "string" || !notificationId) {
    return { success: false, message: "Invalid notification." };
  }

  try {
    await markNotificationRead({ workspaceId: context.workspaceId, notificationId });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to mark notification read.",
    };
  }

  revalidatePath("/notifications");
  return initialState;
}

export async function markAllNotificationsReadAction(
  context: { workspaceId: string },
  previousState: NotificationActionState,
  formData: FormData,
): Promise<NotificationActionState> {
  void previousState;
  void formData;
  try {
    await markAllNotificationsRead({ workspaceId: context.workspaceId });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to mark notifications read.",
    };
  }

  revalidatePath("/notifications");
  return initialState;
}
