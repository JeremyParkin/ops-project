import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { FieldDefinition } from "./types";
import type { EntityView, ViewFilter, ViewSort } from "./view-types";

type EntityViewRow = {
  id: string;
  workspace_id: string;
  entity_type_id: string;
  name: string;
  position: number;
  is_default: boolean;
  filters: unknown;
  sorts: unknown;
  column_field_definition_ids: unknown;
  created_at: string;
  updated_at: string;
};

type ViewMutationInput = {
  workspaceId: string;
  entityTypeId: string;
  viewId?: string;
  name: string;
  filters: ViewFilter[];
  sorts: ViewSort[];
  columnFieldDefinitionIds: FieldDefinition["id"][];
  isDefault: boolean;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mapEntityView(row: EntityViewRow): EntityView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    entityTypeId: row.entity_type_id,
    name: row.name,
    position: row.position,
    isDefault: row.is_default,
    filters: asArray<ViewFilter>(row.filters),
    sorts: asArray<ViewSort>(row.sorts),
    columnFieldDefinitionIds: asArray<string>(row.column_field_definition_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listEntityViews({
  workspaceId,
  entityTypeId,
}: {
  workspaceId: string;
  entityTypeId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("entity_views")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .order("position", { ascending: true })
    .returns<EntityViewRow[]>();

  if (error) {
    throw new Error(`Unable to load entity views: ${error.message}`);
  }

  return data.map(mapEntityView);
}

export async function listWorkspaceEntityViews({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("entity_views")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("position", { ascending: true })
    .returns<EntityViewRow[]>();

  if (error) {
    throw new Error(`Unable to load workspace entity views: ${error.message}`);
  }

  return data.map(mapEntityView);
}

export async function createEntityView({
  workspaceId,
  entityTypeId,
  name,
  filters,
  sorts,
  columnFieldDefinitionIds,
  isDefault,
}: ViewMutationInput) {
  const supabase = createServerSupabaseClient();
  const { data: views, error: viewsError } = await supabase
    .from("entity_views")
    .select("position")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .returns<Array<{ position: number }>>();

  if (viewsError) {
    throw new Error(`Unable to inspect entity views: ${viewsError.message}`);
  }

  const nextPosition =
    views.reduce((max, view) => Math.max(max, view.position), 0) + 1;
  const { data, error } = await supabase
    .from("entity_views")
    .insert({
      workspace_id: workspaceId,
      entity_type_id: entityTypeId,
      name,
      position: nextPosition,
      is_default: false,
      filters,
      sorts,
      column_field_definition_ids: columnFieldDefinitionIds,
    })
    .select("*")
    .single<EntityViewRow>();

  if (error) {
    throw new Error(`Unable to create entity view: ${error.message}`);
  }

  if (isDefault) {
    await setEntityDefaultView({
      workspaceId,
      entityTypeId,
      viewId: data.id,
    });
  }

  return mapEntityView({
    ...data,
    is_default: isDefault,
  });
}

export async function updateEntityView({
  workspaceId,
  entityTypeId,
  viewId,
  name,
  filters,
  sorts,
  columnFieldDefinitionIds,
  isDefault,
}: ViewMutationInput) {
  if (!viewId) {
    throw new Error("Unable to update entity view: view ID missing.");
  }

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("entity_views")
    .update({
      name,
      filters,
      sorts,
      column_field_definition_ids: columnFieldDefinitionIds,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .eq("id", viewId)
    .select("*")
    .single<EntityViewRow>();

  if (error) {
    throw new Error(`Unable to update entity view: ${error.message}`);
  }

  await setEntityDefaultView({
    workspaceId,
    entityTypeId,
    viewId: isDefault ? viewId : undefined,
  });

  return mapEntityView({
    ...data,
    is_default: isDefault,
  });
}

export async function deleteEntityView({
  workspaceId,
  entityTypeId,
  viewId,
}: {
  workspaceId: string;
  entityTypeId: string;
  viewId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from("entity_views")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .eq("id", viewId);

  if (error) {
    throw new Error(`Unable to delete entity view: ${error.message}`);
  }
}

export async function setEntityDefaultView({
  workspaceId,
  entityTypeId,
  viewId,
}: {
  workspaceId: string;
  entityTypeId: string;
  viewId?: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.rpc("set_entity_default_view", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_view_id: viewId ?? null,
  });

  if (error) {
    throw new Error(`Unable to update default view: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to update default view: unexpected RPC response.");
  }
}

export function viewReferencesField(view: EntityView, fieldDefinitionId: string) {
  return (
    view.filters.some((filter) => filter.fieldDefinitionId === fieldDefinitionId) ||
    view.sorts.some((sort) => sort.fieldDefinitionId === fieldDefinitionId) ||
    view.columnFieldDefinitionIds.includes(fieldDefinitionId)
  );
}

export function countViewReferencesByFieldId({
  views,
  fieldDefinitionIds,
}: {
  views: EntityView[];
  fieldDefinitionIds: string[];
}) {
  return Object.fromEntries(
    fieldDefinitionIds.map((fieldDefinitionId) => [
      fieldDefinitionId,
      views.filter((view) => viewReferencesField(view, fieldDefinitionId)).length,
    ]),
  );
}
