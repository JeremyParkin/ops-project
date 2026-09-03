import { NotificationList } from "@/app/components/notification-list";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import { listMyNotifications } from "@/lib/domain/notification-repository";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const notifications = await listMyNotifications({ workspaceId });

  return (
    <WorkspacePageLayout>
      <PageHeader
        title="Notifications"
        description="Assignments, due dates, and record mentions for work assigned to you. Marking a notification read never changes My Work."
      />
      <NotificationList workspaceId={workspaceId} notifications={notifications} />
    </WorkspacePageLayout>
  );
}
