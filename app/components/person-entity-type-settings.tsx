"use client";

import { useActionState } from "react";
import { setPersonEntityTypeAction, type WorkspaceSettingsActionState } from "@/app/workspace-settings-actions";
import { SectionHeader } from "@/app/components/page-primitives";
import type { EntityType } from "@/lib/domain/types";

const initialState: WorkspaceSettingsActionState = { success: false, message: "" };

// Phase 12.1: designates the single workspace-level "Person" EntityType --
// the only entity type eligible for an identity link (see
// PersonIdentitySection on record detail). Blocked server-side while any
// link exists, so this control never needs its own confirmation step: the
// RPC itself is the safety net.
export function PersonEntityTypeSettings({
  entityTypes,
  currentEntityTypeId,
}: {
  entityTypes: EntityType[];
  currentEntityTypeId: string | null;
}) {
  const [state, formAction, pending] = useActionState(setPersonEntityTypeAction, initialState);

  return (
    <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
      <SectionHeader
        title="Person type"
        description="The one business object type that represents a team member. Only records of this type can be linked to a workspace member's login identity."
      />
      <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Entity type
          <select
            name="entityTypeId"
            defaultValue={currentEntityTypeId ?? ""}
            className="h-9 w-72 border border-grit bg-white px-2 text-sm text-graphite"
          >
            <option value="">None</option>
            {entityTypes.map((entityType) => (
              <option key={entityType.id} value={entityType.id}>
                {entityType.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="h-9 bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </form>
      {state.message ? (
        <p
          className={`mt-2 text-sm ${state.success ? "text-status-sage" : "text-red-700"}`}
          role={state.success ? "status" : "alert"}
        >
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
