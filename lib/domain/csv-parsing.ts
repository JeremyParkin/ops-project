import { parse } from "csv-parse/sync";

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
};

export type CsvParseResult =
  | { success: true; data: ParsedCsv }
  | { success: false; error: string };

// Server-side parsing is authoritative -- this is the only place CSV text is
// interpreted. Deliberately raw (array-of-arrays, not csv-parse's `columns`
// mode): header handling (duplicate detection, trimming) and row-to-field
// semantics live in record-import.ts, not here.
export function parseCsvFile(fileContent: string): CsvParseResult {
  let records: string[][];

  try {
    records = parse(fileContent, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
    });
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? `The CSV file could not be parsed: ${error.message}`
          : "The CSV file could not be parsed.",
    };
  }

  if (records.length === 0) {
    return { success: false, error: "The CSV file is empty." };
  }

  const headers = records[0].map((header) => header.trim());

  if (headers.some((header) => header === "")) {
    return { success: false, error: "The CSV file has a blank column header." };
  }

  const seenHeaders = new Set<string>();
  const duplicateHeaders = new Set<string>();

  for (const header of headers) {
    if (seenHeaders.has(header)) {
      duplicateHeaders.add(header);
    }

    seenHeaders.add(header);
  }

  if (duplicateHeaders.size > 0) {
    return {
      success: false,
      error: `The CSV file has duplicate column headers: ${[...duplicateHeaders].join(", ")}.`,
    };
  }

  const rows = records.slice(1);

  if (rows.length === 0) {
    return { success: false, error: "The CSV file has no data rows." };
  }

  return { success: true, data: { headers, rows } };
}
