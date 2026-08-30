import { cookies } from "next/headers";
import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";

export const IMPERSONATION_COOKIE = "impersonation_session_id";

export type ImpersonationContext =
  | {
      isImpersonating: true;
      sessionId: string;
      workspaceId: string;
      effectiveUserId: string;
      effectiveEmail: string;
      realActorEmail: string;
    }
  | { isImpersonating: false };

type ActiveImpersonationRow = {
  session_id: string;
  workspace_id: string;
  effective_user_id: string;
  effective_email: string;
  real_actor_email: string;
};

// The one server-verified read every request needs: "is the real, literal
// caller (auth.uid(), which no cookie can change) currently impersonating
// anyone, in THIS workspace, and is that session still valid?" The RPC
// itself self-heals -- if the target has since been deactivated it ends the
// stale session and returns nothing, so an empty result here is definitive:
// clear/resync the cookie and fall back to ordinary real-actor context on
// this same request. Never trust the cookie's session id as authoritative
// on its own -- it is cross-checked against the DB's answer every time.
export async function resolveImpersonationContext(activeWorkspaceId: string): Promise<ImpersonationContext> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_active_impersonation_authorized");
  if (error) throw new Error(error.message);

  const row = (data ?? [])[0] as ActiveImpersonationRow | undefined;
  const cookieStore = await cookies();
  const cookieSessionId = cookieStore.get(IMPERSONATION_COOKIE)?.value;

  if (!row || row.workspace_id !== activeWorkspaceId) {
    if (cookieSessionId) cookieStore.delete(IMPERSONATION_COOKIE);
    if (row && row.workspace_id !== activeWorkspaceId) {
      // A session is genuinely active but scoped to a different workspace
      // than the one now active (e.g. switched workspace without going
      // through switchActiveWorkspace's explicit end-session step) --
      // impersonation is same-workspace only, so end it rather than let it
      // linger unreachable.
      await endImpersonationBestEffort(supabase, row.session_id);
    }
    return { isImpersonating: false };
  }

  if (cookieSessionId !== row.session_id) {
    cookieStore.set(IMPERSONATION_COOKIE, row.session_id, { httpOnly: true, sameSite: "lax", path: "/" });
  }

  return {
    isImpersonating: true,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    effectiveUserId: row.effective_user_id,
    effectiveEmail: row.effective_email,
    realActorEmail: row.real_actor_email,
  };
}

async function endImpersonationBestEffort(supabase: SupabaseServerClient, sessionId: string) {
  await supabase.rpc("end_impersonation_session_authorized", { p_session_id: sessionId });
}

export async function clearImpersonationCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(IMPERSONATION_COOKIE);
}
