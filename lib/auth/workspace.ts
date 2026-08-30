import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { WorkspaceCapability } from "@/lib/auth/capabilities";

export const ACTIVE_WORKSPACE_COOKIE = "active_workspace_id";

export type WorkspaceMembership = {
  workspaceId: string;
  workspaceName: string;
};

export type WorkspacePermissionContext = {
  roleId: string;
  roleName: string;
  capabilities: Set<WorkspaceCapability>;
};

export async function getWorkspacePermissionContext(
  workspaceId: string,
): Promise<WorkspacePermissionContext | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workspace_memberships")
    .select("role_id, workspace_roles!inner(name, workspace_role_capabilities(capability))")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .is("deactivated_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.role_id) return null;
  const role = data.workspace_roles as unknown as {
    name: string;
    workspace_role_capabilities: Array<{ capability: WorkspaceCapability }>;
  };
  return {
    roleId: data.role_id,
    roleName: role.name,
    capabilities: new Set(role.workspace_role_capabilities.map((item) => item.capability)),
  };
}

export async function requireWorkspaceCapability(
  workspaceId: string,
  capability: WorkspaceCapability,
) {
  const context = await getWorkspacePermissionContext(workspaceId);
  if (!context?.capabilities.has(capability)) {
    throw new Error("You do not have permission to perform this action.");
  }
  return context;
}

export async function getCurrentUser() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

export async function listCurrentUserMemberships(): Promise<WorkspaceMembership[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workspace_memberships")
    .select("workspace_id, workspaces!workspace_memberships_workspace_id_fkey!inner(name)")
    .eq("user_id", user.id)
    .is("deactivated_at", null)
    .order("created_at");

  if (error) throw new Error(error.message);

  return (data ?? []).map((membership) => ({
    workspaceId: membership.workspace_id,
    workspaceName: (membership.workspaces as unknown as { name: string })?.name ?? "",
  }));
}

export async function getActiveWorkspaceId() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const memberships = await listCurrentUserMemberships();
  if (memberships.length === 0) redirect("/no-workspace");

  const cookieStore = await cookies();
  const requestedWorkspaceId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const activeMembership =
    memberships.find((membership) => membership.workspaceId === requestedWorkspaceId) ??
    memberships[0];

  return { user, workspaceId: activeMembership.workspaceId, memberships };
}

export async function setActiveWorkspaceId(workspaceId: string) {
  const memberships = await listCurrentUserMemberships();
  if (!memberships.some((membership) => membership.workspaceId === workspaceId)) {
    throw new Error("You do not have access to that workspace.");
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
}
