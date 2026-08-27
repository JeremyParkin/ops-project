import { WorkspaceRoleManagement } from "@/app/components/workspace-role-management";
import { WorkspaceOrganizationManagement } from "@/app/components/workspace-organization-management";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { listWorkspaceMembersWithRoles, listWorkspaceRoles } from "@/lib/domain/workspace-role-repository";
import { listWorkspaceOrganization } from "@/lib/domain/workspace-organization-repository";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage() {
  const { workspaceId, user } = await getActiveWorkspaceId();
  const [entityTypes, permissions] = await Promise.all([
    listEntityTypes({ workspaceId }),
    getWorkspacePermissionContext(workspaceId),
  ]);
  const canManageMembers = permissions?.capabilities.has("workspace.manage_members") ?? false;
  const canManageRoles = permissions?.capabilities.has("workspace.manage_roles") ?? false;
  const canManageOrganization = permissions?.capabilities.has("workspace.manage_organization") ?? false;
  const roles = canManageMembers || canManageRoles
    ? await listWorkspaceRoles({ workspaceId })
    : [];
  const members = canManageMembers
    ? await listWorkspaceMembersWithRoles({ workspaceId })
    : [];
  const organization = canManageOrganization
    ? await listWorkspaceOrganization({ workspaceId })
    : undefined;

  return (
    <WorkspacePageLayout navigation={<WorkspaceNavigation entityTypes={entityTypes} activeSection="settings" />}>
      <PageHeader
        eyebrow="Workspace setup"
        title="Workspace settings"
        description="Manage workspace responsibilities and organizational structure without changing who can read workspace records."
      />
      {permissions && (canManageMembers || canManageRoles || canManageOrganization) ? (
        <>
          {canManageMembers || canManageRoles ? (
            <WorkspaceRoleManagement
              roles={roles}
              members={members}
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
