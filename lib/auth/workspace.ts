import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/lib/supabase/server";

export const ACTIVE_WORKSPACE_COOKIE = "active_workspace_id";

export type WorkspaceMembership = {
  workspaceId: string;
  workspaceName: string;
};

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
    .select("workspace_id, workspaces!inner(name)")
    .eq("user_id", user.id)
    .order("created_at");

  if (error) throw new Error(error.message);

  return (data ?? []).map((membership) => ({
    workspaceId: membership.workspace_id,
    workspaceName: (membership.workspaces as { name: string }[])[0]?.name ?? "",
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
