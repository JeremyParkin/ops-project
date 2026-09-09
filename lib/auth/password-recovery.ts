import { cookies } from "next/headers";

import { createServerSupabaseClient } from "@/lib/supabase/server";

export const RECOVERY_SESSION_COOKIE = "password_recovery_pending";
const RECOVERY_COOKIE_MAX_AGE_SECONDS = 10 * 60;

// Lives here rather than in the "use server" app/auth-actions.ts -- that
// file may only export async functions, and this is a plain string constant
// shared between updatePasswordAction's redirect and /sign-in's page.
export const PASSWORD_RESET_SUCCESS_PARAM = "passwordReset";

// Supabase's session JWT only records a broad `amr` method ("otp") for a
// recovery-link verification -- it doesn't distinguish "verified via a
// recovery link" from, say, a magic-link or signup-confirmation OTP at the
// token level (confirmed by inspecting a real verified session's claims), so
// there's no claim on the session itself that proves "this is a recovery
// session." This cookie is what stands in for that proof: /auth/confirm
// sets it only after its own type==="recovery" verifyOtp call has actually
// succeeded (see app/auth/confirm/route.ts), and it's required -- not
// merely advisory -- everywhere recovery state matters: both
// /reset-password's own render gate and updatePasswordAction's mutation
// boundary call hasActiveRecoverySession() below, so a caller can't reach
// the mutation just by holding an ordinary signed-in session (this is a
// password-*recovery* flow, not a general "change my password while signed
// in" feature). It still identifies no one on its own -- the Supabase
// session remains the sole source of identity -- it only proves *how* the
// current session was established.
export async function markRecoverySessionEstablished() {
  const cookieStore = await cookies();
  cookieStore.set(RECOVERY_SESSION_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: RECOVERY_COOKIE_MAX_AGE_SECONDS,
  });
}

export async function hasPendingRecoverySession(): Promise<boolean> {
  const cookieStore = await cookies();
  return cookieStore.get(RECOVERY_SESSION_COOKIE)?.value === "1";
}

export async function clearRecoverySession() {
  const cookieStore = await cookies();
  cookieStore.delete(RECOVERY_SESSION_COOKIE);
}

// The single check both /reset-password (render gate) and
// updatePasswordAction (mutation boundary) must use -- a valid session
// alone or the marker alone is never sufficient.
export async function hasActiveRecoverySession(): Promise<boolean> {
  if (!(await hasPendingRecoverySession())) return false;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getClaims();
  return !error && data !== null;
}
