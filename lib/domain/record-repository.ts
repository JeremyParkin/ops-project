import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getEntityContext } from "./metadata-repository";
import type { EntityRecord, EntityType, FieldDefinition } from "./types";

type EntityRecordRow = {
  id: string;
  workspace_id: string;
  entity_type_id: string;
  values: EntityRecord["values"];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type ListEntityRecordsInput = {
  workspaceId: string;
  entityTypeId: EntityType["id"];
  fields: FieldDefinition[];
  includeArchived?: boolean;
};

type CreateEntityRecordInput = Pick<
  EntityRecord,
  "workspaceId" | "entityTypeId" | "values"
> & {
  fields: FieldDefinition[];
};

type GetEntityRecordInput = ListEntityRecordsInput & {
  recordId: string;
};

type UpdateEntityRecordInput = GetEntityRecordInput & {
  values: EntityRecord["values"];
};

type RelationValueRow = {
  source_record_id: string;
  field_definition_id: string;
  target_record_id: string;
};

export type RelationRecordOption = {
  value: string;
  label: string;
};

export type RelationOptionsByFieldKey = Record<string, RelationRecordOption[]>;
export type RelationLabelsByFieldKey = Record<string, Record<string, string>>;

export type RecordActionState = {
  success: boolean;
  message: string;
};

function mapEntityRecord(row: EntityRecordRow): EntityRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    entityTypeId: row.entity_type_id,
    values: row.values,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shortenRecordId(recordId: string) {
  return `${recordId.slice(0, 8)}...`;
}

function getFallbackDisplayField(fields: FieldDefinition[]) {
  return [...fields]
    .filter((field) => field.type === "text" && !field.archivedAt)
    .sort((left, right) => left.position - right.position)[0];
}

function getConfiguredDisplayField(
  entityType: EntityType,
  fields: FieldDefinition[],
) {
  if (!entityType.displayFieldDefinitionId) {
    return undefined;
  }

  return fields.find(
    (field) =>
      field.id === entityType.displayFieldDefinitionId &&
      field.type === "text" &&
      !field.archivedAt,
  );
}

export function getRecordLabel({
  entityType,
  fields,
  record,
}: {
  entityType: EntityType;
  fields: FieldDefinition[];
  record: EntityRecord;
}) {
  const configuredDisplayField = getConfiguredDisplayField(entityType, fields);
  const labelField = configuredDisplayField ?? getFallbackDisplayField(fields);

  if (!labelField) {
    return shortenRecordId(record.id);
  }

  const value = record.values[labelField.key];

  return typeof value === "string" && value.trim()
    ? value
    : shortenRecordId(record.id);
}

export function getRelationOptionLabel(
  entityType: EntityType,
  fields: FieldDefinition[],
  record: EntityRecord,
) {
  const label = getRecordLabel({ entityType, fields, record });

  return record.archivedAt ? `${label} (Archived)` : label;
}

export async function listEntityRecords({
  workspaceId,
  entityTypeId,
  fields,
  includeArchived = false,
}: ListEntityRecordsInput) {
  const supabase = createServerSupabaseClient();
  let query = supabase
    .from("entity_records")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .order("created_at", { ascending: true });

  if (!includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query.returns<EntityRecordRow[]>();

  if (error) {
    throw new Error(`Unable to load entity records: ${error.message}`);
  }

  const records = data.map(mapEntityRecord);
  const relationFields = fields.filter((field) => field.type === "relation");

  if (records.length === 0 || relationFields.length === 0) {
    return records;
  }

  const fieldKeyById = new Map(
    relationFields.map((field) => [field.id, field.key]),
  );
  const { data: relationRows, error: relationError } = await supabase
    .from("entity_record_relation_values")
    .select("source_record_id, field_definition_id, target_record_id")
    .eq("workspace_id", workspaceId)
    .eq("source_entity_type_id", entityTypeId)
    .in(
      "source_record_id",
      records.map((record) => record.id),
    )
    .returns<RelationValueRow[]>();

  if (relationError) {
    throw new Error(
      `Unable to load entity record relations: ${relationError.message}`,
    );
  }

  const recordById = new Map(records.map((record) => [record.id, record]));

  relationRows.forEach((relationRow) => {
    const record = recordById.get(relationRow.source_record_id);
    const fieldKey = fieldKeyById.get(relationRow.field_definition_id);

    if (record && fieldKey) {
      record.values[fieldKey] = relationRow.target_record_id;
    }
  });

  return records;
}

function splitRecordValues(fields: FieldDefinition[], values: EntityRecord["values"]) {
  const primitiveValues: EntityRecord["values"] = {};
  const relations: Array<{
    field_definition_id: string;
    target_entity_type_id: string;
    target_record_id: string;
  }> = [];
  const relationFieldIds: string[] = [];

  fields.forEach((field) => {
    const value = values[field.key];

    if (field.type === "relation") {
      relationFieldIds.push(field.id);

      if (
        value !== null &&
        value !== undefined &&
        typeof value === "string" &&
        field.relatedEntityTypeId
      ) {
        relations.push({
          field_definition_id: field.id,
          target_entity_type_id: field.relatedEntityTypeId,
          target_record_id: value,
        });
      }

      return;
    }

    primitiveValues[field.key] = value;
  });

  return {
    primitiveValues,
    relationFieldIds,
    relations,
  };
}

export async function createEntityRecord({
  workspaceId,
  entityTypeId,
  fields,
  values,
}: CreateEntityRecordInput) {
  const supabase = createServerSupabaseClient();
  const { primitiveValues, relations } = splitRecordValues(fields, values);
  const { data, error } = await supabase.rpc(
    "create_entity_record_with_relations",
    {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: primitiveValues,
      p_relations: relations,
    },
  );

  if (error) {
    throw new Error(`Unable to create entity record: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to create entity record: unexpected RPC response.");
  }

  return data;
}

export async function getEntityRecord({
  workspaceId,
  entityTypeId,
  recordId,
  fields,
}: GetEntityRecordInput) {
  const records = await listEntityRecords({
    workspaceId,
    entityTypeId,
    fields,
    includeArchived: true,
  });
  const record = records.find((candidate) => candidate.id === recordId);

  if (!record) {
    throw new Error("Unable to load entity record: record not found.");
  }

  return record;
}

export async function updateEntityRecord({
  workspaceId,
  entityTypeId,
  recordId,
  fields,
  values,
}: UpdateEntityRecordInput) {
  const supabase = createServerSupabaseClient();
  const { primitiveValues, relationFieldIds, relations } = splitRecordValues(
    fields,
    values,
  );
  const { data, error } = await supabase.rpc(
    "update_entity_record_with_relations",
    {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_id: recordId,
      p_values: primitiveValues,
      p_relation_field_ids: relationFieldIds,
      p_relations: relations,
    },
  );

  if (error) {
    throw new Error(`Unable to update entity record: ${error.message}`);
  }

  if (typeof data !== "string") {
    throw new Error("Unable to update entity record: unexpected RPC response.");
  }

  return data;
}

export async function entityRecordExists({
  workspaceId,
  entityTypeId,
  recordId,
  includeArchived = false,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  includeArchived?: boolean;
}) {
  const supabase = createServerSupabaseClient();
  let query = supabase
    .from("entity_records")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .eq("id", recordId);

  if (!includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query.maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to validate relation record: ${error.message}`);
  }

  return data !== null;
}

export async function countEntityRecords({
  workspaceId,
  entityTypeId,
}: {
  workspaceId: string;
  entityTypeId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { count, error } = await supabase
    .from("entity_records")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId);

  if (error) {
    throw new Error(`Unable to count entity records: ${error.message}`);
  }

  return count ?? 0;
}

export async function getRelationLookups({
  workspaceId,
  fields,
  currentRecord,
}: {
  workspaceId: string;
  fields: FieldDefinition[];
  currentRecord?: EntityRecord;
}) {
  const relationFields = fields.filter(
    (field) => field.type === "relation" && field.relatedEntityTypeId,
  );
  const targetEntityTypeIds = [
    ...new Set(
      relationFields
        .map((field) => field.relatedEntityTypeId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const targetData = new Map<
    string,
    {
      entityType: EntityType;
      fields: FieldDefinition[];
      records: EntityRecord[];
    }
  >();

  await Promise.all(
    targetEntityTypeIds.map(async (targetEntityTypeId) => {
      const { entityType: targetEntityType, fields: targetFields } =
        await getEntityContext({
        workspaceId,
        entityTypeId: targetEntityTypeId,
      });
      const targetRecords = await listEntityRecords({
        workspaceId,
        entityTypeId: targetEntityTypeId,
        fields: targetFields,
        includeArchived: true,
      });

      targetData.set(targetEntityTypeId, {
        entityType: targetEntityType,
        fields: targetFields,
        records: targetRecords,
      });
    }),
  );

  const optionsByFieldKey: RelationOptionsByFieldKey = {};
  const labelsByFieldKey: RelationLabelsByFieldKey = {};

  relationFields.forEach((field) => {
    if (!field.relatedEntityTypeId) {
      return;
    }

    const data = targetData.get(field.relatedEntityTypeId);

    if (!data) {
      optionsByFieldKey[field.key] = [];
      labelsByFieldKey[field.key] = {};
      return;
    }

    const records = data?.records ?? [];
    const activeOptions =
        records.filter((record) => !record.archivedAt).map((record) => {
        return {
          value: record.id,
          label: getRelationOptionLabel(data.entityType, data.fields, record),
        };
      });
    const currentValue = currentRecord?.values[field.key];
    const currentRecordOption =
      typeof currentValue === "string"
        ? records.find((record) => record.id === currentValue)
        : undefined;
    const options =
      currentRecordOption?.archivedAt &&
      !activeOptions.some((option) => option.value === currentRecordOption.id)
        ? [
            ...activeOptions,
            {
              value: currentRecordOption.id,
              label: getRelationOptionLabel(
                data.entityType,
                data.fields,
                currentRecordOption,
              ),
            },
          ]
        : activeOptions;

    optionsByFieldKey[field.key] = options;
    labelsByFieldKey[field.key] = Object.fromEntries(
      records.map((record) => [
        record.id,
        getRelationOptionLabel(data.entityType, data.fields, record),
      ]),
    );
  });

  return {
    optionsByFieldKey,
    labelsByFieldKey,
  };
}

export async function archiveEntityRecord({
  workspaceId,
  entityTypeId,
  recordId,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
}) {
  const supabase = createServerSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("entity_records")
    .update({
      archived_at: now,
      updated_at: now,
    })
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .eq("id", recordId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to archive entity record: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to archive entity record: record not found.");
  }
}

export async function restoreEntityRecord({
  workspaceId,
  entityTypeId,
  recordId,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("entity_records")
    .update({
      archived_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .eq("id", recordId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to restore entity record: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to restore entity record: record not found.");
  }
}

export async function getIncomingReferenceSummary({
  workspaceId,
  entityTypeId,
  recordId,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("entity_record_relation_values")
    .select("source_entity_type_id")
    .eq("workspace_id", workspaceId)
    .eq("target_entity_type_id", entityTypeId)
    .eq("target_record_id", recordId)
    .returns<Array<{ source_entity_type_id: string }>>();

  if (error) {
    throw new Error(`Unable to count incoming references: ${error.message}`);
  }

  if (data.length === 0) {
    return {
      total: 0,
      groups: [] as Array<{ entityTypeName: string; count: number }>,
    };
  }

  const entityTypes = await Promise.all(
    [...new Set(data.map((row) => row.source_entity_type_id))].map(
      async (sourceEntityTypeId) => {
        const { entityType } = await getEntityContext({
          workspaceId,
          entityTypeId: sourceEntityTypeId,
        });

        return entityType;
      },
    ),
  );
  const nameById = new Map(
    entityTypes.map((entityType) => [entityType.id, entityType.name]),
  );
  const countByEntityTypeId = new Map<string, number>();

  data.forEach((row) => {
    countByEntityTypeId.set(
      row.source_entity_type_id,
      (countByEntityTypeId.get(row.source_entity_type_id) ?? 0) + 1,
    );
  });

  return {
    total: data.length,
    groups: [...countByEntityTypeId].map(([sourceEntityTypeId, count]) => ({
      entityTypeName: nameById.get(sourceEntityTypeId) ?? "record",
      count,
    })),
  };
}

export async function deleteEntityRecord({
  workspaceId,
  entityTypeId,
  recordId,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
}) {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "delete_entity_record_if_unreferenced",
    {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_id: recordId,
    },
  );

  if (error) {
    throw new Error(`Unable to delete entity record: ${error.message}`);
  }

  const resultRows = data as Array<{
    deleted: boolean;
    reference_count: number;
  }> | null;
  const result = resultRows?.[0];

  if (!result) {
    throw new Error("Unable to delete entity record: unexpected RPC response.");
  }

  return {
    deleted: result.deleted,
    referenceCount: result.reference_count,
  };
}
