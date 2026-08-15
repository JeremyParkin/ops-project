"use client";

import { useActionState } from "react";
import type {
  EntityMetadataFormState,
} from "@/lib/domain/entity-metadata-validation";
import {
  createInitialEntityMetadataFormState,
} from "@/lib/domain/entity-metadata-validation";
import type { EntityType } from "@/lib/domain/types";
import type { EntityTypeActionState } from "@/app/actions";

type EntitySettingsFormProps = {
  entityType: EntityType;
  updateEntityMetadataAction: (
    state: EntityMetadataFormState,
    formData: FormData,
  ) => Promise<EntityMetadataFormState>;
  archiveEntityAction: (
    state: EntityTypeActionState,
    formData: FormData,
  ) => Promise<EntityTypeActionState>;
  restoreEntityAction: (
    state: EntityTypeActionState,
    formData: FormData,
  ) => Promise<EntityTypeActionState>;
  deleteEntityAction: (
    state: EntityTypeActionState,
    formData: FormData,
  ) => Promise<EntityTypeActionState>;
};

const initialActionState: EntityTypeActionState = {
  success: false,
  message: "",
};

function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="mt-1 text-sm text-red-700" role="alert">
      {message}
    </p>
  );
}

export function EntitySettingsForm({
  entityType,
  updateEntityMetadataAction,
  archiveEntityAction,
  restoreEntityAction,
  deleteEntityAction,
}: EntitySettingsFormProps) {
  const isArchived = Boolean(entityType.archivedAt);
  const [metadataState, metadataAction, metadataPending] = useActionState(
    updateEntityMetadataAction,
    createInitialEntityMetadataFormState({
      name: entityType.name,
      description: entityType.description ?? "",
    }),
  );
  const [archiveState, archiveAction, archivePending] = useActionState(
    archiveEntityAction,
    initialActionState,
  );
  const [restoreState, restoreAction, restorePending] = useActionState(
    restoreEntityAction,
    initialActionState,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteEntityAction,
    initialActionState,
  );
  const lifecycleMessage =
    deleteState.message || restoreState.message || archiveState.message;
  const lifecycleSuccess =
    deleteState.message ? deleteState.success : restoreState.message
      ? restoreState.success
      : archiveState.success;

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold text-slate-950">
            Entity Settings
          </h2>
          {isArchived ? (
            <span className="border border-slate-300 px-2 py-1 text-xs font-medium uppercase tracking-wide text-slate-500">
              Archived
            </span>
          ) : null}
        </div>
        {isArchived ? (
          <p className="mt-2 text-sm text-slate-600">
            Archived entities are read-only until restored.
          </p>
        ) : null}
      </div>

      <form action={metadataAction} className="grid gap-4 md:grid-cols-2">
        <div>
          <label
            htmlFor="entitySettingsName"
            className="block text-sm font-medium text-slate-800"
          >
            Name
          </label>
          <input
            id="entitySettingsName"
            name="entityName"
            required
            disabled={isArchived}
            defaultValue={metadataState.values.name}
            className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
          />
          <FieldError message={metadataState.errors.entityName} />
        </div>

        <div>
          <label
            htmlFor="entitySettingsDescription"
            className="block text-sm font-medium text-slate-800"
          >
            Description
          </label>
          <input
            id="entitySettingsDescription"
            name="entityDescription"
            disabled={isArchived}
            defaultValue={metadataState.values.description}
            className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
          />
        </div>

        {!isArchived ? (
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={metadataPending}
              className="inline-flex h-10 items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {metadataPending ? "Saving..." : "Save Entity"}
            </button>
          </div>
        ) : null}
        <div className="md:col-span-2">
          {metadataState.message ? (
            <p
              className={`text-sm ${
                metadataState.success ? "text-emerald-700" : "text-red-700"
              }`}
              role="status"
            >
              {metadataState.message}
            </p>
          ) : null}
          <FieldError message={metadataState.errors._form} />
        </div>
      </form>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
        {isArchived ? (
          <form action={restoreAction}>
            <button
              type="submit"
              disabled={restorePending}
              className="inline-flex h-10 items-center justify-center border border-slate-950 px-4 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
            >
              {restorePending ? "Restoring..." : "Restore Entity"}
            </button>
          </form>
        ) : (
          <form action={archiveAction}>
            <button
              type="submit"
              disabled={archivePending}
              className="inline-flex h-10 items-center justify-center border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {archivePending ? "Archiving..." : "Archive Entity"}
            </button>
          </form>
        )}

        <form
          action={deleteAction}
          onSubmit={(event) => {
            if (
              !window.confirm(
                "Delete this entity permanently? This is only allowed when it has no records or relation fields pointing to it.",
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <button
            type="submit"
            disabled={deletePending}
            className="inline-flex h-10 items-center justify-center border border-red-300 px-4 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-red-300"
          >
            {deletePending ? "Deleting..." : "Delete Entity"}
          </button>
        </form>

        {lifecycleMessage ? (
          <p
            className={`text-sm ${
              lifecycleSuccess ? "text-emerald-700" : "text-red-700"
            }`}
            role="status"
          >
            {lifecycleMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
