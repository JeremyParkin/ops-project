"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { setActiveWorkspaceId } from "@/lib/auth/workspace";
import { clearImpersonationCookie, IMPERSONATION_COOKIE } from "@/lib/auth/impersonation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";

export async function switchActiveWorkspace(formData: FormData) {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  await setActiveWorkspaceId(workspaceId);
  // Impersonation is same-workspace only -- switching the active workspace
  // ends it rather than leaving a session scoped to a workspace that's no
  // longer active (resolveImpersonationContext would end it reactively on
  // the next request anyway; this just makes the intent explicit and
  // immediate).
  await endImpersonationForSwitch();
  revalidatePath("/", "layout");
  redirect("/");
}

async function endImpersonationForSwitch() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(IMPERSONATION_COOKIE)?.value;
  if (!sessionId) return;
  const supabase = await createServerSupabaseClient();
  await supabase.rpc("end_impersonation_session_authorized", { p_session_id: sessionId });
  await clearImpersonationCookie();
}

export async function signOut() {
  const supabase = await createServerSupabaseClient();
  await endImpersonationForSwitch();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
