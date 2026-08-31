import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { WebhookSubscriptionsPanel } from "@/app/components/webhook-subscriptions-panel";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { listWebhookDeliveries, listWebhookSubscriptions } from "@/lib/domain/webhook-repository";
import type { WebhookDelivery } from "@/lib/domain/webhook-repository";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const { workspaceId } = await getActiveWorkspaceId();
  const [permissions, impersonation] = await Promise.all([
    getWorkspacePermissionContext(workspaceId),
    resolveImpersonationContext(workspaceId),
  ]);

  // Governance-adjacent, same posture as Workspace Health (8E.3) and
  // /settings itself: unreachable while impersonating, not just hidden from
  // the nav -- administering integrations disguised as someone else isn't
  // what impersonation is for.
  const canView =
    !impersonation.isImpersonating && (permissions?.capabilities.has("workspace.manage_integrations") ?? false);

  if (!canView) {
    return (
      <WorkspacePageLayout>
        <PageHeader
          eyebrow="Configure"
          title="Webhooks"
          description="Deliver operational events to external HTTPS endpoints."
        />
        <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
          <h2 className="text-lg font-semibold text-graphite">
            {impersonation.isImpersonating
              ? "Not available while impersonating."
              : "Webhooks are managed by workspace administrators."}
          </h2>
        </section>
      </WorkspacePageLayout>
    );
  }

  const subscriptions = await listWebhookSubscriptions({ workspaceId });
  const deliveriesBySubscriptionId: Record<string, WebhookDelivery[]> = {};
  await Promise.all(
    subscriptions.map(async (subscription) => {
      deliveriesBySubscriptionId[subscription.id] = await listWebhookDeliveries({
        workspaceId,
        subscriptionId: subscription.id,
        limit: 25,
      });
    }),
  );

  return (
    <WorkspacePageLayout>
      <PageHeader
        eyebrow="Configure"
        title="Webhooks"
        description="Deliver process_started, process_completed, approval_decided, and step_assigned events to external HTTPS endpoints."
      />
      <section className="mx-auto w-full max-w-6xl">
        <WebhookSubscriptionsPanel subscriptions={subscriptions} deliveriesBySubscriptionId={deliveriesBySubscriptionId} />
      </section>
    </WorkspacePageLayout>
  );
}
