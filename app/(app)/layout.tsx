import type { ReactNode } from "react";
import { AppHeader } from "@/app/components/app-header";
import { ImpersonationBanner } from "@/app/components/impersonation-banner";
import { signOut, switchActiveWorkspace } from "@/app/auth-actions";
import { endImpersonationAction } from "@/app/impersonation-actions";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
import { getUnreadNotificationCount } from "@/lib/domain/notification-repository";
import { listManagedPeopleContext } from "@/lib/domain/workspace-organization-repository";

const QUICK_JUMP_LIMIT = 6;

export default async function AppShellLayout({ children }: { children: ReactNode }) {
  const { user, workspaceId, memberships } = await getActiveWorkspaceId();
  const [permissions, entityTypes, unreadNotificationCount, impersonation] = await Promise.all([
    getWorkspacePermissionContext(workspaceId),
    listEntityTypes({ workspaceId }),
    getUnreadNotificationCount({ workspaceId }),
    resolveImpersonationContext(workspaceId),
  ]);
  const capabilities = permissions?.capabilities;
  // Configure (governance + builder capabilities) is unconditionally hidden
  // while impersonating -- not because the real admin loses these
  // capabilities (they never do; DB enforcement for schema.manage/
  // automation.manage/workspace.manage_* stays real-actor-bound on purpose),
  // but because administering the workspace disguised as someone else isn't
  // what impersonation is for. Exit impersonation to make a config change.
  const canManageWorkspace =
    !impersonation.isImpersonating &&
    Boolean(
      capabilities?.has("workspace.manage_members") ||
        capabilities?.has("workspace.manage_roles") ||
        capabilities?.has("workspace.manage_organization"),
    );
  const canManageAutomation = !impersonation.isImpersonating && Boolean(capabilities?.has("automation.manage"));
  const canManageSchema = !impersonation.isImpersonating && Boolean(capabilities?.has("schema.manage"));
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
      {impersonation.isImpersonating ? (
        <ImpersonationBanner
          effectiveEmail={impersonation.effectiveEmail}
          realActorEmail={impersonation.realActorEmail}
          endImpersonationAction={endImpersonationAction}
        />
      ) : null}
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
