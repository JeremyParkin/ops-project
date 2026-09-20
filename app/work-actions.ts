"use server";

import { revalidatePath } from "next/cache";
import type { EntityTypeActionState } from "@/app/actions";
import { getEntityContext } from "@/lib/domain/metadata-repository";
import {
  setEntityTypeWorkEnabled,
  setEntityTypeWorkMapping,
} from "@/lib/domain/work-repository";

type EntityTypeContext = {
  workspaceId: string;
  entityTypeId: string;
};

// One builder-facing action covering both "save" and "save and activate" --
// the backend still calls the mapping and enable RPCs separately (see
// lib/domain/work-repository.ts; disabling must never be able to touch the
// mapping, so those two RPCs stay independent), but a builder should not
// have to understand that split to get from "nothing configured" to
// "working" in one deliberate click. Activating is never implicit: it only
// happens when the caller explicitly submits intent=activate, never as a
// side effect of merely saving a mapping.
export async function saveEntityTypeWorkConfiguration(
  context: EntityTypeContext,
  _previousState: EntityTypeActionState,
  formData: FormData,
): Promise<EntityTypeActionState> {
  const { entityType } = await getEntityContext(context);

  if (entityType.archivedAt) {
    return {
      success: false,
      message: "Archived entities are read-only. Restore this entity before editing settings.",
    };
  }

  const activate = formData.get("intent") === "activate";
  const assignmentFieldId = (formData.get("assignmentFieldId") as string | null) || null;
  const dueFieldId = (formData.get("dueFieldId") as string | null) || null;
  const statusFieldId = (formData.get("statusFieldId") as string | null) || null;
  const completionOptionIds = formData.getAll("completionOptionIds") as string[];

  // Belt-and-suspenders: the form already disables the activate control
  // client-side without a chosen assignment field, but the server is the
  // one that actually enforces it -- a truthful rejection, not the RPC's
  // own generic exception text, since the missing field is knowable here
  // before ever calling either RPC.
  if (activate && !assignmentFieldId) {
    return {
      success: false,
      message: "Choose who is responsible for this work before activating.",
    };
  }

  try {
    await setEntityTypeWorkMapping({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      assignmentFieldId,
      dueFieldId,
      statusFieldId,
      completionOptionIds,
    });
  } catch (error) {
    // Surfaced verbatim -- the RPC's own messages are already specific and
    // truthful (wrong field type, cross-EntityType field, an option that
    // doesn't belong to the chosen status field). Never replaced with a
    // generic "please try again."
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to save Work Settings.",
    };
  }

  if (!activate) {
    revalidatePath(`/entities/${context.entityTypeId}`);
    return {
      success: true,
      message: "Configuration saved. Not active yet -- activate below when you're ready.",
    };
  }

  try {
    await setEntityTypeWorkEnabled({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      enabled: true,
    });
  } catch (error) {
    // The mapping save above already succeeded and is not rolled back --
    // that is a true, safe "configured, not active" state, so this failure
    // is reported as an activation-specific problem, not a lost edit.
    revalidatePath(`/entities/${context.entityTypeId}`);
    return {
      success: false,
      message: `Configuration saved, but activation failed: ${
        error instanceof Error ? error.message : "unable to activate."
      }`,
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: "Saved and activated. Records assigned through this field now appear in My Work.",
  };
}

// Deactivation only -- no mapping parameters at all, so it can never
// rewrite or clear the mapping regardless of what the form happens to
// contain. Kept as its own action/RPC pair deliberately (see
// lib/domain/work-repository.ts).
export async function deactivateEntityTypeWork(
  context: EntityTypeContext,
  previousState: EntityTypeActionState,
  formData: FormData,
): Promise<EntityTypeActionState> {
  void previousState;
  void formData;

  const { entityType } = await getEntityContext(context);

  if (entityType.archivedAt) {
    return {
      success: false,
      message: "Archived entities are read-only. Restore this entity before editing settings.",
    };
  }

  try {
    await setEntityTypeWorkEnabled({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      enabled: false,
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to update Work Settings.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: "Work turned off. The configuration is preserved -- turn it back on anytime.",
  };
}
