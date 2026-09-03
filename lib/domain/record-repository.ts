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
  // Restricts the fetch to these specific record IDs instead of the whole
  // entity type -- for callers (relation label/lookup resolution) that
  // already know exactly which records they need, so they don't pull every
  // record of a potentially large entity type just to read a handful.
  ids?: string[];
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
  // Set only for an already-selected target injected by currentRecord /
  // currentRecords (see getRelationLookups) -- always absent on the
  // fetched active-option list itself. Lets a create-style form filter
  // these back out, the same way choice's activeChoiceOptions does.
  archivedAt?: string | null;
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

type WorkspaceSearchMatchRow = {
  entity_type_id: string;
  record_id: string;
  matched_field_id: string | null;
  matched_field_name: string | null;
  is_identity_match: boolean;
  is_prefix_match: boolean;
};

// Filtering, matching, ranking, and the per-entity-type cap all happen in
// Postgres (search_workspace_records_authorized, migration 0066) -- this
// function only resolves the matched ids into full records/labels for
// display. Previously this fetched every active record in the workspace
// into Node and matched/ranked/sliced it here; that no longer scales past a
// few hundred records (see docs/PROJECT_CONTEXT.md's Phase 8D.4 section for
// the before/after benchmark).
export async function searchWorkspaceRecords({
  workspaceId,
  query,
  entityTypeId,
}: {
  workspaceId: string;
  query: string;
  // Restricts matching to one entity type (the Search page's type filter).
  // The per-type cap (WORKSPACE_SEARCH_RESULTS_PER_ENTITY) is unchanged
  // either way -- a filtered search still shows at most 20, not a larger
  // single-type page, keeping this v1 simple.
  entityTypeId?: string;
}): Promise<WorkspaceRecordSearchGroup[]> {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return [];
  }

  const supabase = await createServerSupabaseClient();
  const { data: matchRows, error: matchError } = await supabase.rpc(
    "search_workspace_records_authorized",
    {
      p_workspace_id: workspaceId,
      p_query: normalizedQuery,
      p_entity_type_id: entityTypeId ?? null,
      p_limit_per_type: WORKSPACE_SEARCH_RESULTS_PER_ENTITY,
    },
  );

  if (matchError) {
    throw new Error(`Unable to search workspace records: ${matchError.message}`);
  }

  const matches = (matchRows ?? []) as WorkspaceSearchMatchRow[];

  if (matches.length === 0) {
    return [];
  }

  const matchedEntityTypeIds = [...new Set(matches.map((row) => row.entity_type_id))];
  const matchedRecordIds = matches.map((row) => row.record_id);

  const [entityTypes, { data: fieldRows, error: fieldError }, { data: recordRows, error: recordError }] =
    await Promise.all([
      listEntityTypes({ workspaceId }),
      supabase
        .from("field_definitions")
        .select("*")
        .eq("workspace_id", workspaceId)
        .is("archived_at", null)
        .eq("type", "text")
        .in("entity_type_id", matchedEntityTypeIds)
        .returns<FieldDefinitionRow[]>(),
      supabase
        .from("entity_records")
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("id", matchedRecordIds)
        .returns<EntityRecordRow[]>(),
    ]);

  if (fieldError) {
    throw new Error(`Unable to load searchable fields: ${fieldError.message}`);
  }

  if (recordError) {
    throw new Error(`Unable to load matched records: ${recordError.message}`);
  }

  const entityTypeById = new Map(entityTypes.map((entityType) => [entityType.id, entityType]));

  const fieldsByEntityTypeId = new Map<string, FieldDefinition[]>();

  fieldRows.map(mapFieldDefinition).forEach((field) => {
    const fields = fieldsByEntityTypeId.get(field.entityTypeId) ?? [];
    fields.push(field);
    fieldsByEntityTypeId.set(field.entityTypeId, fields);
  });

  const recordById = new Map(recordRows.map(mapEntityRecord).map((record) => [record.id, record]));

  const groupsByEntityTypeId = new Map<string, WorkspaceRecordSearchGroup>();

  matches.forEach((match) => {
    const entityType = entityTypeById.get(match.entity_type_id);
    const record = recordById.get(match.record_id);

    // The RPC only ever returns rows for entity types/records it just
    // matched live -- both are always present. This guards an impossible
    // race (e.g. a delete landing between the RPC call and this fetch)
    // rather than expected behavior.
    if (!entityType || !record) {
      return;
    }

    const fields = fieldsByEntityTypeId.get(entityType.id) ?? [];
    const group = groupsByEntityTypeId.get(entityType.id) ?? { entityType, results: [] };

    group.results.push({
      record,
      label: getRecordLabel({ entityType, fields, record }),
      matchedFieldName: match.is_identity_match ? undefined : (match.matched_field_name ?? undefined),
    });

    groupsByEntityTypeId.set(entityType.id, group);
  });

  return [...groupsByEntityTypeId.values()].sort(
    (left, right) =>
      left.entityType.name.localeCompare(right.entityType.name) ||
      left.entityType.id.localeCompare(right.entityType.id),
  );
}

export async function listEntityRecords({
  workspaceId,
  entityTypeId,
  fields,
  includeArchived = false,
  ids,
  supabase: injectedSupabase,
}: ListEntityRecordsInput) {
  if (ids && ids.length === 0) {
    return [];
  }

  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  // `id` is a secondary, stable tiebreaker -- created_at alone is not a
  // deterministic order for rows inserted within the same timestamp
  // granularity (a real possibility for records created in rapid
  // succession, e.g. a fixture or an import batch), which Postgres leaves
  // as an unspecified tie-break otherwise. This is a correctness property
  // of "the default record order," not merely a test convenience: any
  // downstream consumer of this order (a saved/quick-bar sort applies its
  // own comparator via a stable Array.prototype.sort, which only preserves
  // *this* order for values it considers equal) inherits the same
  // nondeterminism unless the base query is already fully ordered.
  let query = supabase
    .from("entity_records")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("entity_type_id", entityTypeId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (ids) {
    query = query.in("id", ids);
  }

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

export function splitRecordValues(fields: FieldDefinition[], values: EntityRecord["values"]) {
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

// Commits an entire CSV import batch as one transaction via
// bulk_create_entity_records_authorized (migration 0061). importId is the
// batch's durable idempotency key, claimed atomically inside the RPC -- a
// retried or double-submitted call with the same importId returns the
// already-committed count instead of inserting a second time; it is never
// generated or trusted from anywhere but this one call site's caller.
export async function bulkCreateEntityRecords({
  workspaceId,
  entityTypeId,
  fields,
  rows,
  importId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  fields: FieldDefinition[];
  rows: EntityRecord["values"][];
  importId: string;
  supabase?: SupabaseServerClient;
}) {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const payload = rows.map((values) => {
    const { primitiveValues, relations } = splitRecordValues(fields, values);
    return { values: primitiveValues, relations };
  });

  const { data, error } = await supabase.rpc("bulk_create_entity_records_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_import_id: importId,
    p_rows: payload,
  });

  if (error) {
    throw new Error(`Unable to import records: ${error.message}`);
  }

  const result = Array.isArray(data) ? data[0] : undefined;

  if (!result || typeof result.imported_row_count !== "number") {
    throw new Error("Unable to import records: unexpected RPC response.");
  }

  return result.imported_row_count as number;
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
  currentRecords,
  restrictToCurrentRecordValues = false,
}: {
  workspaceId: string;
  fields: FieldDefinition[];
  currentRecord?: EntityRecord;
  // Table callers: every one of these records' own current relation values
  // is kept selectable in optionsByFieldKey even if archived, so a row's
  // already-selected archived target doesn't disappear from that row's
  // dropdown. Unlike currentRecord, this never restricts which target
  // records get fetched -- the table still needs the full active-option set
  // for every relation field, not just the values already in use.
  currentRecords?: EntityRecord[];
  // When true, only fetches the specific target records currentRecord's own
  // relation fields point to (for resolving their display labels), rather
  // than every record of each related entity type. Only safe for callers
  // that don't need optionsByFieldKey (e.g. a read-only detail view) --
  // list/edit-form callers that populate a relation dropdown still need the
  // full active-option set and must leave this false.
  restrictToCurrentRecordValues?: boolean;
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
      const restrictedIds =
        restrictToCurrentRecordValues && currentRecord
          ? [
              ...new Set(
                relationFields
                  .filter((field) => field.relatedEntityTypeId === targetEntityTypeId)
                  .map((field) => currentRecord.values[field.key])
                  .filter((value): value is string => typeof value === "string"),
              ),
            ]
          : undefined;
      const targetRecords = await listEntityRecords({
        workspaceId,
        entityTypeId: targetEntityTypeId,
        fields: targetFields,
        includeArchived: true,
        ids: restrictedIds,
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
    const referencingRecords = [
      ...(currentRecord ? [currentRecord] : []),
      ...(currentRecords ?? []),
    ];
    const archivedSelectionsById = new Map<string, RelationRecordOption>();

    referencingRecords.forEach((sourceRecord) => {
      const value = sourceRecord.values[field.key];

      if (typeof value !== "string") {
        return;
      }

      const targetRecord = records.find((record) => record.id === value);

      if (
        targetRecord?.archivedAt &&
        !activeOptions.some((option) => option.value === targetRecord.id)
      ) {
        archivedSelectionsById.set(targetRecord.id, {
          value: targetRecord.id,
          label: getRelationOptionLabel(data.entityType, data.fields, targetRecord),
          archivedAt: targetRecord.archivedAt,
        });
      }
    });

    optionsByFieldKey[field.key] = [...activeOptions, ...archivedSelectionsById.values()];
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

// Bulk archive/restore, backed by the set_entity_records_archived_authorized
// RPC (0083) -- a single transaction that validates the complete requested
// id set (workspace + entity type + existence, all locked before checking)
// and only then updates it. All-or-nothing: a thrown error here means
// nothing was changed, never a partial result.
export async function setEntityRecordsArchived({
  workspaceId,
  entityTypeId,
  recordIds,
  archived,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordIds: string[];
  archived: boolean;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: recordIds,
      p_archived: archived,
    })
    .single<{ updated_record_count: number }>();

  if (error) {
    throw new Error(
      `Unable to ${archived ? "archive" : "restore"} the selected records: ${error.message}`,
    );
  }

  return { updatedCount: data?.updated_record_count ?? 0 };
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
              ids: sourceRecordIds,
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
