"use server";

import { getWorkspacePermissionContext } from "@/lib/auth/workspace";
import { parseCsvFile } from "@/lib/domain/csv-parsing";
import { getEntityContext } from "@/lib/domain/metadata-repository";
import {
  buildImportPreflight,
  suggestColumnMappings,
  validateColumnMapping,
  type ColumnMapping,
  type ImportRow,
} from "@/lib/domain/record-import";
import { bulkCreateEntityRecords } from "@/lib/domain/record-repository";
import type { FieldDefinition } from "@/lib/domain/types";

// App-level cap, enforced server-side regardless of what a client claims --
// matches the Next.js Server Action body-size-limit headroom (next.config.ts).
const IMPORT_FILE_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

type ImportContext = {
  workspaceId: string;
  entityTypeId: string;
};

export type ImportableField = Pick<
  FieldDefinition,
  "id" | "name" | "type" | "required" | "relatedEntityTypeId"
>;

async function requireImportAuthorized(context: ImportContext) {
  const permissions = await getWorkspacePermissionContext(context.workspaceId);

  if (!permissions?.capabilities.has("records.operate")) {
    throw new Error("You do not have permission to import records into this object.");
  }

  const { entityType, fields } = await getEntityContext(context);

  if (entityType.archivedAt) {
    throw new Error("Archived objects are read-only.");
  }

  return { entityType, fields };
}

function toImportableField(field: FieldDefinition): ImportableField {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    required: field.required,
    relatedEntityTypeId: field.relatedEntityTypeId,
  };
}

export type ParseImportFileResult =
  | {
      success: true;
      headers: string[];
      rows: string[][];
      suggestedMapping: ColumnMapping[];
      fields: ImportableField[];
    }
  | { success: false; message: string };

// The client reads the uploaded File as text itself (a trivial byte read,
// not CSV interpretation) and sends the raw text here -- actual parsing
// (structure, duplicate-header rejection, malformed-file detection) is
// entirely server-side, the one authoritative place CSV text is interpreted.
export async function parseImportFile(
  context: ImportContext,
  fileText: string,
): Promise<ParseImportFileResult> {
  try {
    const { fields } = await requireImportAuthorized(context);

    if (Buffer.byteLength(fileText, "utf8") > IMPORT_FILE_SIZE_LIMIT_BYTES) {
      return { success: false, message: "The CSV file is larger than the 5 MB import limit." };
    }

    const parsed = parseCsvFile(fileText);

    if (!parsed.success) {
      return { success: false, message: parsed.error };
    }

    return {
      success: true,
      headers: parsed.data.headers,
      rows: parsed.data.rows,
      suggestedMapping: suggestColumnMappings(parsed.data.headers, fields),
      fields: fields.map(toImportableField),
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to read the CSV file.",
    };
  }
}

export type ImportPreflightSummary = {
  success: true;
  mappingErrors: string[];
  rows: ImportRow[];
  readyCount: number;
  errorCount: number;
  totalCount: number;
};

export type RunImportPreflightResult =
  | ImportPreflightSummary
  | { success: false; message: string };

export async function runImportPreflight(
  context: ImportContext,
  input: { headers: string[]; rows: string[][]; mapping: ColumnMapping[] },
): Promise<RunImportPreflightResult> {
  try {
    const { fields } = await requireImportAuthorized(context);
    const mappingErrors = validateColumnMapping(fields, input.mapping);

    if (mappingErrors.length > 0) {
      return {
        success: true,
        mappingErrors,
        rows: [],
        readyCount: 0,
        errorCount: 0,
        totalCount: input.rows.length,
      };
    }

    const preflight = await buildImportPreflight({
      workspaceId: context.workspaceId,
      fields,
      headers: input.headers,
      dataRows: input.rows,
      mapping: input.mapping,
    });

    return {
      success: true,
      mappingErrors: [],
      rows: preflight.rows,
      readyCount: preflight.readyCount,
      errorCount: preflight.errorCount,
      totalCount: preflight.totalCount,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to validate the CSV file.",
    };
  }
}

export type CommitImportResult =
  | { success: true; importedCount: number }
  | { success: false; message: string };

// The commit step never trusts the client's earlier "zero errors" claim --
// it re-validates the mapping and re-runs the full preflight against
// current schema right before committing, exactly like runImportPreflight,
// then hands only the ready rows' already-typed values to the bulk RPC.
export async function commitImport(
  context: ImportContext,
  input: { headers: string[]; rows: string[][]; mapping: ColumnMapping[]; importId: string },
): Promise<CommitImportResult> {
  try {
    const { fields } = await requireImportAuthorized(context);
    const mappingErrors = validateColumnMapping(fields, input.mapping);

    if (mappingErrors.length > 0) {
      return { success: false, message: mappingErrors[0] };
    }

    const preflight = await buildImportPreflight({
      workspaceId: context.workspaceId,
      fields,
      headers: input.headers,
      dataRows: input.rows,
      mapping: input.mapping,
    });

    if (preflight.errorCount > 0) {
      return {
        success: false,
        message: `${preflight.errorCount} row${preflight.errorCount === 1 ? "" : "s"} still ${preflight.errorCount === 1 ? "has" : "have"} errors. Fix them before importing.`,
      };
    }

    const importedCount = await bulkCreateEntityRecords({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      fields,
      rows: preflight.rows.map((row) => row.values),
      importId: input.importId,
    });

    return { success: true, importedCount };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to import the CSV file.",
    };
  }
}
