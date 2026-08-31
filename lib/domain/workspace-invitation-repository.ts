import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";

export type WorkspaceInvitation = {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  status: "pending" | "accepted" | "cancelled";
  createdAt: string;
  expiresAt: string;
  token: string;
};

export type InvitationDetails = {
  workspaceId: string;
  workspaceName: string;
  roleName: string;
  email: string;
  status: "pending" | "accepted" | "cancelled";
  expiresAt: string;
  emailHasAccount: boolean;
};

type InvitationRow = {
  id: string;
  email: string;
  role_id: string;
  role_name: string;
  status: "pending" | "accepted" | "cancelled";
  created_at: string;
  expires_at: string;
  token: string;
};

export async function listWorkspaceInvitations({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<WorkspaceInvitation[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_workspace_invitations_authorized", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as InvitationRow[]).map((row) => ({
    id: row.id,
    email: row.email,
    roleId: row.role_id,
    roleName: row.role_name,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    token: row.token,
  }));
}

// Returns the new invitation's bearer token -- the caller (a
// workspace.manage_members admin) uses it to build the shareable fallback
// link. When deployment email config is present, the same authorized RPC
// atomically queues the invitation email without persisting the token/URL/body.
export async function createWorkspaceInvitation({
  workspaceId,
  email,
  roleId,
  enqueueEmail = false,
}: {
  workspaceId: string;
  email: string;
  roleId: string;
  enqueueEmail?: boolean;
}): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_workspace_invitation_authorized", {
    p_workspace_id: workspaceId,
    p_email: email,
    p_role_id: roleId,
    p_enqueue_email: enqueueEmail,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function resendWorkspaceInvitation({
  workspaceId,
  invitationId,
  enqueueEmail = false,
}: {
  workspaceId: string;
  invitationId: string;
  enqueueEmail?: boolean;
}): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("resend_workspace_invitation_authorized", {
    p_workspace_id: workspaceId,
    p_invitation_id: invitationId,
    p_enqueue_email: enqueueEmail,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function cancelWorkspaceInvitation({
  workspaceId,
  invitationId,
}: {
  workspaceId: string;
  invitationId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("cancel_workspace_invitation_authorized", {
    p_workspace_id: workspaceId,
    p_invitation_id: invitationId,
  });
  if (error) throw new Error(error.message);
}

// Public lookup, no active workspace/session required -- a visitor
// following an invitation link is by definition not yet a member.
export async function getInvitationByToken({
  token,
  supabase: injectedSupabase,
}: {
  token: string;
  supabase?: SupabaseServerClient;
}): Promise<InvitationDetails | null> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("get_invitation_by_token", { p_token: token });
  if (error) throw new Error(error.message);

  const row = (data ?? [])[0] as
    | {
        workspace_id: string;
        workspace_name: string;
        role_name: string;
        email: string;
        status: "pending" | "accepted" | "cancelled";
        expires_at: string;
        email_has_account: boolean;
      }
    | undefined;
  if (!row) return null;

  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    roleName: row.role_name,
    email: row.email,
    status: row.status,
    expiresAt: row.expires_at,
    emailHasAccount: row.email_has_account,
  };
}

// Requires the caller to already have an authenticated session (via the
// injected client, so the accept page can use one just established by a
// sign-up/sign-in step earlier in the same server action).
export async function acceptWorkspaceInvitation({
  token,
  supabase: injectedSupabase,
}: {
  token: string;
  supabase?: SupabaseServerClient;
}): Promise<string> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("accept_workspace_invitation_authorized", {
    p_token: token,
  });
  if (error) throw new Error(error.message);
  return data as string;
}
