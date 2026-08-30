import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { WorkspaceCapability } from "@/lib/auth/capabilities";

export type WorkspaceRole = {
  id: string;
  name: string;
  description?: string;
  isBuiltin: boolean;
  capabilities: WorkspaceCapability[];
  memberCount: number;
};

export type WorkspaceMemberWithRole = {
  userId: string;
  email: string;
  roleId: string;
  roleName: string;
  deactivatedAt?: string;
};

function mapCapabilities(value: unknown): WorkspaceCapability[] {
  return Array.isArray(value) ? value.filter((item): item is WorkspaceCapability => typeof item === "string") : [];
}

export async function listWorkspaceMembersWithRoles({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<WorkspaceMemberWithRole[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "list_workspace_members_with_roles_authorized",
    { p_workspace_id: workspaceId },
  );

  if (error) throw new Error(`Unable to load workspace members: ${error.message}`);

  return ((data ?? []) as Array<{
    user_id: string;
    email: string;
    role_id: string;
    role_name: string;
    deactivated_at: string | null;
  }>).map((member) => ({
    userId: member.user_id,
    email: member.email,
    roleId: member.role_id,
    roleName: member.role_name,
    deactivatedAt: member.deactivated_at ?? undefined,
  }));
}

export async function listWorkspaceRoles({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<WorkspaceRole[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_workspace_roles_authorized", {
    p_workspace_id: workspaceId,
  });

  if (error) throw new Error(`Unable to load workspace roles: ${error.message}`);

  return ((data ?? []) as Array<{
    role_id: string;
    name: string;
    description: string | null;
    is_builtin: boolean;
    capabilities: unknown;
    member_count: number | string;
  }>).map((role) => ({
    id: role.role_id,
    name: role.name,
    description: role.description ?? undefined,
    isBuiltin: role.is_builtin,
    capabilities: mapCapabilities(role.capabilities),
    memberCount: Number(role.member_count),
  }));
}

export async function createWorkspaceRole({
  workspaceId,
  name,
  description,
  capabilities,
}: {
  workspaceId: string;
  name: string;
  description: string;
  capabilities: WorkspaceCapability[];
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("create_workspace_role_authorized", {
    p_workspace_id: workspaceId,
    p_name: name,
    p_description: description,
    p_capabilities: capabilities,
  });
  if (error) throw new Error(error.message);
}

export async function updateWorkspaceRole({
  workspaceId,
  roleId,
  name,
  description,
  capabilities,
}: {
  workspaceId: string;
  roleId: string;
  name: string;
  description: string;
  capabilities: WorkspaceCapability[];
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_workspace_role_authorized", {
    p_workspace_id: workspaceId,
    p_role_id: roleId,
    p_name: name,
    p_description: description,
    p_capabilities: capabilities,
  });
  if (error) throw new Error(error.message);
}

export async function deleteWorkspaceRoleWithReassignment({
  workspaceId,
  roleId,
  replacementRoleId,
}: {
  workspaceId: string;
  roleId: string;
  replacementRoleId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc(
    "delete_workspace_role_with_reassignment_authorized",
    {
      p_workspace_id: workspaceId,
      p_role_id: roleId,
      p_replacement_role_id: replacementRoleId,
    },
  );
  if (error) throw new Error(error.message);
}

export async function setWorkspaceMemberRole({
  workspaceId,
  userId,
  roleId,
}: {
  workspaceId: string;
  userId: string;
  roleId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_workspace_member_role_authorized", {
    p_workspace_id: workspaceId,
    p_user_id: userId,
    p_role_id: roleId,
  });
  if (error) throw new Error(error.message);
}

export async function deactivateWorkspaceMember({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("deactivate_workspace_member_authorized", {
    p_workspace_id: workspaceId,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
}

export async function reactivateWorkspaceMember({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("reactivate_workspace_member_authorized", {
    p_workspace_id: workspaceId,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
}
