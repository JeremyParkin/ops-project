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

// Writes the mapping only -- never enabled. Kept in its own file (not
// app/actions.ts, already large) mirroring the existing app/process-
// actions.ts precedent for a bounded, separately-reviewable concern.
export async function updateEntityTypeWorkMapping(
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

  const assignmentFieldId = (formData.get("assignmentFieldId") as string | null) || null;
  const dueFieldId = (formData.get("dueFieldId") as string | null) || null;
  const statusFieldId = (formData.get("statusFieldId") as string | null) || null;
  const completionOptionIds = formData.getAll("completionOptionIds") as string[];

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

  revalidatePath(`/entities/${context.entityTypeId}`);

  return { success: true, message: "Work Settings mapping saved." };
}

// Writes only work_enabled. No mapping parameters at all -- see
// lib/domain/work-repository.ts for why this stays a separate action.
export async function updateEntityTypeWorkEnabled(
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

  const enabled = formData.get("enabled") === "true";

  try {
    await setEntityTypeWorkEnabled({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      enabled,
    });
  } catch (error) {
    // Surfaced verbatim -- re-enable rejections (a stale/invalid mapping)
    // are truthful RPC messages, never a generic failure or an attempt at
    // silent UI repair.
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to update Work Settings.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: enabled ? "Work enabled." : "Work disabled. The mapping is preserved.",
  };
}
