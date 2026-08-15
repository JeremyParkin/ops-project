import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createFieldKey, createSlug, createUniqueSlug } from "./slug";
import type { EntityType, FieldDefinition, FieldType } from "./types";

type EntityTypeRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type FieldDefinitionRow = {
  id: string;
  workspace_id: string;
  entity_type_id: string;
  key: string;
  name: string;
  slug: string;
  type: FieldType;
  related_entity_type_id: string | null;
  required: boolean;
  position: number;
  created_at: string;
  updated_at: string;
};

type EntityContextInput = {
  workspaceId: string;
  entityTypeId: string;
};

type CreateEntityTypeWithFieldsInput = {
  workspaceId: string;
  name: string;
  description: string;
  fields: Array<{
    name: string;
    type: FieldType;
    relatedEntityTypeId: string;
    required: boolean;
  }>;
};

type CreateFieldDefinitionInput = {
  workspaceId: string;
  entityTypeId: string;
  name: string;
  type: FieldType;
  relatedEntityTypeId: string;
  required: boolean;
};

type UpdateFieldDefinitionInput = {
  workspaceId: string;
  entityTypeId: string;
  fieldDefinitionId: string;
  name: string;
  required: boolean;
};

type UpdateEntityTypeMetadataInput = {
  workspaceId: string;
  entityTypeId: string;
  name: string;
  description: string;
};

type EntityTypeLifecycleInput = EntityContextInput;

function mapEntityType(row: EntityTypeRow): EntityType {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFieldDefinition(row: FieldDefinitionRow): FieldDefinition {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    entityTypeId: row.entity_type_id,
    key: row.key,
    name: row.name,
    slug: row.slug,
    type: row.type,
    relatedEntityTypeId: row.related_entity_type_id ?? undefined,
    required: row.required,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getEntityContext({
  workspaceId,
  entityTypeId,
}: EntityContextInput) {
  const supabase = createServerSupabaseClient();

  const { data: entityTypeRow, error: entityTypeError } = await supabase
    .from("entity_types")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", entityTypeId)
    .single<EntityTypeRow>();

  if (entityTypeError) {
    throw new Error(`Unable to load entity type: ${entityTypeError.message}`);
  }

  const { data: fieldRows, error: fieldsError } = await supabase
    .from("field_definitions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .order("position", { ascending: true })
    .returns<FieldDefinitionRow[]>();

  if (fieldsError) {
    throw new Error(`Unable to load field definitions: ${fieldsError.message}`);
  }

  return {
    entityType: mapEntityType(entityTypeRow),
    fields: fieldRows.map(mapFieldDefinition),
  };
}

export async function listEntityTypes({
  workspaceId,
  includeArchived = false,
}: {
  workspaceId: string;
  includeArchived?: boolean;
}) {
  const supabase = createServerSupabaseClient();
  let query = supabase
    .from("entity_types")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (!includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query.returns<EntityTypeRow[]>();

  if (error) {
    throw new Error(`Unable to load entity types: ${error.message}`);
  }

  return data.map(mapEntityType);
}

async function createUniqueEntitySlug({
  workspaceId,
  entityTypeId,
  name,
}: {
  workspaceId: string;
  entityTypeId?: string;
  name: string;
}) {
  const existingEntityTypes = await listEntityTypes({
    workspaceId,
    includeArchived: true,
  });
  const existingSlugs = new Set(
    existingEntityTypes
      .filter((entityType) => entityType.id !== entityTypeId)
      .map((entityType) => entityType.slug),
  );

  return createUniqueSlug(createSlug(name, "entity"), existingSlugs);
}

function createUniqueFieldSlugs(fields: CreateEntityTypeWithFieldsInput["fields"]) {
  const slugs = new Set<string>();

  return fields.map((field, index) => {
    const baseSlug = createSlug(field.name, `field-${index + 1}`);
    const slug = createUniqueSlug(baseSlug, slugs);
    slugs.add(slug);

    return {
      ...field,
      slug,
      key: createFieldKey(),
      position: index + 1,
      related_entity_type_id:
        field.type === "relation" ? field.relatedEntityTypeId : null,
    };
  });
}

export async function createEntityTypeWithFields({
  workspaceId,
  name,
  description,
  fields,
}: CreateEntityTypeWithFieldsInput) {
  const supabase = createServerSupabaseClient();
  const entitySlug = await createUniqueEntitySlug({ workspaceId, name });
  const fieldPayload = createUniqueFieldSlugs(fields);

  const { data, error } = await supabase.rpc("create_entity_type_with_fields", {
    p_workspace_id: workspaceId,
    p_entity_name: name,
    p_entity_slug: entitySlug,
    p_entity_description: description,
    p_fields: fieldPayload,
  });

  if (error) {
    throw new Error(`Unable to create entity type: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to create entity type: unexpected RPC response.");
  }

  return data;
}

export async function createFieldDefinition({
  workspaceId,
  entityTypeId,
  name,
  type,
  relatedEntityTypeId,
  required,
}: CreateFieldDefinitionInput) {
  const supabase = createServerSupabaseClient();
  const { fields } = await getEntityContext({ workspaceId, entityTypeId });
  const existingSlugs = new Set(fields.map((field) => field.slug));
  const slug = createUniqueSlug(createSlug(name, "field"), existingSlugs);
  const { data, error } = await supabase.rpc("add_field_definition", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_name: name,
    p_slug: slug,
    p_key: createFieldKey(),
    p_type: type,
    p_required: required,
    p_related_entity_type_id:
      type === "relation" ? relatedEntityTypeId : null,
  });

  if (error) {
    throw new Error(`Unable to add field definition: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to add field definition: unexpected RPC response.");
  }

  return data;
}

export async function updateFieldDefinition({
  workspaceId,
  entityTypeId,
  fieldDefinitionId,
  name,
  required,
}: UpdateFieldDefinitionInput) {
  const supabase = createServerSupabaseClient();
  const { fields } = await getEntityContext({ workspaceId, entityTypeId });
  const currentField = fields.find((field) => field.id === fieldDefinitionId);

  if (!currentField) {
    throw new Error("Unable to update field definition: field not found.");
  }

  const existingSlugs = new Set(
    fields
      .filter((field) => field.id !== fieldDefinitionId)
      .map((field) => field.slug),
  );
  const slug = createUniqueSlug(createSlug(name, "field"), existingSlugs);
  const { data, error } = await supabase.rpc("update_field_definition", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_field_definition_id: fieldDefinitionId,
    p_name: name,
    p_slug: slug,
    p_required: required,
  });

  if (error) {
    throw new Error(`Unable to update field definition: ${error.message}`);
  }

  const resultRows = data as Array<{
    field_definition_id: string;
    violation_count: number;
  }> | null;
  const result = resultRows?.[0];

  if (!result) {
    throw new Error("Unable to update field definition: unexpected RPC response.");
  }

  return {
    fieldDefinitionId: result.field_definition_id,
    violationCount: result.violation_count,
  };
}

export async function updateEntityTypeMetadata({
  workspaceId,
  entityTypeId,
  name,
  description,
}: UpdateEntityTypeMetadataInput) {
  const supabase = createServerSupabaseClient();
  const slug = await createUniqueEntitySlug({
    workspaceId,
    entityTypeId,
    name,
  });
  const { data, error } = await supabase
    .from("entity_types")
    .update({
      name,
      slug,
      description: description || null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", entityTypeId)
    .select("*")
    .maybeSingle<EntityTypeRow>();

  if (error) {
    throw new Error(`Unable to update entity type: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to update entity type: entity not found.");
  }

  return mapEntityType(data);
}

export async function archiveEntityType({
  workspaceId,
  entityTypeId,
}: EntityTypeLifecycleInput) {
  const supabase = createServerSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("entity_types")
    .update({
      archived_at: now,
      updated_at: now,
    })
    .eq("workspace_id", workspaceId)
    .eq("id", entityTypeId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to archive entity type: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to archive entity type: entity not found.");
  }
}

export async function restoreEntityType({
  workspaceId,
  entityTypeId,
}: EntityTypeLifecycleInput) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("entity_types")
    .update({
      archived_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", entityTypeId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to restore entity type: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to restore entity type: entity not found.");
  }
}

export async function getEntityTypeRelationFieldSummary({
  workspaceId,
  entityTypeId,
}: EntityTypeLifecycleInput) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("field_definitions")
    .select("name, entity_type_id")
    .eq("workspace_id", workspaceId)
    .eq("related_entity_type_id", entityTypeId)
    .returns<Array<{ name: string; entity_type_id: string }>>();

  if (error) {
    throw new Error(`Unable to count relation field references: ${error.message}`);
  }

  if (data.length === 0) {
    return {
      total: 0,
      references: [] as Array<{
        entityTypeName: string;
        fieldName: string;
      }>,
    };
  }

  const entityTypes = await listEntityTypes({
    workspaceId,
    includeArchived: true,
  });
  const entityNameById = new Map(
    entityTypes.map((entityType) => [entityType.id, entityType.name]),
  );

  return {
    total: data.length,
    references: data.map((field) => ({
      entityTypeName: entityNameById.get(field.entity_type_id) ?? "Entity",
      fieldName: field.name,
    })),
  };
}

export async function deleteEntityType({
  workspaceId,
  entityTypeId,
}: EntityTypeLifecycleInput) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.rpc("delete_entity_type_if_safe", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
  });

  if (error) {
    throw new Error(`Unable to delete entity type: ${error.message}`);
  }

  const resultRows = data as Array<{
    deleted: boolean;
    record_count: number;
    relation_field_count: number;
  }> | null;
  const result = resultRows?.[0];

  if (!result) {
    throw new Error("Unable to delete entity type: unexpected RPC response.");
  }

  return {
    deleted: result.deleted,
    recordCount: result.record_count,
    relationFieldCount: result.relation_field_count,
  };
}
