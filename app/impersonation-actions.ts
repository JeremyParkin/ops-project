"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getActiveWorkspaceId, requireWorkspaceCapability } from "@/lib/auth/workspace";
import { IMPERSONATION_COOKIE } from "@/lib/auth/impersonation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ImpersonationActionState = { success: boolean; message: string };

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const separator = error.message.indexOf(": ");
    return separator >= 0 ? error.message.slice(separator + 2) : error.message;
  }
  return fallback;
}

// Starting/ending a session is itself a privileged, real-actor-only action --
// checked against auth.uid() inside the RPC, never against any effective
// identity, so impersonation can never be nested or chained.
export async function startImpersonationAction(
  _previousState: ImpersonationActionState,
  formData: FormData,
): Promise<ImpersonationActionState> {
  const targetUserId = String(formData.get("targetUserId") ?? "").trim();
  if (!targetUserId) return { success: false, message: "Choose a member." };

  let sessionId: string;
  try {
    const { workspaceId } = await getActiveWorkspaceId();
    await requireWorkspaceCapability(workspaceId, "workspace.impersonate_users");
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("start_impersonation_session_authorized", {
      p_workspace_id: workspaceId,
      p_target_user_id: targetUserId,
    });
    if (error) throw new Error(error.message);
    sessionId = data as string;
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to start impersonation.") };
  }

  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATION_COOKIE, sessionId, { httpOnly: true, sameSite: "lax", path: "/" });
  revalidatePath("/", "layout");
  redirect("/");
}

export async function endImpersonationAction() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(IMPERSONATION_COOKIE)?.value;
  cookieStore.delete(IMPERSONATION_COOKIE);

  if (sessionId) {
    const supabase = await createServerSupabaseClient();
    // Best-effort: the session may already be gone (self-healed by
    // get_active_impersonation_authorized after target deactivation, or
    // ended by a workspace switch) -- either way the cookie is already
    // cleared above, which is what actually controls the banner.
    await supabase.rpc("end_impersonation_session_authorized", { p_session_id: sessionId });
  }

  revalidatePath("/", "layout");
  redirect("/");
}
