"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getActiveWorkspaceId, requireWorkspaceCapability, setActiveWorkspaceId } from "@/lib/auth/workspace";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  acceptWorkspaceInvitation,
  cancelWorkspaceInvitation,
  createWorkspaceInvitation,
  getInvitationByToken,
  resendWorkspaceInvitation,
} from "@/lib/domain/workspace-invitation-repository";

export type WorkspaceInvitationActionState = {
  success: boolean;
  message: string;
  link?: string;
};

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

async function invitationLinkFor(token: string) {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const path = `/accept-invitation?token=${token}`;
  return host ? `${proto}://${host}${path}` : path;
}

export async function createWorkspaceInvitationAction(
  _previousState: WorkspaceInvitationActionState,
  formData: FormData,
): Promise<WorkspaceInvitationActionState> {
  const email = getText(formData, "email");
  const roleId = getText(formData, "roleId");
  if (!email || !roleId) return { success: false, message: "Enter an email and choose a role." };

  try {
    const { workspaceId } = await getActiveWorkspaceId();
    await requireWorkspaceCapability(workspaceId, "workspace.manage_members");
    const token = await createWorkspaceInvitation({ workspaceId, email, roleId });
    revalidatePath("/settings");
    return { success: true, message: "Invitation created. Share this link with them.", link: await invitationLinkFor(token) };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to create the invitation.") };
  }
}

export async function resendWorkspaceInvitationAction(
  _previousState: WorkspaceInvitationActionState,
  formData: FormData,
): Promise<WorkspaceInvitationActionState> {
  const invitationId = getText(formData, "invitationId");
  if (!invitationId) return { success: false, message: "Choose an invitation." };

  try {
    const { workspaceId } = await getActiveWorkspaceId();
    await requireWorkspaceCapability(workspaceId, "workspace.manage_members");
    const token = await resendWorkspaceInvitation({ workspaceId, invitationId });
    revalidatePath("/settings");
    return { success: true, message: "Invitation refreshed. Share this new link.", link: await invitationLinkFor(token) };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to resend the invitation.") };
  }
}

export async function cancelWorkspaceInvitationAction(
  _previousState: WorkspaceInvitationActionState,
  formData: FormData,
): Promise<WorkspaceInvitationActionState> {
  const invitationId = getText(formData, "invitationId");
  if (!invitationId) return { success: false, message: "Choose an invitation." };

  try {
    const { workspaceId } = await getActiveWorkspaceId();
    await requireWorkspaceCapability(workspaceId, "workspace.manage_members");
    await cancelWorkspaceInvitation({ workspaceId, invitationId });
    revalidatePath("/settings");
    return { success: true, message: "Invitation cancelled." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to cancel the invitation.") };
  }
}

export type AcceptInvitationActionState = { message: string };

// A genuinely new person: no existing Kinema account for this email. Uses
// the narrow, approved service-role exception (see lib/supabase/admin.ts)
// to create the auth.users row directly with email_confirm: true --
// establishing usable credentials without any confirmation email, since
// this app has no email provider. Signs the new account in through the
// completely standard email+password flow immediately after, using the
// password the person themselves just chose -- this is not session
// minting or impersonation, it's the ordinary sign-in RPC applied right
// after legitimate account creation. accept_workspace_invitation_authorized
// still independently re-validates the token/email/expiry before granting
// any workspace access, regardless of how the session was established.
export async function acceptInvitationCreateAccountAction(
  _previousState: AcceptInvitationActionState,
  formData: FormData,
): Promise<AcceptInvitationActionState> {
  const token = getText(formData, "token");
  const password = String(formData.get("password") ?? "");
  if (!token || !password) return { message: "Enter a password." };
  if (password.length < 8) return { message: "Password must be at least 8 characters." };

  let workspaceId: string;
  try {
    const invitation = await getInvitationByToken({ token });
    if (!invitation || invitation.status !== "pending" || new Date(invitation.expiresAt) <= new Date()) {
      return { message: "This invitation is no longer valid." };
    }
    if (invitation.emailHasAccount) {
      return { message: "An account already exists for this email. Sign in instead." };
    }

    const admin = createAdminSupabaseClient();
    const { error: createError } = await admin.auth.admin.createUser({
      email: invitation.email,
      password,
      email_confirm: true,
    });
    if (createError) throw new Error(createError.message);

    const supabase = await createServerSupabaseClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: invitation.email,
      password,
    });
    if (signInError) throw new Error(signInError.message);

    workspaceId = await acceptWorkspaceInvitation({ token, supabase });
  } catch (error) {
    return { message: errorMessage(error, "Unable to accept the invitation.") };
  }

  await setActiveWorkspaceId(workspaceId);
  redirect("/");
}

// An existing Kinema user, invited into this (additional) workspace.
export async function acceptInvitationSignInAction(
  _previousState: AcceptInvitationActionState,
  formData: FormData,
): Promise<AcceptInvitationActionState> {
  const token = getText(formData, "token");
  const password = String(formData.get("password") ?? "");
  if (!token || !password) return { message: "Enter your password." };

  let workspaceId: string;
  try {
    const invitation = await getInvitationByToken({ token });
    if (!invitation || invitation.status !== "pending" || new Date(invitation.expiresAt) <= new Date()) {
      return { message: "This invitation is no longer valid." };
    }

    const supabase = await createServerSupabaseClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: invitation.email,
      password,
    });
    if (signInError) return { message: "Incorrect password." };

    workspaceId = await acceptWorkspaceInvitation({ token, supabase });
  } catch (error) {
    return { message: errorMessage(error, "Unable to accept the invitation.") };
  }

  await setActiveWorkspaceId(workspaceId);
  redirect("/");
}

// The visitor already has an active session matching the invitation's
// email (e.g. accepting a second invitation while already signed in).
export async function acceptInvitationDirectAction(
  _previousState: AcceptInvitationActionState,
  formData: FormData,
): Promise<AcceptInvitationActionState> {
  const token = getText(formData, "token");
  if (!token) return { message: "Missing invitation token." };

  let workspaceId: string;
  try {
    workspaceId = await acceptWorkspaceInvitation({ token });
  } catch (error) {
    return { message: errorMessage(error, "Unable to accept the invitation.") };
  }

  await setActiveWorkspaceId(workspaceId);
  redirect("/");
}
