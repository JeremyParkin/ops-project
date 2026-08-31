import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { WebhookSubscriptionsPanel } from "@/app/components/webhook-subscriptions-panel";
import { ApiKeysPanel } from "@/app/components/api-keys-panel";
import { getActiveWorkspaceId, getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { resolveImpersonationContext } from "@/lib/auth/impersonation";
import { listWebhookDeliveries, listWebhookSubscriptions } from "@/lib/domain/webhook-repository";
import type { WebhookDelivery } from "@/lib/domain/webhook-repository";
import { listApiKeys } from "@/lib/domain/api-key-repository";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
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
          title="Integrations"
          description="Webhooks and API keys for external systems."
        />
        <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
          <h2 className="text-lg font-semibold text-graphite">
            {impersonation.isImpersonating
              ? "Not available while impersonating."
              : "Integrations are managed by workspace administrators."}
          </h2>
        </section>
      </WorkspacePageLayout>
    );
  }

  const [subscriptions, apiKeys] = await Promise.all([
    listWebhookSubscriptions({ workspaceId }),
    listApiKeys({ workspaceId }),
  ]);
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
        title="Integrations"
        description="Webhooks and API keys for external systems."
      />
      <section className="mx-auto w-full max-w-6xl">
        <h2 className="text-xl font-semibold text-graphite">Webhooks</h2>
        <p className="mt-1 text-sm text-stone">
          Deliver process_started, process_completed, approval_decided, and step_assigned events to external HTTPS
          endpoints.
        </p>
        <div className="mt-4">
          <WebhookSubscriptionsPanel subscriptions={subscriptions} deliveriesBySubscriptionId={deliveriesBySubscriptionId} />
        </div>
      </section>
      <section className="mx-auto w-full max-w-6xl border-t border-grit pt-8">
        <h2 className="text-xl font-semibold text-graphite">API Keys</h2>
        <p className="mt-1 text-sm text-stone">
          Read-only, workspace-scoped keys for programmatic access to /api/v1.
        </p>
        <div className="mt-4">
          <ApiKeysPanel apiKeys={apiKeys} />
        </div>
      </section>
    </WorkspacePageLayout>
  );
}
