import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createFieldKey, createSlug, createUniqueSlug } from "./slug";
import type { EntityType, FieldDefinition, FieldType } from "./types";
import {
  serializeStarterEntities,
  type StarterEntity,
} from "./workspace-onboarding";
import { listWorkflows } from "./workflow-repository";

type EntityTypeRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  display_field_definition_id: string | null;
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
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type EntityContextInput = {
  workspaceId: string;
  entityTypeId: string;
  includeArchivedFields?: boolean;
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

type FieldDefinitionLifecycleInput = {
  workspaceId: string;
  entityTypeId: string;
  fieldDefinitionId: string;
};

function mapEntityType(row: EntityTypeRow): EntityType {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? undefined,
    displayFieldDefinitionId: row.display_field_definition_id ?? undefined,
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
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getEntityContext({
  workspaceId,
  entityTypeId,
  includeArchivedFields = false,
}: EntityContextInput) {
  const supabase = await createServerSupabaseClient();

  const { data: entityTypeRow, error: entityTypeError } = await supabase
    .from("entity_types")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", entityTypeId)
    .single<EntityTypeRow>();

  if (entityTypeError) {
    throw new Error(`Unable to load entity type: ${entityTypeError.message}`);
  }

  let fieldsQuery = supabase
    .from("field_definitions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .order("position", { ascending: true });

  if (!includeArchivedFields) {
    fieldsQuery = fieldsQuery.is("archived_at", null);
  }

  const { data: fieldRows, error: fieldsError } =
    await fieldsQuery.returns<FieldDefinitionRow[]>();

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
  const supabase = await createServerSupabaseClient();
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
  const supabase = await createServerSupabaseClient();
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

export async function createEntityTypesWithFieldsAuthorized({
  workspaceId,
  entities,
}: {
  workspaceId: string;
  entities: StarterEntity[];
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "create_entity_types_with_fields_authorized",
    {
      p_workspace_id: workspaceId,
      p_entities: serializeStarterEntities(entities),
    },
  );

  if (error) {
    throw new Error(`Unable to create workspace structure: ${error.message}`);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Unable to create workspace structure: unexpected RPC response.");
  }

  return data as Record<string, string>;
}

export async function createFieldDefinition({
  workspaceId,
  entityTypeId,
  name,
  type,
  relatedEntityTypeId,
  required,
}: CreateFieldDefinitionInput) {
  const supabase = await createServerSupabaseClient();
  const { fields } = await getEntityContext({
    workspaceId,
    entityTypeId,
    includeArchivedFields: true,
  });
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
  const supabase = await createServerSupabaseClient();
  const { fields } = await getEntityContext({
    workspaceId,
    entityTypeId,
    includeArchivedFields: true,
  });
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

export async function archiveFieldDefinition({
  workspaceId,
  entityTypeId,
  fieldDefinitionId,
}: FieldDefinitionLifecycleInput) {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("field_definitions")
    .update({
      archived_at: now,
      updated_at: now,
    })
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .eq("id", fieldDefinitionId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to archive field definition: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to archive field definition: field not found.");
  }
}

export async function restoreFieldDefinition({
  workspaceId,
  entityTypeId,
  fieldDefinitionId,
}: FieldDefinitionLifecycleInput) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("field_definitions")
    .update({
      archived_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .eq("id", fieldDefinitionId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to restore field definition: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to restore field definition: field not found.");
  }
}

export async function deleteFieldDefinition({
  workspaceId,
  entityTypeId,
  fieldDefinitionId,
}: FieldDefinitionLifecycleInput) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "delete_field_definition_if_safe_authorized",
    {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_field_definition_id: fieldDefinitionId,
    },
  );

  if (error) {
    throw new Error(`Unable to delete field definition: ${error.message}`);
  }

  const resultRows = data as Array<{
    deleted: boolean;
    record_value_count: number;
    relation_value_count: number;
    workflow_reference_count: number;
    display_field_reference_count?: number;
    view_reference_count?: number;
    process_branch_reference_count?: number;
  }> | null;
  const result = resultRows?.[0];

  if (!result) {
    throw new Error("Unable to delete field definition: unexpected RPC response.");
  }

  return {
    deleted: result.deleted,
    recordValueCount: result.record_value_count,
    relationValueCount: result.relation_value_count,
    workflowReferenceCount: result.workflow_reference_count,
    displayFieldReferenceCount: result.display_field_reference_count ?? 0,
    viewReferenceCount: result.view_reference_count ?? 0,
    processBranchReferenceCount: result.process_branch_reference_count ?? 0,
  };
}

export async function updateEntityTypeMetadata({
  workspaceId,
  entityTypeId,
  name,
  description,
}: UpdateEntityTypeMetadataInput) {
  const supabase = await createServerSupabaseClient();
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

export async function setEntityDisplayField({
  workspaceId,
  entityTypeId,
  displayFieldDefinitionId,
}: {
  workspaceId: string;
  entityTypeId: string;
  displayFieldDefinitionId?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("set_entity_display_field", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_field_definition_id: displayFieldDefinitionId || null,
  });

  if (error) {
    throw new Error(`Unable to update display field: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to update display field: unexpected RPC response.");
  }

  return data;
}

export async function archiveEntityType({
  workspaceId,
  entityTypeId,
}: EntityTypeLifecycleInput) {
  const supabase = await createServerSupabaseClient();
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
  const supabase = await createServerSupabaseClient();
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
  const supabase = await createServerSupabaseClient();
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

export async function getEntityTypeWorkflowTargetSummary({
  workspaceId,
  entityTypeId,
}: EntityTypeLifecycleInput) {
  const workflows = await listWorkflows({ workspaceId });
  const references = workflows
    .filter((workflow) =>
      workflow.actions.some(
        (action) =>
          action.actionType === "create_record" &&
          action.actionTargetEntityTypeId === entityTypeId,
      ),
    )
    .map((workflow) => ({ workflowName: workflow.name }));

  return {
    total: references.length,
    references,
  };
}

export async function deleteEntityType({
  workspaceId,
  entityTypeId,
}: EntityTypeLifecycleInput) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("delete_entity_type_if_safe_authorized", {
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
    workflow_target_count: number;
    process_template_count: number;
  }> | null;
  const result = resultRows?.[0];

  if (!result) {
    throw new Error("Unable to delete entity type: unexpected RPC response.");
  }

  return {
    deleted: result.deleted,
    recordCount: result.record_count,
    relationFieldCount: result.relation_field_count,
    workflowTargetCount: result.workflow_target_count,
    processTemplateCount: result.process_template_count,
  };
}
