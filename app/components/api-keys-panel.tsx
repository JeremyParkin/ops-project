"use client";

import { useActionState, useState } from "react";
import { createApiKeyAction, revokeApiKeyAction, type ApiKeyActionState } from "@/app/api-key-actions";
import type { ApiKey } from "@/lib/domain/api-key-repository";

const initialState: ApiKeyActionState = { success: false, message: "" };

function ActionMessage({ state }: { state: ApiKeyActionState }) {
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
      <p className="text-xs font-semibold uppercase tracking-wide text-stone">API key -- shown once</p>
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

function CreateApiKeyForm() {
  const [state, action, pending] = useActionState(createApiKeyAction, initialState);

  return (
    <form action={action} className="border border-grit bg-paper p-4">
      <h2 className="text-lg font-semibold text-graphite">Create an API key</h2>
      <label className="mt-3 grid gap-1 text-sm text-graphite sm:max-w-sm">
        Name
        <input name="name" required className="h-9 border border-grit bg-background px-2" placeholder="e.g. Reporting integration" />
      </label>
      <p className="mt-2 text-xs text-stone">Read-only. Every key can list and read active business objects and records in this workspace.</p>
      <button
        type="submit"
        disabled={pending}
        className="mt-4 h-10 border border-graphite bg-graphite px-4 text-sm font-medium text-chalk hover:bg-slab disabled:bg-chalk disabled:text-stone"
      >
        {pending ? "Creating..." : "Create key"}
      </button>
      <ActionMessage state={state} />
      {state.secret ? <SecretReveal secret={state.secret} /> : null}
    </form>
  );
}

// Always mounted for a given key, regardless of its revoked state -- the
// parent used to render this component only while !isRevoked, which meant
// the instant a revoke succeeded and the page revalidated with fresh
// server data, this component (and the useActionState confirmation message
// living inside it) unmounted in the same render, so "API key revoked."
// was never actually visible to the user. Keeping it mounted and moving
// the revoked check in here instead lets the confirmation persist: the
// button disappears, the message doesn't.
function RevokeButton({ apiKey }: { apiKey: ApiKey }) {
  const [state, action, pending] = useActionState(revokeApiKeyAction, initialState);
  const isRevoked = apiKey.revokedAt !== null;

  return (
    <form action={action}>
      <input type="hidden" name="keyId" value={apiKey.id} />
      {isRevoked ? null : (
        <button
          type="submit"
          disabled={pending}
          className="h-8 border border-graphite px-3 text-xs font-medium text-graphite hover:bg-slab hover:text-chalk disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Revoking..." : "Revoke"}
        </button>
      )}
      <ActionMessage state={state} />
    </form>
  );
}

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function ApiKeyRow({ apiKey }: { apiKey: ApiKey }) {
  const isRevoked = apiKey.revokedAt !== null;

  return (
    <li className="border border-grit bg-paper p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium text-graphite">
            {apiKey.name}
            {isRevoked ? <span className="ml-2 text-xs font-semibold uppercase text-red-700">Revoked</span> : null}
          </p>
          <p className="mt-1 text-xs text-stone">
            •••• {apiKey.keyPreview} · Scopes: {apiKey.scopes.join(", ")} · Created {formatTimestamp(apiKey.createdAt)} · Last used{" "}
            {formatTimestamp(apiKey.lastUsedAt)}
          </p>
        </div>
        <RevokeButton apiKey={apiKey} />
      </div>
    </li>
  );
}

export function ApiKeysPanel({ apiKeys }: { apiKeys: ApiKey[] }) {
  return (
    <div className="grid gap-6">
      <CreateApiKeyForm />
      {apiKeys.length === 0 ? (
        <p className="text-sm text-stone">No API keys yet.</p>
      ) : (
        <ul className="grid gap-2">
          {apiKeys.map((apiKey) => (
            <ApiKeyRow key={apiKey.id} apiKey={apiKey} />
          ))}
        </ul>
      )}
    </div>
  );
}
