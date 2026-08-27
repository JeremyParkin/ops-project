"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspaceId, requireWorkspaceCapability } from "@/lib/auth/workspace";
import {
  createWorkspaceTeam,
  deleteWorkspaceTeamIfEmpty,
  setWorkspacePrimaryManager,
  setWorkspaceTeamArchived,
  setWorkspaceTeamLead,
  setWorkspaceTeamMembership,
  updateWorkspaceTeam,
} from "@/lib/domain/workspace-organization-repository";

export type WorkspaceOrganizationActionState = {
  success: boolean;
  message: string;
};

const organizationCapability = "workspace.manage_organization";

function getText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getBoolean(formData: FormData, key: string) {
  return getText(formData, key) === "true";
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const separator = error.message.indexOf(": ");
    return separator >= 0 ? error.message.slice(separator + 2) : error.message;
  }
  return fallback;
}

async function activeWorkspace() {
  const { workspaceId } = await getActiveWorkspaceId();
  await requireWorkspaceCapability(workspaceId, organizationCapability);
  return workspaceId;
}

function success(message: string): WorkspaceOrganizationActionState {
  revalidatePath("/settings");
  return { success: true, message };
}

export async function createWorkspaceTeamAction(
  _previousState: WorkspaceOrganizationActionState,
  formData: FormData,
): Promise<WorkspaceOrganizationActionState> {
  const name = getText(formData, "name");
  if (!name) return { success: false, message: "Enter a team name." };

  try {
    await createWorkspaceTeam({
      workspaceId: await activeWorkspace(),
      name,
      description: getText(formData, "description"),
    });
    return success("Team created.");
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to create the team.") };
  }
}

export async function updateWorkspaceTeamAction(
  _previousState: WorkspaceOrganizationActionState,
  formData: FormData,
): Promise<WorkspaceOrganizationActionState> {
  const teamId = getText(formData, "teamId");
  const name = getText(formData, "name");
  if (!teamId || !name) return { success: false, message: "Enter a team name." };

  try {
    await updateWorkspaceTeam({
      workspaceId: await activeWorkspace(),
      teamId,
      name,
      description: getText(formData, "description"),
    });
    return success("Team updated.");
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the team.") };
  }
}

export async function setWorkspaceTeamArchivedAction(
  _previousState: WorkspaceOrganizationActionState,
  formData: FormData,
): Promise<WorkspaceOrganizationActionState> {
  const teamId = getText(formData, "teamId");
  if (!teamId) return { success: false, message: "Choose a team." };

  try {
    await setWorkspaceTeamArchived({
      workspaceId: await activeWorkspace(),
      teamId,
      archived: getBoolean(formData, "archived"),
    });
    return success(getBoolean(formData, "archived") ? "Team archived." : "Team restored.");
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the team lifecycle.") };
  }
}

export async function deleteWorkspaceTeamAction(
  _previousState: WorkspaceOrganizationActionState,
  formData: FormData,
): Promise<WorkspaceOrganizationActionState> {
  const teamId = getText(formData, "teamId");
  if (!teamId) return { success: false, message: "Choose a team." };

  try {
    await deleteWorkspaceTeamIfEmpty({ workspaceId: await activeWorkspace(), teamId });
    return success("Team deleted.");
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to delete the team.") };
  }
}

export async function setWorkspaceTeamMembershipAction(
  _previousState: WorkspaceOrganizationActionState,
  formData: FormData,
): Promise<WorkspaceOrganizationActionState> {
  const teamId = getText(formData, "teamId");
  const userId = getText(formData, "userId");
  if (!teamId || !userId) return { success: false, message: "Choose a team member." };

  try {
    await setWorkspaceTeamMembership({
      workspaceId: await activeWorkspace(),
      teamId,
      userId,
      isMember: getBoolean(formData, "isMember"),
    });
    return success(getBoolean(formData, "isMember") ? "Team member added." : "Team member removed.");
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the team member.") };
  }
}

export async function setWorkspaceTeamLeadAction(
  _previousState: WorkspaceOrganizationActionState,
  formData: FormData,
): Promise<WorkspaceOrganizationActionState> {
  const teamId = getText(formData, "teamId");
  const userId = getText(formData, "userId");
  if (!teamId || !userId) return { success: false, message: "Choose a team lead." };

  try {
    await setWorkspaceTeamLead({
      workspaceId: await activeWorkspace(),
      teamId,
      userId,
      isLead: getBoolean(formData, "isLead"),
    });
    return success(getBoolean(formData, "isLead") ? "Team lead added." : "Team lead removed.");
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the team lead.") };
  }
}

export async function setWorkspacePrimaryManagerAction(
  _previousState: WorkspaceOrganizationActionState,
  formData: FormData,
): Promise<WorkspaceOrganizationActionState> {
  const reportUserId = getText(formData, "reportUserId");
  if (!reportUserId) return { success: false, message: "Choose a member." };

  try {
    await setWorkspacePrimaryManager({
      workspaceId: await activeWorkspace(),
      reportUserId,
      managerUserId: getText(formData, "managerUserId") || undefined,
    });
    return success("Direct manager updated.");
  } catch (error) {
    return { success: false, message: errorMessage(error, "Unable to update the direct manager.") };
  }
}
