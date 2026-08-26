import { WorkspaceRoleManagement } from "@/app/components/workspace-role-management";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { listWorkspaceMembersWithRoles, listWorkspaceRoles } from "@/lib/domain/workspace-role-repository";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage() {
  const { workspaceId, user } = await getActiveWorkspaceId();
  const [entityTypes, permissions] = await Promise.all([
    listEntityTypes({ workspaceId }),
    getWorkspacePermissionContext(workspaceId),
  ]);
  const canManageMembers = permissions?.capabilities.has("workspace.manage_members") ?? false;
  const canManageRoles = permissions?.capabilities.has("workspace.manage_roles") ?? false;
  const roles = canManageMembers || canManageRoles
    ? await listWorkspaceRoles({ workspaceId })
    : [];
  const members = canManageMembers
    ? await listWorkspaceMembersWithRoles({ workspaceId })
    : [];

  return (
    <WorkspacePageLayout navigation={<WorkspaceNavigation entityTypes={entityTypes} activeSection="settings" />}>
      <PageHeader
        eyebrow="Workspace setup"
        title="Members and roles"
        description="Manage workspace responsibilities without changing who can read workspace records."
      />
      {permissions && (canManageMembers || canManageRoles) ? (
        <WorkspaceRoleManagement
          roles={roles}
          members={members}
          canManageMembers={canManageMembers}
          canManageRoles={canManageRoles}
          currentUserId={user.id}
          currentRoleId={permissions.roleId}
        />
      ) : (
        <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
          <h2 className="text-lg font-semibold text-graphite">Members and roles are managed by workspace administrators.</h2>
          <p className="mt-2 text-sm text-stone">You can continue to view workspace records available to members.</p>
        </section>
      )}
    </WorkspacePageLayout>
  );
}
