import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";
import { getEntityContext, listEntityTypes } from "./metadata-repository";
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

type FieldDefinitionRow = {
  id: string;
  workspace_id: string;
  entity_type_id: string;
  key: string;
  name: string;
  slug: string;
  type: FieldDefinition["type"];
  related_entity_type_id: string | null;
  required: boolean;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type ListEntityRecordsInput = {
  workspaceId: string;
  entityTypeId: EntityType["id"];
  fields: FieldDefinition[];
  includeArchived?: boolean;
  supabase?: SupabaseServerClient;
};

type CreateEntityRecordInput = Pick<
  EntityRecord,
  "workspaceId" | "entityTypeId" | "values"
> & {
  fields: FieldDefinition[];
  supabase?: SupabaseServerClient;
  // Set only by process action-node execution: a durable identity that lets
  // a retry after a crashed/uncommitted completion reuse the record a prior
  // attempt already created, instead of creating a duplicate.
  originatingProcessStepRunId?: string;
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

export type IncomingRelationGroup = {
  sourceEntityType: EntityType;
  sourceFields: FieldDefinition[];
  relationField: FieldDefinition;
  records: EntityRecord[];
};

export type WorkspaceRecordSearchResult = {
  record: EntityRecord;
  label: string;
  matchedFieldName?: string;
};

export type WorkspaceRecordSearchGroup = {
  entityType: EntityType;
  results: WorkspaceRecordSearchResult[];
};

export async function countActiveEntityRecordsByEntityType({
  workspaceId,
  entityTypeIds,
}: {
  workspaceId: string;
  entityTypeIds: string[];
}) {
  if (entityTypeIds.length === 0) return new Map<string, number>();

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("entity_records")
    .select("entity_type_id")
    .eq("workspace_id", workspaceId)
    .in("entity_type_id", entityTypeIds)
    .is("archived_at", null);

  if (error) {
    throw new Error(`Unable to count entity records: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    counts.set(row.entity_type_id, (counts.get(row.entity_type_id) ?? 0) + 1);
  }

  return counts;
}

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

export function getRecordIdentityField({
  entityType,
  fields,
}: {
  entityType: EntityType;
  fields: FieldDefinition[];
}) {
  return getConfiguredDisplayField(entityType, fields) ?? getFallbackDisplayField(fields);
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
  const labelField = getRecordIdentityField({ entityType, fields });

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

const WORKSPACE_SEARCH_RESULTS_PER_ENTITY = 20;

export async function searchWorkspaceRecords({
  workspaceId,
  query,
}: {
  workspaceId: string;
  query: string;
}): Promise<WorkspaceRecordSearchGroup[]> {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const entityTypes = await listEntityTypes({ workspaceId });

  if (entityTypes.length === 0) {
    return [];
  }

  const supabase = await createServerSupabaseClient();
  const entityTypeIds = entityTypes.map((entityType) => entityType.id);
  const [{ data: fieldRows, error: fieldError }, { data: recordRows, error: recordError }] =
    await Promise.all([
      supabase
        .from("field_definitions")
        .select("*")
        .eq("workspace_id", workspaceId)
        .is("archived_at", null)
        .eq("type", "text")
        .in("entity_type_id", entityTypeIds)
        .returns<FieldDefinitionRow[]>(),
      supabase
        .from("entity_records")
        .select("*")
        .eq("workspace_id", workspaceId)
        .is("archived_at", null)
        .in("entity_type_id", entityTypeIds)
        .returns<EntityRecordRow[]>(),
    ]);

  if (fieldError) {
    throw new Error(`Unable to load searchable fields: ${fieldError.message}`);
  }

  if (recordError) {
    throw new Error(`Unable to load searchable records: ${recordError.message}`);
  }

  const fieldsByEntityTypeId = new Map<string, FieldDefinition[]>();

  fieldRows.map(mapFieldDefinition).forEach((field) => {
    const fields = fieldsByEntityTypeId.get(field.entityTypeId) ?? [];
    fields.push(field);
    fieldsByEntityTypeId.set(field.entityTypeId, fields);
  });

  const recordsByEntityTypeId = new Map<string, EntityRecord[]>();

  recordRows.map(mapEntityRecord).forEach((record) => {
    const records = recordsByEntityTypeId.get(record.entityTypeId) ?? [];
    records.push(record);
    recordsByEntityTypeId.set(record.entityTypeId, records);
  });

  return [...entityTypes]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .flatMap((entityType) => {
      const fields = (fieldsByEntityTypeId.get(entityType.id) ?? []).sort(
        (left, right) => left.position - right.position || left.id.localeCompare(right.id),
      );
      const identityField = getRecordIdentityField({ entityType, fields });

      if (fields.length === 0) {
        return [];
      }

      const results = (recordsByEntityTypeId.get(entityType.id) ?? [])
        .flatMap((record) => {
          const matches = fields
            .flatMap((field) => {
              const value = record.values[field.key];

              if (typeof value !== "string") {
                return [];
              }

              const normalizedValue = value.toLocaleLowerCase();

              if (!normalizedValue.includes(normalizedQuery)) {
                return [];
              }

              return [{ field, isPrefixMatch: normalizedValue.startsWith(normalizedQuery) }];
            })
            .sort(
              (left, right) =>
                Number(left.field.id !== identityField?.id) -
                  Number(right.field.id !== identityField?.id) ||
                Number(!left.isPrefixMatch) - Number(!right.isPrefixMatch) ||
                left.field.position - right.field.position ||
                left.field.id.localeCompare(right.field.id),
            );

          const match = matches[0];

          if (!match) {
            return [];
          }

          return [
            {
              record,
              label: getRecordLabel({ entityType, fields, record }),
              matchedFieldName:
                match.field.id === identityField?.id ? undefined : match.field.name,
              isIdentityMatch: match.field.id === identityField?.id,
              isPrefixMatch: match.isPrefixMatch,
              matchPosition: match.field.position,
            },
          ];
        })
        .sort(
          (left, right) =>
            Number(!left.isIdentityMatch) - Number(!right.isIdentityMatch) ||
            Number(!left.isPrefixMatch) - Number(!right.isPrefixMatch) ||
            left.matchPosition - right.matchPosition ||
            left.label.localeCompare(right.label) ||
            left.record.id.localeCompare(right.record.id),
        )
        .slice(0, WORKSPACE_SEARCH_RESULTS_PER_ENTITY)
        .map((result) => ({
          record: result.record,
          label: result.label,
          matchedFieldName: result.matchedFieldName,
        }));

      return results.length > 0 ? [{ entityType, results }] : [];
    });
}

export async function listEntityRecords({
  workspaceId,
  entityTypeId,
  fields,
  includeArchived = false,
  supabase: injectedSupabase,
}: ListEntityRecordsInput) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
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
  supabase: injectedSupabase,
  originatingProcessStepRunId,
}: CreateEntityRecordInput) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { primitiveValues, relations } = splitRecordValues(fields, values);
  const { data, error } = await supabase.rpc(
    "create_entity_record_with_relations_authorized",
    {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: primitiveValues,
      p_relations: relations,
      p_originating_process_step_run_id: originatingProcessStepRunId ?? null,
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
  supabase,
}: GetEntityRecordInput) {
  const records = await listEntityRecords({
    workspaceId,
    entityTypeId,
    fields,
    includeArchived: true,
    supabase,
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
  supabase: injectedSupabase,
}: UpdateEntityRecordInput) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { primitiveValues, relationFieldIds, relations } = splitRecordValues(
    fields,
    values,
  );
  const { data, error } = await supabase.rpc(
    "update_entity_record_with_relations_authorized",
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
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  includeArchived?: boolean;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
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
  const supabase = await createServerSupabaseClient();
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
  const supabase = await createServerSupabaseClient();
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
  const supabase = await createServerSupabaseClient();
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
  const supabase = await createServerSupabaseClient();
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

export async function listIncomingRelationsForRecord({
  workspaceId,
  targetEntityTypeId,
  targetRecordId,
}: {
  workspaceId: string;
  targetEntityTypeId: string;
  targetRecordId: string;
}): Promise<IncomingRelationGroup[]> {
  const supabase = await createServerSupabaseClient();
  const { data: relationFields, error: fieldError } = await supabase
    .from("field_definitions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("type", "relation")
    .eq("related_entity_type_id", targetEntityTypeId)
    .is("archived_at", null)
    .returns<FieldDefinitionRow[]>();

  if (fieldError) {
    throw new Error(`Unable to load incoming relation fields: ${fieldError.message}`);
  }

  if (relationFields.length === 0) {
    return [];
  }

  const { data: relationRows, error: relationError } = await supabase
    .from("entity_record_relation_values")
    .select("source_entity_type_id, source_record_id, field_definition_id")
    .eq("workspace_id", workspaceId)
    .eq("target_entity_type_id", targetEntityTypeId)
    .eq("target_record_id", targetRecordId)
    .returns<
      Array<{
        source_entity_type_id: string;
        source_record_id: string;
        field_definition_id: string;
      }>
    >();

  if (relationError) {
    throw new Error(`Unable to load incoming relations: ${relationError.message}`);
  }

  const relationFieldById = new Map(
    relationFields.map((fieldRow) => [
      fieldRow.id,
      mapFieldDefinition(fieldRow),
    ]),
  );
  const relationRowsByFieldId = new Map<string, string[]>();

  relationRows.forEach((row) => {
    if (!relationFieldById.has(row.field_definition_id)) {
      return;
    }

    const recordIds = relationRowsByFieldId.get(row.field_definition_id) ?? [];
    recordIds.push(row.source_record_id);
    relationRowsByFieldId.set(row.field_definition_id, recordIds);
  });

  const groups: IncomingRelationGroup[] = [];
  const relationFieldsBySourceEntityId = new Map<string, FieldDefinition[]>();

  relationFieldById.forEach((field) => {
    const fields = relationFieldsBySourceEntityId.get(field.entityTypeId) ?? [];
    fields.push(field);
    relationFieldsBySourceEntityId.set(field.entityTypeId, fields);
  });

  await Promise.all(
    [...relationFieldsBySourceEntityId].map(async ([sourceEntityTypeId, sourceRelationFields]) => {
      const { entityType: sourceEntityType, fields: sourceFields } =
        await getEntityContext({
          workspaceId,
          entityTypeId: sourceEntityTypeId,
        });

      if (sourceEntityType.archivedAt) {
        return;
      }

      const sourceRecordIds = [
        ...new Set(
          sourceRelationFields.flatMap(
            (field) => relationRowsByFieldId.get(field.id) ?? [],
          ),
        ),
      ];
      const sourceRecords =
        sourceRecordIds.length > 0
          ? await listEntityRecords({
              workspaceId,
              entityTypeId: sourceEntityTypeId,
              fields: sourceFields,
            })
          : [];
      const sourceRecordById = new Map(
        sourceRecords
          .filter((record) => sourceRecordIds.includes(record.id))
          .map((record) => [record.id, record]),
      );
      sourceRelationFields.forEach((relationField) => {
        const records = (relationRowsByFieldId.get(relationField.id) ?? [])
          .map((recordId) => sourceRecordById.get(recordId))
          .filter((record): record is EntityRecord => Boolean(record));

        groups.push({
          sourceEntityType,
          sourceFields,
          relationField,
          records: [...records].sort((left, right) =>
            getRecordLabel({
              entityType: sourceEntityType,
              fields: sourceFields,
              record: left,
            }).localeCompare(
              getRecordLabel({
                entityType: sourceEntityType,
                fields: sourceFields,
                record: right,
              }),
              undefined,
              { sensitivity: "base", numeric: true },
            ),
          ),
        });
      });
    }),
  );

  return groups.sort((left, right) => {
    const entityCompare = left.sourceEntityType.name.localeCompare(
      right.sourceEntityType.name,
      undefined,
      { sensitivity: "base", numeric: true },
    );

    if (entityCompare !== 0) {
      return entityCompare;
    }

    return left.relationField.position - right.relationField.position;
  });
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
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(
    "delete_entity_record_if_unreferenced_authorized",
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
    process_run_count: number;
  }> | null;
  const result = resultRows?.[0];

  if (!result) {
    throw new Error("Unable to delete entity record: unexpected RPC response.");
  }

  return {
    deleted: result.deleted,
    referenceCount: result.reference_count,
    processRunCount: result.process_run_count,
  };
}
