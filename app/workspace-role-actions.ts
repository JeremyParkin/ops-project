"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspaceId, requireWorkspaceCapability } from "@/lib/auth/workspace";
import { isWorkspaceCapability, type WorkspaceCapability } from "@/lib/auth/capabilities";
import {
  createWorkspaceRole,
  deactivateWorkspaceMember,
  deleteWorkspaceRoleWithReassignment,
  reactivateWorkspaceMember,
  setWorkspaceMemberRole,
  updateWorkspaceRole,
} from "@/lib/domain/workspace-role-repository";

export type WorkspaceRoleActionState = { success: boolean; message: string };

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getCapabilities(formData: FormData): WorkspaceCapability[] | null {
  const values = formData.getAll("capability");
  if (!values.every((value) => typeof value === "string" && isWorkspaceCapability(value))) {
    return null;
  }
  return [...new Set(values as WorkspaceCapability[])];
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const separator = error.message.indexOf(": ");
    return separator >= 0 ? error.message.slice(separator + 2) : error.message;
  }
  return fallback;
}

async function activeWorkspaceFor(capability: WorkspaceCapability) {
  const { workspaceId } = await getActiveWorkspaceId();
  await requireWorkspaceCapability(workspaceId, capability);
  return workspaceId;
}

export async function createWorkspaceRoleAction(
  _previousState: WorkspaceRoleActionState,
  formData: FormData,
): Promise<WorkspaceRoleActionState> {
  const name = getText(formData, "name");
  const capabilities = getCapabilities(formData);
  if (!name || !capabilities) return { success: false, message: "Enter a role name and choose valid capabilities." };

  try {
    const workspaceId = await activeWorkspaceFor("workspace.manage_roles");
    await createWorkspaceRole({ workspaceId, name, description: getText(formData, "description"), capabilities });
    revalidatePath("/settings");
    return { success: true, message: "Role created." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to create the role.") };
  }
}

export async function updateWorkspaceRoleAction(
  _previousState: WorkspaceRoleActionState,
  formData: FormData,
): Promise<WorkspaceRoleActionState> {
  const roleId = getText(formData, "roleId");
  const name = getText(formData, "name");
  const capabilities = getCapabilities(formData);
  if (!roleId || !name || !capabilities) return { success: false, message: "Enter a role name and choose valid capabilities." };

  try {
    const workspaceId = await activeWorkspaceFor("workspace.manage_roles");
    await updateWorkspaceRole({ workspaceId, roleId, name, description: getText(formData, "description"), capabilities });
    revalidatePath("/settings");
    return { success: true, message: "Role updated." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the role.") };
  }
}

export async function deleteWorkspaceRoleAction(
  _previousState: WorkspaceRoleActionState,
  formData: FormData,
): Promise<WorkspaceRoleActionState> {
  const roleId = getText(formData, "roleId");
  const replacementRoleId = getText(formData, "replacementRoleId");
  if (!roleId || !replacementRoleId) return { success: false, message: "Choose a replacement role." };

  try {
    const workspaceId = await activeWorkspaceFor("workspace.manage_roles");
    await deleteWorkspaceRoleWithReassignment({ workspaceId, roleId, replacementRoleId });
    revalidatePath("/settings");
    return { success: true, message: "Role deleted and members reassigned." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to delete the role.") };
  }
}

export async function setWorkspaceMemberRoleAction(
  _previousState: WorkspaceRoleActionState,
  formData: FormData,
): Promise<WorkspaceRoleActionState> {
  const userId = getText(formData, "userId");
  const roleId = getText(formData, "roleId");
  if (!userId || !roleId) return { success: false, message: "Choose a member and role." };

  try {
    const workspaceId = await activeWorkspaceFor("workspace.manage_members");
    await setWorkspaceMemberRole({ workspaceId, userId, roleId });
    revalidatePath("/settings");
    return { success: true, message: "Member role updated." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the member role.") };
  }
}

export async function deactivateWorkspaceMemberAction(
  _previousState: WorkspaceRoleActionState,
  formData: FormData,
): Promise<WorkspaceRoleActionState> {
  const userId = getText(formData, "userId");
  if (!userId) return { success: false, message: "Choose a member." };

  try {
    const workspaceId = await activeWorkspaceFor("workspace.manage_members");
    await deactivateWorkspaceMember({ workspaceId, userId });
    revalidatePath("/settings");
    return { success: true, message: "Member deactivated." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to deactivate the member.") };
  }
}

export async function reactivateWorkspaceMemberAction(
  _previousState: WorkspaceRoleActionState,
  formData: FormData,
): Promise<WorkspaceRoleActionState> {
  const userId = getText(formData, "userId");
  if (!userId) return { success: false, message: "Choose a member." };

  try {
    const workspaceId = await activeWorkspaceFor("workspace.manage_members");
    await reactivateWorkspaceMember({ workspaceId, userId });
    revalidatePath("/settings");
    return { success: true, message: "Member reactivated." };
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to reactivate the member.") };
  }
}
