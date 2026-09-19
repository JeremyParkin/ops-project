import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";
import type { ChoiceOption, ChoiceOptionsByFieldId, FieldDefinition } from "./types";

type ChoiceOptionRow = {
  id: string;
  workspace_id: string;
  field_definition_id: string;
  label: string;
  color: string | null;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function mapChoiceOption(row: ChoiceOptionRow): ChoiceOption {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fieldDefinitionId: row.field_definition_id,
    label: row.label,
    color: row.color ?? undefined,
    position: row.position,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Fetches options for every given field definition in one query, grouped
// by field id -- mirrors how relation option/label lookups are fetched
// once alongside a field list rather than per-field.
export async function listChoiceOptionsByFieldIds({
  workspaceId,
  fieldDefinitionIds,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  fieldDefinitionIds: FieldDefinition["id"][];
  supabase?: SupabaseServerClient;
}): Promise<ChoiceOptionsByFieldId> {
  if (fieldDefinitionIds.length === 0) {
    return {};
  }

  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase
    .from("field_choice_options")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("field_definition_id", fieldDefinitionIds)
    .order("position", { ascending: true })
    .returns<ChoiceOptionRow[]>();

  if (error) {
    throw new Error(`Unable to load choice options: ${error.message}`);
  }

  const byFieldId: ChoiceOptionsByFieldId = {};

  for (const row of data) {
    const option = mapChoiceOption(row);
    (byFieldId[option.fieldDefinitionId] ??= []).push(option);
  }

  return byFieldId;
}

export async function listChoiceOptions({
  workspaceId,
  fieldDefinitionId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  fieldDefinitionId: string;
  supabase?: SupabaseServerClient;
}): Promise<ChoiceOption[]> {
  const byFieldId = await listChoiceOptionsByFieldIds({
    workspaceId,
    fieldDefinitionIds: [fieldDefinitionId],
    supabase: injectedSupabase,
  });

  return byFieldId[fieldDefinitionId] ?? [];
}

export async function choiceOptionExists({
  workspaceId,
  fieldDefinitionId,
  optionId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  fieldDefinitionId: string;
  optionId: string;
  supabase?: SupabaseServerClient;
}): Promise<boolean> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase
    .from("field_choice_options")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("field_definition_id", fieldDefinitionId)
    .eq("id", optionId)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to look up choice option: ${error.message}`);
  }

  return Boolean(data);
}

export async function addChoiceOption({
  workspaceId,
  fieldDefinitionId,
  label,
  color,
}: {
  workspaceId: string;
  fieldDefinitionId: string;
  label: string;
  color?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("add_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldDefinitionId,
    p_label: label,
    p_color: color ?? null,
  });

  if (error) {
    throw new Error(`Unable to add choice option: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to add choice option: unexpected RPC response.");
  }

  return data;
}

export async function updateChoiceOption({
  workspaceId,
  fieldDefinitionId,
  optionId,
  label,
  color,
}: {
  workspaceId: string;
  fieldDefinitionId: string;
  optionId: string;
  label: string;
  color?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldDefinitionId,
    p_option_id: optionId,
    p_label: label,
    p_color: color ?? null,
  });

  if (error) {
    throw new Error(`Unable to update choice option: ${error.message}`);
  }
}

export async function archiveChoiceOption({
  workspaceId,
  fieldDefinitionId,
  optionId,
}: {
  workspaceId: string;
  fieldDefinitionId: string;
  optionId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("archive_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldDefinitionId,
    p_option_id: optionId,
  });

  if (error) {
    throw new Error(`Unable to archive choice option: ${error.message}`);
  }
}

export async function restoreChoiceOption({
  workspaceId,
  fieldDefinitionId,
  optionId,
}: {
  workspaceId: string;
  fieldDefinitionId: string;
  optionId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("restore_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldDefinitionId,
    p_option_id: optionId,
  });

  if (error) {
    throw new Error(`Unable to restore choice option: ${error.message}`);
  }
}

export type ChoiceOptionDeleteResult = {
  deleted: boolean;
  recordValueCount: number;
  viewReferenceCount: number;
  qualityReviewReferenceCount: number;
};

// Permanent deletion, archive-first: the RPC itself refuses an option
// that is not already archived (not just this repository/the app action),
// and refuses one that is still referenced by record values, a saved-view
// filter, or a Quality Review draft/finalized designation -- returning a
// truthful count for each rather than a generic rejection.
export async function deleteChoiceOption({
  workspaceId,
  fieldDefinitionId,
  optionId,
}: {
  workspaceId: string;
  fieldDefinitionId: string;
  optionId: string;
}): Promise<ChoiceOptionDeleteResult> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "delete_field_choice_option_if_safe_authorized",
    {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldDefinitionId,
      p_option_id: optionId,
    },
  );

  if (error) {
    throw new Error(`Unable to delete choice option: ${error.message}`);
  }

  const resultRows = data as Array<{
    deleted: boolean;
    record_value_count: number;
    view_reference_count: number;
    quality_review_reference_count: number;
  }> | null;
  const result = resultRows?.[0];

  if (!result) {
    throw new Error("Unable to delete choice option: unexpected RPC response.");
  }

  return {
    deleted: result.deleted,
    recordValueCount: result.record_value_count,
    viewReferenceCount: result.view_reference_count,
    qualityReviewReferenceCount: result.quality_review_reference_count,
  };
}

export async function swapChoiceOptionPositions({
  workspaceId,
  fieldDefinitionId,
  firstOptionId,
  secondOptionId,
}: {
  workspaceId: string;
  fieldDefinitionId: string;
  firstOptionId: string;
  secondOptionId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("swap_field_choice_option_positions", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldDefinitionId,
    p_first_option_id: firstOptionId,
    p_second_option_id: secondOptionId,
  });

  if (error) {
    throw new Error(`Unable to reorder choice options: ${error.message}`);
  }
}
