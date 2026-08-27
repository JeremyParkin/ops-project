import { createServerSupabaseClient } from "@/lib/supabase/server";

export type WorkspaceTeam = {
  id: string;
  name: string;
  description?: string;
  archivedAt?: string;
  memberCount: number;
  leadCount: number;
};

export type WorkspaceOrganizationMember = {
  userId: string;
  email: string;
  managerUserId?: string;
  managerEmail?: string;
};

export type WorkspaceTeamMembership = {
  teamId: string;
  userId: string;
  isLead: boolean;
};

export type WorkspaceOrganization = {
  teams: WorkspaceTeam[];
  members: WorkspaceOrganizationMember[];
  memberships: WorkspaceTeamMembership[];
};

export type WorkspacePersonIdentity = {
  userId: string;
  email: string;
};

type WorkspaceTeamRow = {
  team_id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  member_count: number | string;
  lead_count: number | string;
};

type WorkspaceOrganizationMemberRow = {
  user_id: string;
  email: string;
  manager_user_id: string | null;
  manager_email: string | null;
};

type WorkspaceTeamMembershipRow = {
  team_id: string;
  user_id: string;
  is_lead: boolean;
};

type MyWorkspaceTeamRow = {
  team_id: string;
  name: string;
  description: string | null;
  is_lead: boolean;
};

type WorkspacePersonRow = {
  user_id: string;
  email: string;
  is_lead?: boolean;
};

function errorMessage(error: { message: string } | null, fallback: string) {
  return error?.message ?? fallback;
}

export async function listWorkspaceOrganization({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<WorkspaceOrganization> {
  const supabase = await createServerSupabaseClient();
  const [teamsResult, membersResult, membershipsResult] = await Promise.all([
    supabase.rpc("list_workspace_teams_authorized", { p_workspace_id: workspaceId }),
    supabase.rpc("list_workspace_organization_members_authorized", { p_workspace_id: workspaceId }),
    supabase.rpc("list_workspace_team_memberships_authorized", { p_workspace_id: workspaceId }),
  ]);

  if (teamsResult.error) {
    throw new Error(errorMessage(teamsResult.error, "Unable to load workspace teams."));
  }
  if (membersResult.error) {
    throw new Error(errorMessage(membersResult.error, "Unable to load workspace members."));
  }
  if (membershipsResult.error) {
    throw new Error(errorMessage(membershipsResult.error, "Unable to load team memberships."));
  }

  return {
    teams: ((teamsResult.data ?? []) as WorkspaceTeamRow[]).map((team) => ({
      id: team.team_id,
      name: team.name,
      description: team.description ?? undefined,
      archivedAt: team.archived_at ?? undefined,
      memberCount: Number(team.member_count),
      leadCount: Number(team.lead_count),
    })),
    members: ((membersResult.data ?? []) as WorkspaceOrganizationMemberRow[]).map((member) => ({
      userId: member.user_id,
      email: member.email,
      managerUserId: member.manager_user_id ?? undefined,
      managerEmail: member.manager_email ?? undefined,
    })),
    memberships: ((membershipsResult.data ?? []) as WorkspaceTeamMembershipRow[]).map((membership) => ({
      teamId: membership.team_id,
      userId: membership.user_id,
      isLead: membership.is_lead,
    })),
  };
}

export async function createWorkspaceTeam({
  workspaceId,
  name,
  description,
}: {
  workspaceId: string;
  name: string;
  description: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("create_workspace_team_authorized", {
    p_workspace_id: workspaceId,
    p_name: name,
    p_description: description,
  });
  if (error) throw new Error(error.message);
}

export async function updateWorkspaceTeam({
  workspaceId,
  teamId,
  name,
  description,
}: {
  workspaceId: string;
  teamId: string;
  name: string;
  description: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_workspace_team_authorized", {
    p_workspace_id: workspaceId,
    p_team_id: teamId,
    p_name: name,
    p_description: description,
  });
  if (error) throw new Error(error.message);
}

export async function setWorkspaceTeamArchived({
  workspaceId,
  teamId,
  archived,
}: {
  workspaceId: string;
  teamId: string;
  archived: boolean;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_workspace_team_archived_authorized", {
    p_workspace_id: workspaceId,
    p_team_id: teamId,
    p_archived: archived,
  });
  if (error) throw new Error(error.message);
}

export async function deleteWorkspaceTeamIfEmpty({
  workspaceId,
  teamId,
}: {
  workspaceId: string;
  teamId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("delete_workspace_team_if_empty_authorized", {
    p_workspace_id: workspaceId,
    p_team_id: teamId,
  });
  if (error) throw new Error(error.message);
}

export async function setWorkspaceTeamMembership({
  workspaceId,
  teamId,
  userId,
  isMember,
}: {
  workspaceId: string;
  teamId: string;
  userId: string;
  isMember: boolean;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_workspace_team_membership_authorized", {
    p_workspace_id: workspaceId,
    p_team_id: teamId,
    p_user_id: userId,
    p_is_member: isMember,
  });
  if (error) throw new Error(error.message);
}

export async function setWorkspaceTeamLead({
  workspaceId,
  teamId,
  userId,
  isLead,
}: {
  workspaceId: string;
  teamId: string;
  userId: string;
  isLead: boolean;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_workspace_team_lead_authorized", {
    p_workspace_id: workspaceId,
    p_team_id: teamId,
    p_user_id: userId,
    p_is_lead: isLead,
  });
  if (error) throw new Error(error.message);
}

export async function setWorkspacePrimaryManager({
  workspaceId,
  reportUserId,
  managerUserId,
}: {
  workspaceId: string;
  reportUserId: string;
  managerUserId?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_workspace_primary_manager_authorized", {
    p_workspace_id: workspaceId,
    p_report_user_id: reportUserId,
    p_manager_user_id: managerUserId ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function listMyWorkspaceTeams({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<Array<WorkspaceTeam & { isLead: boolean }>> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_my_workspace_teams_authorized", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as MyWorkspaceTeamRow[]).map((team) => ({
    id: team.team_id,
    name: team.name,
    description: team.description ?? undefined,
    memberCount: 0,
    leadCount: 0,
    isLead: team.is_lead,
  }));
}

export async function getMyWorkspaceManager({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<WorkspacePersonIdentity | undefined> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_my_workspace_manager_authorized", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message);
  const manager = data?.[0];
  return manager ? { userId: manager.user_id, email: manager.email } : undefined;
}

export async function listMyDirectReports({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<WorkspacePersonIdentity[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_my_direct_reports_authorized", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as WorkspacePersonRow[]).map((person) => ({ userId: person.user_id, email: person.email }));
}

export async function listMyTeamMembers({
  workspaceId,
  teamId,
}: {
  workspaceId: string;
  teamId: string;
}): Promise<Array<WorkspacePersonIdentity & { isLead: boolean }>> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_my_team_members_authorized", {
    p_workspace_id: workspaceId,
    p_team_id: teamId,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as WorkspacePersonRow[]).map((person) => ({
    userId: person.user_id,
    email: person.email,
    isLead: Boolean(person.is_lead),
  }));
}
