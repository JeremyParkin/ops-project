"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type {
  CommitImportResult,
  ImportableField,
  ImportPreflightSummary,
  ParseImportFileResult,
  RunImportPreflightResult,
} from "@/app/import-actions";
import { SectionHeader } from "@/app/components/page-primitives";
import type { ColumnMapping } from "@/lib/domain/record-import";

const PREVIEW_ROW_CAP = 50;
const IMPORT_FILE_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

type RecordImportFlowProps = {
  entityTypeId: string;
  entityTypeName: string;
  parseImportFileAction: (fileText: string) => Promise<ParseImportFileResult>;
  runImportPreflightAction: (input: {
    headers: string[];
    rows: string[][];
    mapping: ColumnMapping[];
  }) => Promise<RunImportPreflightResult>;
  commitImportAction: (input: {
    headers: string[];
    rows: string[][];
    mapping: ColumnMapping[];
    importId: string;
  }) => Promise<CommitImportResult>;
};

type Phase = "upload" | "review" | "success";

const fieldTypeLabel: Record<ImportableField["type"], string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Boolean",
  relation: "Relation",
  choice: "Choice",
};

function sampleValuesForColumn(rows: string[][], columnIndex: number): string {
  const samples: string[] = [];

  for (const row of rows) {
    const value = row[columnIndex]?.trim();

    if (value) {
      samples.push(value);
    }

    if (samples.length === 3) {
      break;
    }
  }

  return samples.length > 0 ? samples.join(", ") : "(all blank)";
}

export function RecordImportFlow({
  entityTypeId,
  entityTypeName,
  parseImportFileAction,
  runImportPreflightAction,
  commitImportAction,
}: RecordImportFlowProps) {
  const [phase, setPhase] = useState<Phase>("upload");
  const [uploadError, setUploadError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [fields, setFields] = useState<ImportableField[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);

  const [preflight, setPreflight] = useState<ImportPreflightSummary | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState("");

  const [importId, setImportId] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importedCount, setImportedCount] = useState(0);
  // A synchronous guard alongside isImporting: several clicks dispatched
  // faster than React re-renders (a real double-click, or a burst of
  // synthetic events) all read the same pre-render isImporting=false and
  // importId="" before the disabled attribute or the generated id lands,
  // so each one calls crypto.randomUUID() independently and commits as an
  // unrelated import. A ref is read/written immediately, not batched, so
  // it actually blocks the second call within the same tick.
  const isImportingRef = useRef(false);

  // Takes headers/rows explicitly rather than reading component state --
  // called synchronously right after setHeaders/setRows on first upload,
  // before that state update has been committed and re-rendered, so reading
  // the state variables here would see stale (pre-upload) values.
  async function runPreflight(
    currentHeaders: string[],
    currentRows: string[][],
    nextMapping: ColumnMapping[],
  ) {
    setIsValidating(true);
    setValidationError("");

    const result = await runImportPreflightAction({
      headers: currentHeaders,
      rows: currentRows,
      mapping: nextMapping,
    });

    setIsValidating(false);

    if (!result.success) {
      setValidationError(result.message);
      setPreflight(null);
      return;
    }

    setPreflight(result);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setUploadError("");

    if (file.size > IMPORT_FILE_SIZE_LIMIT_BYTES) {
      setUploadError("The CSV file is larger than the 5 MB import limit.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsUploading(true);
    const text = await file.text();
    const result = await parseImportFileAction(text);
    setIsUploading(false);

    if (!result.success) {
      setUploadError(result.message);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setHeaders(result.headers);
    setRows(result.rows);
    setFields(result.fields);
    setMapping(result.suggestedMapping);
    setPhase("review");
    await runPreflight(result.headers, result.rows, result.suggestedMapping);
  }

  async function handleMappingChange(columnIndex: number, fieldId: string) {
    const nextMapping = mapping.map((entry) =>
      entry.columnIndex === columnIndex
        ? { columnIndex, fieldId: fieldId === "" ? null : fieldId }
        : entry,
    );
    setMapping(nextMapping);
    await runPreflight(headers, rows, nextMapping);
  }

  async function handleCommit() {
    if (!preflight || preflight.errorCount > 0 || preflight.mappingErrors.length > 0) {
      return;
    }
    if (isImportingRef.current) {
      return;
    }
    isImportingRef.current = true;

    const currentImportId = importId || crypto.randomUUID();
    setImportId(currentImportId);
    setIsImporting(true);
    setImportError("");

    const result = await commitImportAction({
      headers,
      rows,
      mapping,
      importId: currentImportId,
    });

    isImportingRef.current = false;
    setIsImporting(false);

    if (!result.success) {
      setImportError(result.message);
      return;
    }

    setImportedCount(result.importedCount);
    setPhase("success");
  }

  function handleStartOver() {
    setPhase("upload");
    setUploadError("");
    setHeaders([]);
    setRows([]);
    setFields([]);
    setMapping([]);
    setPreflight(null);
    setValidationError("");
    setImportId("");
    setImportError("");
    setImportedCount(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  if (phase === "success") {
    return (
      <section className="mx-auto w-full max-w-3xl border border-grit bg-white p-6">
        <h2 className="text-xl font-semibold text-graphite">
          {importedCount} {importedCount === 1 ? "row" : "rows"} imported into {entityTypeName}.
        </h2>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href={`/entities/${entityTypeId}`}
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
          >
            View {entityTypeName}
          </Link>
          <button
            type="button"
            onClick={handleStartOver}
            className="h-10 border border-grit px-4 text-sm font-medium text-stone hover:bg-slab/5"
          >
            Import more rows
          </button>
        </div>
      </section>
    );
  }

  if (phase === "upload") {
    return (
      <section className="mx-auto w-full max-w-3xl border border-grit bg-white p-6">
        <SectionHeader title="Upload a CSV file" />
        <p className="mt-2 max-w-2xl text-sm leading-6 text-stone">
          The first row must be a header row. Each column will be mapped to a field on the next
          step.
        </p>
        <div className="mt-5">
          <label className="block text-sm font-medium text-graphite" htmlFor="import-csv-file">
            CSV file
          </label>
          <input
            ref={fileInputRef}
            id="import-csv-file"
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            disabled={isUploading}
            className="mt-2 block text-sm text-stone"
          />
          {isUploading ? <p className="mt-2 text-sm text-stone">Reading file...</p> : null}
          {uploadError ? (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {uploadError}
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  const previewRows = rows.slice(0, PREVIEW_ROW_CAP);
  const rowResultByNumber = new Map((preflight?.rows ?? []).map((row) => [row.rowNumber, row]));
  const allErrors = (preflight?.rows ?? []).flatMap((row) =>
    row.errors.map((error) => ({ rowNumber: row.rowNumber, ...error })),
  );
  const visibleErrors = allErrors.slice(0, PREVIEW_ROW_CAP);
  const canCommit =
    Boolean(preflight) &&
    preflight!.mappingErrors.length === 0 &&
    preflight!.errorCount === 0 &&
    !isValidating &&
    !isImporting;

  return (
    <div className="flex flex-col gap-6">
      <section className="border border-grit bg-white p-5">
        <SectionHeader
          title="Map columns to fields"
          description="Every column maps to one existing field, or is ignored. Suggestions are based on an exact name match and are always editable."
        />
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="bg-chalk text-xs uppercase tracking-wide text-stone">
              <tr>
                <th className="border-b border-grit px-3 py-2 font-medium">CSV column</th>
                <th className="border-b border-grit px-3 py-2 font-medium">Sample values</th>
                <th className="border-b border-grit px-3 py-2 font-medium">Field</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-chalk text-graphite">
              {headers.map((header, columnIndex) => {
                const mappedFieldId = mapping.find((entry) => entry.columnIndex === columnIndex)?.fieldId ?? "";

                return (
                  <tr key={columnIndex}>
                    <td className="px-3 py-2 font-medium">{header}</td>
                    <td className="px-3 py-2 text-stone">
                      {sampleValuesForColumn(rows, columnIndex)}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Field for column ${header}`}
                        value={mappedFieldId}
                        onChange={(event) => handleMappingChange(columnIndex, event.target.value)}
                        className="h-9 w-full max-w-xs border border-grit bg-paper px-2 text-sm text-graphite"
                      >
                        <option value="">Ignore</option>
                        {fields.map((field) => (
                          <option key={field.id} value={field.id}>
                            {field.name} ({fieldTypeLabel[field.type]}
                            {field.required ? ", required" : ""})
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-stone">
          Schema wrong?{" "}
          <Link
            href={`/entities/${entityTypeId}?manage=true`}
            className="underline-offset-4 hover:underline"
          >
            Go to Configure → Data Model
          </Link>{" "}
          to add or change fields, then come back and re-map.
        </p>
      </section>

      <section className="border border-grit bg-white p-5">
        <SectionHeader title="Review" />
        {validationError ? (
          <p className="mt-3 text-sm text-red-700" role="alert">
            {validationError}
          </p>
        ) : null}
        {preflight && preflight.mappingErrors.length > 0 ? (
          <div className="mt-3 border border-red-700 bg-red-50 p-3 text-sm text-red-700">
            <p className="font-medium">Fix your mapping before continuing:</p>
            <ul className="mt-1 list-disc pl-5">
              {preflight.mappingErrors.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {preflight && preflight.mappingErrors.length === 0 ? (
          <>
            <p className="mt-3 text-sm text-graphite">
              {isValidating ? (
                "Validating..."
              ) : (
                <>
                  <span className="font-semibold">{preflight.totalCount}</span> rows total
                  {" — "}
                  <span className="font-semibold text-status-sage">{preflight.readyCount}</span> ready
                  {" — "}
                  <span className={preflight.errorCount > 0 ? "font-semibold text-red-700" : "font-semibold"}>
                    {preflight.errorCount}
                  </span>{" "}
                  with errors
                </>
              )}
            </p>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[480px] border-collapse text-left text-sm">
                <thead className="bg-chalk text-xs uppercase tracking-wide text-stone">
                  <tr>
                    <th className="border-b border-grit px-3 py-2 font-medium">Row</th>
                    {headers.map((header) => (
                      <th key={header} className="border-b border-grit px-3 py-2 font-medium">
                        {header}
                      </th>
                    ))}
                    <th className="border-b border-grit px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-chalk text-graphite">
                  {previewRows.map((row, index) => {
                    const rowNumber = index + 1;
                    const rowResult = rowResultByNumber.get(rowNumber);

                    return (
                      <tr key={rowNumber}>
                        <td className="px-3 py-2 text-stone">{rowNumber}</td>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="px-3 py-2">
                            {cell || "—"}
                          </td>
                        ))}
                        <td className="px-3 py-2">
                          {!rowResult ? (
                            <span className="text-xs text-stone">—</span>
                          ) : rowResult.status === "error" ? (
                            <span className="border border-red-700 px-2 py-0.5 text-xs font-medium text-red-700">
                              Error
                            </span>
                          ) : (
                            <span className="border border-grit px-2 py-0.5 text-xs font-medium text-stone">
                              Ready
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length > PREVIEW_ROW_CAP ? (
                <p className="mt-2 text-sm text-stone">
                  Showing {PREVIEW_ROW_CAP} of {rows.length} rows. Validation covers all rows.
                </p>
              ) : null}
            </div>

            {allErrors.length > 0 ? (
              <div className="mt-5">
                <h3 className="text-sm font-semibold text-graphite">Rows with errors</h3>
                <ul className="mt-2 divide-y divide-chalk border-y border-chalk text-sm">
                  {visibleErrors.map((error, index) => (
                    <li key={index} className="py-2">
                      <span className="font-medium text-graphite">Row {error.rowNumber}</span>
                      <span className="text-stone"> · {error.column} — </span>
                      <span className="text-red-700">{error.message}</span>
                    </li>
                  ))}
                </ul>
                {allErrors.length > visibleErrors.length ? (
                  <p className="mt-2 text-sm text-stone">
                    Showing {visibleErrors.length} of {allErrors.length} errors.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {importError ? (
          <p className="mt-4 text-sm text-red-700" role="alert">
            {importError}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleCommit}
            disabled={!canCommit}
            className="h-10 bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
          >
            {isImporting ? "Importing..." : "Import"}
          </button>
          <button
            type="button"
            onClick={handleStartOver}
            disabled={isImporting}
            className="h-10 border border-grit px-4 text-sm font-medium text-stone hover:bg-slab/5"
          >
            Start over
          </button>
        </div>
      </section>
    </div>
  );
}
