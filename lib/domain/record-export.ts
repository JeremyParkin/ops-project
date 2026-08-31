import { stringify } from "csv-stringify/sync";
import { getEntityContext } from "./metadata-repository";
import { getRecordLabel, listEntityRecords } from "./record-repository";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import type { EntityRecord, EntityType, FieldDefinition } from "./types";

// RFC 4180 specifies CRLF record separators (csv-stringify defaults to a
// bare \n). With that delimiter set explicitly, csv-stringify's own
// need-to-quote detection only recognizes a literal \r\n inside a cell as a
// reason to quote -- a cell containing a bare \n (the far more common case
// from a browser textarea) would otherwise be written unquoted, silently
// corrupting the file's row structure for any parser that isn't unusually
// forgiving. quoted_match makes quoting-on-any-newline explicit rather than
// relying on the library's default heuristic matching the chosen delimiter.
export function stringifyExportTable(table: string[][]): string {
  return stringify(table, { record_delimiter: "\r\n", quoted_match: /[\r\n]/ });
}

// One object at a time, active records and active fields only, in the same
// canonical field position order the table/form already use -- symmetric
// with CSV import's own scope, not a broader export feature.

// A relation cell's exported value is the target's normal resolved label
// (getRecordLabel -- the same function every other read surface uses),
// never a raw id and never a UI-only "(Archived)" decoration. This is
// deliberate: import's own resolveRelationValues matches a raw label
// against active AND archived targets, then explicitly rejects an archived
// match with its own "archived" error -- decorating the exported value
// would just make it fail to match at all, trading one failure mode for a
// worse one. See docs/PROJECT_CONTEXT.md's 8F.1 section for the full
// round-trip guarantee this implies.
function formatCellValue(field: FieldDefinition, rawValue: EntityRecord["values"][string]): string {
  if (rawValue === null || rawValue === undefined) return "";

  switch (field.type) {
    case "boolean":
      return rawValue ? "true" : "false";
    case "text":
    case "number":
    case "date":
    case "relation":
      return String(rawValue);
  }
}

// Pure and directly unit-testable: takes already-fetched data (records with
// relation cells already resolved to target LABELS, not ids -- see
// resolveRelationTargetLabels below) and produces the header + data rows.
export function buildExportTable({
  fields,
  records,
}: {
  fields: FieldDefinition[];
  records: EntityRecord[];
}): string[][] {
  const header = fields.map((field) => field.name);
  const rows = records.map((record) => fields.map((field) => formatCellValue(field, record.values[field.key])));
  return [header, ...rows];
}

// Batched, one lookup per distinct related entity type -- mirrors record-
// import.ts's resolveRelationValues shape exactly (includeArchived: true,
// since an archived target still needs a real label to export, just not a
// decorated one). Mutates a copy of each record's relation cells from a raw
// target id into that target's resolved label.
async function resolveRelationTargetLabels({
  workspaceId,
  fields,
  records,
  supabase,
}: {
  workspaceId: string;
  fields: FieldDefinition[];
  records: EntityRecord[];
  supabase?: SupabaseServerClient;
}): Promise<EntityRecord[]> {
  const relationFields = fields.filter((field): field is FieldDefinition & { relatedEntityTypeId: string } =>
    field.type === "relation" && Boolean(field.relatedEntityTypeId),
  );
  if (relationFields.length === 0) return records;

  const labelByTargetId = new Map<string, string>();

  for (const field of relationFields) {
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

    for (const targetRecord of targetRecords) {
      labelByTargetId.set(
        targetRecord.id,
        getRecordLabel({ entityType: targetContext.entityType, fields: targetContext.fields, record: targetRecord }),
      );
    }
  }

  return records.map((record) => {
    const values = { ...record.values };
    for (const field of relationFields) {
      const targetId = values[field.key];
      if (typeof targetId === "string") {
        values[field.key] = labelByTargetId.get(targetId) ?? "";
      }
    }
    return { ...record, values };
  });
}

export type EntityExport = {
  csv: string;
  filename: string;
  entityType: EntityType;
};

export async function exportEntityRecordsToCsv({
  workspaceId,
  entityTypeId,
  supabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  supabase?: SupabaseServerClient;
}): Promise<EntityExport> {
  const { entityType, fields } = await getEntityContext({ workspaceId, entityTypeId, supabase });
  const records = await listEntityRecords({ workspaceId, entityTypeId, fields, supabase });
  const recordsWithLabels = await resolveRelationTargetLabels({ workspaceId, fields, records, supabase });
  const table = buildExportTable({ fields, records: recordsWithLabels });
  const csv = stringifyExportTable(table);
  const date = new Date().toISOString().slice(0, 10);

  return { csv, filename: `${entityType.slug}-${date}.csv`, entityType };
}
