import { WorkspaceRoleManagement } from "@/app/components/workspace-role-management";
import { WorkspaceOrganizationManagement } from "@/app/components/workspace-organization-management";
import { WorkspaceTimezoneSettings } from "@/app/components/workspace-timezone-settings";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { getWorkspaceTimezone } from "@/lib/domain/recurrence-repository";
import { listWorkspaceMembersWithRoles, listWorkspaceRoles } from "@/lib/domain/workspace-role-repository";
import { listWorkspaceInvitations } from "@/lib/domain/workspace-invitation-repository";
import { listWorkspaceOrganization } from "@/lib/domain/workspace-organization-repository";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage() {
  const { workspaceId, user } = await getActiveWorkspaceId();
  const permissions = await getWorkspacePermissionContext(workspaceId);
  const canManageMembers = permissions?.capabilities.has("workspace.manage_members") ?? false;
  const canManageRoles = permissions?.capabilities.has("workspace.manage_roles") ?? false;
  const canManageOrganization = permissions?.capabilities.has("workspace.manage_organization") ?? false;
  const canManageSettings = permissions?.capabilities.has("workspace.manage_settings") ?? false;
  const roles = canManageMembers || canManageRoles
    ? await listWorkspaceRoles({ workspaceId })
    : [];
  const members = canManageMembers
    ? await listWorkspaceMembersWithRoles({ workspaceId })
    : [];
  const invitations = canManageMembers
    ? await listWorkspaceInvitations({ workspaceId })
    : [];
  const organization = canManageOrganization
    ? await listWorkspaceOrganization({ workspaceId })
    : undefined;
  const workspaceTimezone = canManageSettings
    ? await getWorkspaceTimezone({ workspaceId })
    : undefined;

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="Configure"
        title="Workspace settings"
        description="Manage workspace responsibilities and organizational structure without changing who can read workspace records."
      />
      {permissions && (canManageMembers || canManageRoles || canManageOrganization || canManageSettings) ? (
        <>
          {workspaceTimezone !== undefined ? (
            <WorkspaceTimezoneSettings currentTimezone={workspaceTimezone} />
          ) : null}
          {canManageMembers || canManageRoles ? (
            <WorkspaceRoleManagement
              roles={roles}
              members={members}
              invitations={invitations}
              canManageMembers={canManageMembers}
              canManageRoles={canManageRoles}
              currentUserId={user.id}
              currentRoleId={permissions.roleId}
            />
          ) : null}
          {organization ? (
            <WorkspaceOrganizationManagement
              teams={organization.teams}
              members={organization.members}
              memberships={organization.memberships}
            />
          ) : null}
        </>
      ) : (
        <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
          <h2 className="text-lg font-semibold text-graphite">Workspace settings are managed by workspace administrators.</h2>
          <p className="mt-2 text-sm text-stone">You can continue to view workspace records available to members.</p>
        </section>
      )}
    </WorkspacePageLayout>
  );
}
