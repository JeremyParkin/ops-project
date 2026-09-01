import type { SupabaseServerClient } from "@/lib/supabase/server";
import { isUuid, isValidDate, validateRecordValues } from "./record-validation";
import { listChoiceOptionsByFieldIds } from "./choice-option-repository";
import { getEntityContext } from "./metadata-repository";
import { getRecordLabel, listEntityRecords } from "./record-repository";
import type { EntityRecord, FieldDefinition, FieldValue } from "./types";

// --- Column mapping ---------------------------------------------------

export type ColumnMapping = {
  columnIndex: number;
  // null means "Ignore".
  fieldId: string | null;
};

// Exact, case-insensitive, whitespace-trimmed match only -- never semantic
// or fuzzy. The suggestion is always editable and never applied silently.
export function suggestColumnMappings(
  headers: string[],
  fields: FieldDefinition[],
): ColumnMapping[] {
  const fieldIdByNormalizedName = new Map(
    fields.map((field) => [field.name.trim().toLowerCase(), field.id]),
  );

  return headers.map((header, columnIndex) => ({
    columnIndex,
    fieldId: fieldIdByNormalizedName.get(header.trim().toLowerCase()) ?? null,
  }));
}

export function validateColumnMapping(
  fields: FieldDefinition[],
  mapping: ColumnMapping[],
): string[] {
  const errors: string[] = [];
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const mappedFieldIds = mapping
    .map((entry) => entry.fieldId)
    .filter((fieldId): fieldId is string => fieldId !== null);

  const seen = new Set<string>();
  const duplicated = new Set<string>();

  for (const fieldId of mappedFieldIds) {
    if (seen.has(fieldId)) {
      duplicated.add(fieldId);
    }

    seen.add(fieldId);

    if (!fieldById.has(fieldId)) {
      errors.push("A mapped field no longer exists or is archived. Review your mapping.");
    }
  }

  for (const fieldId of duplicated) {
    errors.push(
      `${fieldById.get(fieldId)?.name ?? "A field"} is mapped from more than one column.`,
    );
  }

  const mappedFieldIdSet = new Set(mappedFieldIds);

  for (const field of fields) {
    if (field.required && !mappedFieldIdSet.has(field.id)) {
      errors.push(`${field.name} is required and must be mapped to a column.`);
    }
  }

  return errors;
}

// --- Primitive cell parsing ---------------------------------------------

type CellParseResult =
  | { success: true; value: FieldValue }
  | { success: false; error: string };

const CSV_BOOLEAN_TRUE_VALUES = new Set(["true", "yes", "1"]);
const CSV_BOOLEAN_FALSE_VALUES = new Set(["false", "no", "0"]);

// CSV-specific parsing rules -- deliberately not identical to the manual
// record form's vocabulary (e.g. "yes"/"no" isn't a real checkbox value),
// since CSV cells are plain text a human authored in a spreadsheet, not
// form-control output.
export function parseCsvCellValue(field: FieldDefinition, rawCell: string): CellParseResult {
  const trimmed = rawCell.trim();

  if (trimmed === "") {
    return { success: true, value: null };
  }

  switch (field.type) {
    case "text":
      return { success: true, value: trimmed };
    case "number": {
      const parsed = Number(trimmed);

      if (Number.isNaN(parsed)) {
        return { success: false, error: `${field.name} must be a number.` };
      }

      return { success: true, value: parsed };
    }
    case "date":
      if (!isValidDate(trimmed)) {
        return { success: false, error: `${field.name} must use YYYY-MM-DD.` };
      }

      return { success: true, value: trimmed };
    case "boolean": {
      const normalized = trimmed.toLowerCase();

      if (CSV_BOOLEAN_TRUE_VALUES.has(normalized)) {
        return { success: true, value: true };
      }

      if (CSV_BOOLEAN_FALSE_VALUES.has(normalized)) {
        return { success: true, value: false };
      }

      return {
        success: false,
        error: `${field.name} must be true/false, yes/no, or 1/0.`,
      };
    }
    case "relation":
      // Relation cells are resolved separately -- see resolveRelationValues.
      return { success: true, value: trimmed };
    case "choice":
      // Choice cells are resolved separately -- see resolveChoiceValues.
      return { success: true, value: trimmed };
  }
}

// --- Relation resolution (batched, one lookup per relation field) -------

type RelationResolution =
  | { status: "resolved"; recordId: string }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "archived" };

async function resolveRelationValues({
  workspaceId,
  field,
  rawValues,
  supabase,
}: {
  workspaceId: string;
  field: FieldDefinition;
  rawValues: string[];
  supabase?: SupabaseServerClient;
}): Promise<{ targetEntityTypeName: string; resolutions: Map<string, RelationResolution> }> {
  const resolutions = new Map<string, RelationResolution>();

  if (!field.relatedEntityTypeId) {
    return { targetEntityTypeName: field.name, resolutions };
  }

  const targetContext = await getEntityContext({
    workspaceId,
    entityTypeId: field.relatedEntityTypeId,
    supabase,
  });
  const targetRecords = await listEntityRecords({
    workspaceId,
    entityTypeId: field.relatedEntityTypeId,
    fields: targetContext.fields,
    includeArchived: true,
    supabase,
  });

  const recordById = new Map(targetRecords.map((record) => [record.id, record]));
  const recordsByLabel = new Map<string, EntityRecord[]>();

  for (const record of targetRecords) {
    const label = getRecordLabel({
      entityType: targetContext.entityType,
      fields: targetContext.fields,
      record,
    });
    const existing = recordsByLabel.get(label) ?? [];
    existing.push(record);
    recordsByLabel.set(label, existing);
  }

  for (const rawValue of rawValues) {
    if (isUuid(rawValue)) {
      const record = recordById.get(rawValue);

      if (!record) {
        resolutions.set(rawValue, { status: "not_found" });
      } else if (record.archivedAt) {
        resolutions.set(rawValue, { status: "archived" });
      } else {
        resolutions.set(rawValue, { status: "resolved", recordId: record.id });
      }

      continue;
    }

    const matches = recordsByLabel.get(rawValue) ?? [];

    if (matches.length === 0) {
      resolutions.set(rawValue, { status: "not_found" });
    } else if (matches.length > 1) {
      resolutions.set(rawValue, { status: "ambiguous" });
    } else if (matches[0].archivedAt) {
      resolutions.set(rawValue, { status: "archived" });
    } else {
      resolutions.set(rawValue, { status: "resolved", recordId: matches[0].id });
    }
  }

  return { targetEntityTypeName: targetContext.entityType.name, resolutions };
}

// --- Choice resolution (batched, one lookup per choice field) -----------
//
// Exact, case-sensitive match against currently ACTIVE option labels only
// -- never fuzzy, never matching an archived option, and never falling
// back to raw option-id passthrough the way relation accepts a raw UUID
// (nobody hand-types a UUID into a spreadsheet; keeping this label-only
// is the simpler V1 choice). No "ambiguous" status is possible: the
// global (active-or-archived) label uniqueness constraint on
// field_choice_options means at most one option can ever match a given
// label at all, active or not.

type ChoiceResolution =
  | { status: "resolved"; optionId: string }
  | { status: "not_found" }
  | { status: "archived" };

async function resolveChoiceValues({
  workspaceId,
  field,
  rawValues,
  supabase,
}: {
  workspaceId: string;
  field: FieldDefinition;
  rawValues: string[];
  supabase?: SupabaseServerClient;
}): Promise<Map<string, ChoiceResolution>> {
  const resolutions = new Map<string, ChoiceResolution>();
  const optionsByFieldId = await listChoiceOptionsByFieldIds({
    workspaceId,
    fieldDefinitionIds: [field.id],
    supabase,
  });
  const options = optionsByFieldId[field.id] ?? [];
  const optionByLabel = new Map(options.map((option) => [option.label, option]));

  for (const rawValue of rawValues) {
    const match = optionByLabel.get(rawValue);

    if (!match) {
      resolutions.set(rawValue, { status: "not_found" });
    } else if (match.archivedAt) {
      resolutions.set(rawValue, { status: "archived" });
    } else {
      resolutions.set(rawValue, { status: "resolved", optionId: match.id });
    }
  }

  return resolutions;
}

// --- Row-level preflight -------------------------------------------------

export type ImportRowError = {
  column: string;
  message: string;
};

export type ImportRow = {
  // 1-indexed against the first DATA row (header excluded), matching how a
  // person reading their own spreadsheet would count rows.
  rowNumber: number;
  status: "ready" | "error";
  errors: ImportRowError[];
  // Primitive and relation values combined, keyed by field.key -- the same
  // shape EntityRecord.values already uses, so splitRecordValues (the
  // existing single-record repository helper) can consume it unchanged.
  values: EntityRecord["values"];
};

export type ImportPreflightResult = {
  rows: ImportRow[];
  readyCount: number;
  errorCount: number;
  totalCount: number;
};

export async function buildImportPreflight({
  workspaceId,
  fields,
  headers,
  dataRows,
  mapping,
  supabase,
}: {
  workspaceId: string;
  fields: FieldDefinition[];
  headers: string[];
  dataRows: string[][];
  mapping: ColumnMapping[];
  supabase?: SupabaseServerClient;
}): Promise<ImportPreflightResult> {
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const mappedColumns = mapping.filter(
    (entry): entry is { columnIndex: number; fieldId: string } =>
      entry.fieldId !== null && fieldById.has(entry.fieldId),
  );

  const relationResolutionsByFieldId = new Map<
    string,
    { targetEntityTypeName: string; resolutions: Map<string, RelationResolution> }
  >();
  const choiceResolutionsByFieldId = new Map<string, Map<string, ChoiceResolution>>();

  for (const { fieldId, columnIndex } of mappedColumns) {
    const field = fieldById.get(fieldId)!;

    if (field.type !== "relation" && field.type !== "choice") {
      continue;
    }

    const distinctValues = new Set<string>();

    for (const row of dataRows) {
      const raw = (row[columnIndex] ?? "").trim();

      if (raw !== "") {
        distinctValues.add(raw);
      }
    }

    if (field.type === "relation") {
      const result = await resolveRelationValues({
        workspaceId,
        field,
        rawValues: [...distinctValues],
        supabase,
      });
      relationResolutionsByFieldId.set(fieldId, result);
    } else {
      const result = await resolveChoiceValues({
        workspaceId,
        field,
        rawValues: [...distinctValues],
        supabase,
      });
      choiceResolutionsByFieldId.set(fieldId, result);
    }
  }

  const rows: ImportRow[] = [];

  for (const [index, row] of dataRows.entries()) {
    const errors: ImportRowError[] = [];
    const values: EntityRecord["values"] = {};

    for (const { fieldId, columnIndex } of mappedColumns) {
      const field = fieldById.get(fieldId)!;
      const rawCell = row[columnIndex] ?? "";
      const column = headers[columnIndex];

      if (field.type === "relation") {
        const trimmed = rawCell.trim();

        if (trimmed === "") {
          continue;
        }

        const relationResult = relationResolutionsByFieldId.get(fieldId);
        const resolution = relationResult?.resolutions.get(trimmed);
        const targetName = relationResult?.targetEntityTypeName ?? field.name;

        if (!resolution || resolution.status === "not_found") {
          errors.push({ column, message: `No ${targetName} matches "${trimmed}".` });
        } else if (resolution.status === "ambiguous") {
          errors.push({
            column,
            message: `Multiple ${targetName} records match "${trimmed}".`,
          });
        } else if (resolution.status === "archived") {
          errors.push({
            column,
            message: `"${trimmed}" is archived and can't be used for a new ${field.name} value.`,
          });
        } else {
          values[field.key] = resolution.recordId;
        }

        continue;
      }

      if (field.type === "choice") {
        const trimmed = rawCell.trim();

        if (trimmed === "") {
          continue;
        }

        const resolution = choiceResolutionsByFieldId.get(fieldId)?.get(trimmed);

        if (!resolution || resolution.status === "not_found") {
          errors.push({ column, message: `No option matches "${trimmed}" for ${field.name}.` });
        } else if (resolution.status === "archived") {
          errors.push({
            column,
            message: `"${trimmed}" is archived and can't be used for a new ${field.name} value.`,
          });
        } else {
          values[field.key] = resolution.optionId;
        }

        continue;
      }

      const parsed = parseCsvCellValue(field, rawCell);

      if (!parsed.success) {
        errors.push({ column, message: parsed.error });
      } else {
        values[field.key] = parsed.value;
      }
    }

    // Reuse the same validator workflow actions trust for typed,
    // non-FormData input -- a defense-in-depth pass over required-ness and
    // type-correctness, on top of (not instead of) the CSV-specific parsing
    // above. Every relation value here was already resolved against a live
    // target record, so the relation check only needs to confirm presence.
    if (errors.length === 0) {
      const validation = await validateRecordValues(
        fields,
        values,
        async () => true,
        async () => true,
      );

      if (!validation.success) {
        const fieldKeyByColumn = new Map(
          mappedColumns.map(({ fieldId: id, columnIndex }) => [
            fieldById.get(id)!.key,
            headers[columnIndex],
          ]),
        );

        for (const [fieldKey, message] of Object.entries(validation.errors)) {
          errors.push({ column: fieldKeyByColumn.get(fieldKey) ?? fieldKey, message });
        }
      }
    }

    rows.push({
      rowNumber: index + 1,
      status: errors.length === 0 ? "ready" : "error",
      errors,
      values,
    });
  }

  return {
    rows,
    readyCount: rows.filter((row) => row.status === "ready").length,
    errorCount: rows.filter((row) => row.status === "error").length,
    totalCount: rows.length,
  };
}
