"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { setActiveWorkspaceId } from "@/lib/auth/workspace";
import { clearImpersonationCookie, IMPERSONATION_COOKIE } from "@/lib/auth/impersonation";
import {
  clearRecoverySession,
  hasActiveRecoverySession,
  PASSWORD_RESET_SUCCESS_PARAM,
} from "@/lib/auth/password-recovery";
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
  await clearRecoverySession();
  redirect("/sign-in");
}

export type AuthFormState = { message: string; success?: boolean };

const GENERIC_RESET_REQUEST_MESSAGE =
  "If an account exists for that email, we've sent a password reset link.";

export async function signInAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { message: "Enter your email and password." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { message: "Incorrect email or password." };

  redirect("/");
}

// Always returns the same generic confirmation regardless of whether the
// email belongs to an account -- Supabase itself doesn't distinguish this
// case either, and neither response path should let a caller tell them
// apart (account enumeration).
export async function requestPasswordResetAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { message: "Enter your email." };

  const appUrl = process.env.KINEMA_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (!appUrl) return { message: "Password reset is not available right now." };

  const supabase = await createServerSupabaseClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${appUrl}/auth/confirm`,
  });

  return { message: GENERIC_RESET_REQUEST_MESSAGE, success: true };
}

// This is password *recovery*, not a general "change my password while
// signed in" feature -- an ordinary authenticated session is not enough to
// reach the mutation. /reset-password's own render gate uses the exact same
// hasActiveRecoverySession() check (see lib/auth/password-recovery.ts), but
// that only hides the form; a direct POST to this action must be rejected
// independently at the boundary, or hiding the form would be nothing more
// than cosmetic.
export async function updatePasswordAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!password || !confirmPassword) return { message: "Enter and confirm your new password." };
  if (password.length < 8) return { message: "Password must be at least 8 characters." };
  if (password !== confirmPassword) return { message: "Passwords do not match." };

  if (!(await hasActiveRecoverySession())) {
    return { message: "Your recovery session has expired. Request a new reset link and try again." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { message: "Unable to update your password. Request a new reset link and try again." };
  }

  // Revoke every other active session for this account now that the
  // password has changed. Best-effort: a transient failure here shouldn't
  // block the rest of a change that already succeeded.
  await supabase.auth.signOut({ scope: "others" }).catch(() => {});
  await clearRecoverySession();

  // End the current (recovery) session too -- the user must land on
  // /sign-in genuinely signed out, not silently still authenticated. Unlike
  // the `others` revocation above, a failure here is not swallowed: if
  // Supabase can't confirm the local session was actually ended, redirecting
  // anyway would contradict the whole point of this step, so it's reported
  // as an error instead of a false success.
  const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
  if (signOutError) {
    return {
      message:
        "Your password was updated, but automatic sign-out failed. Please sign out manually before signing back in.",
    };
  }

  redirect(`/sign-in?${PASSWORD_RESET_SUCCESS_PARAM}=1`);
}
