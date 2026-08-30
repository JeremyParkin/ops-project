import type { ReactNode } from "react";
import { AppHeader } from "@/app/components/app-header";
import { signOut, switchActiveWorkspace } from "@/app/auth-actions";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { getUnreadNotificationCount } from "@/lib/domain/notification-repository";
import { listManagedPeopleContext } from "@/lib/domain/workspace-organization-repository";

const QUICK_JUMP_LIMIT = 6;

export default async function AppShellLayout({ children }: { children: ReactNode }) {
  const { user, workspaceId, memberships } = await getActiveWorkspaceId();
  const [permissions, entityTypes, unreadNotificationCount] = await Promise.all([
    getWorkspacePermissionContext(workspaceId),
    listEntityTypes({ workspaceId }),
    getUnreadNotificationCount({ workspaceId }),
  ]);
  const capabilities = permissions?.capabilities;
  const canManageWorkspace = Boolean(
    capabilities?.has("workspace.manage_members") ||
      capabilities?.has("workspace.manage_roles") ||
      capabilities?.has("workspace.manage_organization"),
  );
  const canManageAutomation = Boolean(capabilities?.has("automation.manage"));
  const canManageSchema = Boolean(capabilities?.has("schema.manage"));
  const canViewManagerPortfolio =
    Boolean(capabilities?.has("operations.view")) &&
    (await listManagedPeopleContext({ workspaceId })).length > 0;
  const activeWorkspaceName =
    memberships.find((membership) => membership.workspaceId === workspaceId)?.workspaceName ?? "";
  const sortedEntityTypes = [...entityTypes].sort((a, b) => a.name.localeCompare(b.name));
  const quickJumpEntityTypes = sortedEntityTypes
    .slice(0, QUICK_JUMP_LIMIT)
    .map((entityType) => ({ id: entityType.id, name: entityType.name }));

  return (
    <>
      <AppHeader
        workspaceName={activeWorkspaceName}
        memberships={memberships}
        activeWorkspaceId={workspaceId}
        userEmail={user.email ?? ""}
        canViewManagerPortfolio={canViewManagerPortfolio}
        canManageWorkspace={canManageWorkspace}
        canManageAutomation={canManageAutomation}
        canManageSchema={canManageSchema}
        quickJumpEntityTypes={quickJumpEntityTypes}
        hasMoreEntityTypes={sortedEntityTypes.length > quickJumpEntityTypes.length}
        unreadNotificationCount={unreadNotificationCount}
        switchActiveWorkspaceAction={switchActiveWorkspace}
        signOutAction={signOut}
      />
      {children}
    </>
  );
}
