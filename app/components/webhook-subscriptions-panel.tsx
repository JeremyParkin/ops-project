"use client";

import { useActionState, useState } from "react";
import {
  createWebhookSubscriptionAction,
  regenerateWebhookSubscriptionSecretAction,
  updateWebhookSubscriptionAction,
  type WebhookActionState,
} from "@/app/webhook-actions";
import { webhookEventTypeLabels, webhookEventTypes, type WebhookEventType } from "@/lib/domain/webhook-events";
import type { WebhookDelivery, WebhookSubscription } from "@/lib/domain/webhook-repository";

const initialState: WebhookActionState = { success: false, message: "" };

function ActionMessage({ state }: { state: WebhookActionState }) {
  return state.message ? (
    <p className={`mt-2 text-sm ${state.success ? "text-status-sage" : "text-red-700"}`} role="status">
      {state.message}
    </p>
  ) : null;
}

function SecretReveal({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-3 border border-brass bg-chalk p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone">Signing secret -- shown once</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="break-all border border-grit bg-paper px-2 py-1 text-sm text-graphite">{secret}</code>
        <button
          type="button"
          className="h-8 border border-graphite px-3 text-xs font-medium text-graphite hover:bg-slab hover:text-chalk"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function EventTypeChecklist({ selected, disabled }: { selected: WebhookEventType[]; disabled?: boolean }) {
  return (
    <fieldset className="mt-2 grid gap-2 sm:grid-cols-2">
      <legend className="text-xs font-semibold uppercase tracking-wide text-stone">Event types</legend>
      {webhookEventTypes.map((eventType) => (
        <label key={eventType} className="flex items-center gap-2 text-sm text-graphite">
          <input
            type="checkbox"
            name="eventType"
            value={eventType}
            defaultChecked={selected.includes(eventType)}
            disabled={disabled}
            className="h-4 w-4 border-grit"
          />
          <span>{webhookEventTypeLabels[eventType]}</span>
        </label>
      ))}
    </fieldset>
  );
}

function CreateWebhookForm() {
  const [state, action, pending] = useActionState(createWebhookSubscriptionAction, initialState);

  return (
    <form action={action} className="border border-grit bg-paper p-4">
      <h2 className="text-lg font-semibold text-graphite">Add a webhook</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-graphite">
          Name
          <input name="name" required className="h-9 border border-grit bg-background px-2" placeholder="e.g. Ops Slack relay" />
        </label>
        <label className="grid gap-1 text-sm text-graphite">
          Endpoint URL
          <input
            name="url"
            type="url"
            required
            className="h-9 border border-grit bg-background px-2"
            placeholder="https://example.com/webhooks/kinema"
          />
        </label>
      </div>
      <EventTypeChecklist selected={[]} />
      <button
        type="submit"
        disabled={pending}
        className="mt-4 h-10 border border-graphite bg-graphite px-4 text-sm font-medium text-chalk hover:bg-slab disabled:bg-chalk disabled:text-stone"
      >
        {pending ? "Creating..." : "Create webhook"}
      </button>
      <ActionMessage state={state} />
      {state.secret ? <SecretReveal secret={state.secret} /> : null}
    </form>
  );
}

function DeliveryStatusLabel({ delivery }: { delivery: WebhookDelivery }) {
  if (delivery.status === "succeeded") {
    return <span className="font-medium text-status-sage">Succeeded</span>;
  }
  if (delivery.status === "failed") {
    return <span className="font-medium text-red-700">Failed (terminal)</span>;
  }
  return <span className="font-medium text-graphite">Pending (attempt {delivery.attempts + 1})</span>;
}

function DeliveryLog({ deliveries }: { deliveries: WebhookDelivery[] }) {
  if (deliveries.length === 0) {
    return <p className="mt-3 text-sm text-stone">No deliveries yet.</p>;
  }

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-grit text-xs uppercase tracking-wide text-stone">
            <th className="py-1 pr-3">Event</th>
            <th className="py-1 pr-3">Status</th>
            <th className="py-1 pr-3">Attempts</th>
            <th className="py-1 pr-3">Last response</th>
            <th className="py-1 pr-3">Last attempted</th>
            <th className="py-1">Failure</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((delivery) => (
            <tr key={delivery.id} className="border-b border-grit/60">
              <td className="py-1 pr-3">{delivery.eventType}</td>
              <td className="py-1 pr-3">
                <DeliveryStatusLabel delivery={delivery} />
              </td>
              <td className="py-1 pr-3">{delivery.attempts}</td>
              <td className="py-1 pr-3">{delivery.lastResponseStatus ?? "--"}</td>
              <td className="py-1 pr-3">
                {delivery.lastAttemptedAt ? new Date(delivery.lastAttemptedAt).toLocaleString() : "--"}
              </td>
              <td className="py-1 text-stone">{delivery.lastFailureSummary ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegenerateSecretButton({ subscriptionId }: { subscriptionId: string }) {
  const [state, action, pending] = useActionState(regenerateWebhookSubscriptionSecretAction, initialState);

  return (
    <form action={action}>
      <input type="hidden" name="subscriptionId" value={subscriptionId} />
      <button
        type="submit"
        disabled={pending}
        className="h-8 border border-graphite px-3 text-xs font-medium text-graphite hover:bg-slab hover:text-chalk disabled:bg-chalk disabled:text-stone"
      >
        {pending ? "Regenerating..." : "Regenerate secret"}
      </button>
      <ActionMessage state={state} />
      {state.secret ? <SecretReveal secret={state.secret} /> : null}
    </form>
  );
}

function WebhookSubscriptionCard({
  subscription,
  deliveries,
}: {
  subscription: WebhookSubscription;
  deliveries: WebhookDelivery[];
}) {
  const [state, action, pending] = useActionState(updateWebhookSubscriptionAction, initialState);

  return (
    <div className="border border-grit bg-paper p-4">
      <form action={action}>
        <input type="hidden" name="subscriptionId" value={subscription.id} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm text-graphite">
              Name
              <input name="name" defaultValue={subscription.name} required className="h-9 border border-grit bg-background px-2" />
            </label>
            <label className="grid gap-1 text-sm text-graphite">
              Endpoint URL
              <input
                name="url"
                type="url"
                defaultValue={subscription.url}
                required
                className="h-9 border border-grit bg-background px-2"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-graphite">
            <input type="checkbox" name="active" defaultChecked={subscription.active} className="h-4 w-4 border-grit" />
            Active
          </label>
        </div>
        <EventTypeChecklist selected={subscription.eventTypes} />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="h-9 border border-graphite px-4 text-sm font-medium text-graphite hover:bg-slab hover:text-chalk disabled:bg-chalk disabled:text-stone"
          >
            {pending ? "Saving..." : "Save changes"}
          </button>
          <span className="text-xs text-stone">Secret ends in •••• {subscription.secretPreview}</span>
        </div>
        <ActionMessage state={state} />
      </form>

      <div className="mt-3">
        <RegenerateSecretButton subscriptionId={subscription.id} />
      </div>

      <div className="mt-4 border-t border-grit pt-3">
        <h3 className="text-sm font-semibold text-graphite">Recent deliveries</h3>
        <DeliveryLog deliveries={deliveries} />
      </div>
    </div>
  );
}

export function WebhookSubscriptionsPanel({
  subscriptions,
  deliveriesBySubscriptionId,
}: {
  subscriptions: WebhookSubscription[];
  deliveriesBySubscriptionId: Record<string, WebhookDelivery[]>;
}) {
  return (
    <div className="grid gap-6">
      <CreateWebhookForm />
      {subscriptions.length === 0 ? (
        <p className="text-sm text-stone">No webhooks configured yet.</p>
      ) : (
        <div className="grid gap-4">
          {subscriptions.map((subscription) => (
            <WebhookSubscriptionCard
              key={subscription.id}
              subscription={subscription}
              deliveries={deliveriesBySubscriptionId[subscription.id] ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}
