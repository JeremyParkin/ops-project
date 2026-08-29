// One-off, manually-run scale check for the CSV import pipeline (Phase
// 8C.2) -- deliberately NOT a Vitest/Playwright spec (not part of
// `npm run test:unit` or `npm run test:e2e`), since a 5,000-row synchronous
// commit is explicitly meant to be exercised outside normal CI. Creates and
// tears down its own disposable fixture entity; does not touch the
// dogfood.worker/dogfood.builder accounts.
//
// Run with: npx tsx scripts/manual-import-scale-check.ts
import { randomUUID } from "node:crypto";
import { parseCsvFile } from "../lib/domain/csv-parsing";
import { buildImportPreflight, suggestColumnMappings } from "../lib/domain/record-import";
import { getEntityContext } from "../lib/domain/metadata-repository";
import { bulkCreateEntityRecords } from "../lib/domain/record-repository";
import {
  cleanupE2eRun,
  createEntity,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
} from "../tests/e2e/helpers/supabase-test-data";

const ROW_COUNT = 5000;

function buildCsv(run: { label: string }, rowCount: number) {
  const header = "Name,Start Date,Status\n";
  const lines: string[] = [];
  for (let i = 1; i <= rowCount; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    lines.push(`${run.label} Row ${i},2026-01-${day},Active`);
  }
  return header + lines.join("\n") + "\n";
}

async function main() {
  const supabase = createSupabaseTestClient();
  const run = createTestRun();

  try {
    const entity = await createEntity(supabase, run, "Import Scale 5000", [
      { slug: "name", name: "Name", type: "text", required: true },
      { slug: "start_date", name: "Start Date", type: "date" },
      { slug: "status", name: "Status", type: "text" },
    ]);
    const { fields } = await getEntityContext({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: entity.id,
      supabase,
    });

    const csv = buildCsv(run, ROW_COUNT);
    console.log(`CSV size: ${(Buffer.byteLength(csv, "utf8") / 1024).toFixed(1)} KB`);

    const t0 = performance.now();
    const parsed = parseCsvFile(csv);
    const t1 = performance.now();
    if (!parsed.success) {
      throw new Error(`Parse failed: ${parsed.error}`);
    }
    console.log(`Parse: ${(t1 - t0).toFixed(0)}ms, ${parsed.data.rows.length} data rows`);

    const mapping = suggestColumnMappings(parsed.data.headers, fields);

    const t2 = performance.now();
    const preflight = await buildImportPreflight({
      workspaceId: DEMO_WORKSPACE_ID,
      supabase,
      fields,
      headers: parsed.data.headers,
      dataRows: parsed.data.rows,
      mapping,
    });
    const t3 = performance.now();
    console.log(
      `Preflight: ${(t3 - t2).toFixed(0)}ms -- ${preflight.readyCount} ready, ${preflight.errorCount} errors, ${preflight.totalCount} total`,
    );

    if (preflight.errorCount > 0 || preflight.readyCount !== ROW_COUNT) {
      throw new Error(
        `Expected ${ROW_COUNT} ready rows with zero errors, got ${preflight.readyCount} ready / ${preflight.errorCount} errors`,
      );
    }

    const importId = randomUUID();
    const t4 = performance.now();
    const importedCount = await bulkCreateEntityRecords({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: entity.id,
      fields,
      rows: preflight.rows.map((row) => row.values),
      importId,
      supabase,
    });
    const t5 = performance.now();
    console.log(`Commit: ${(t5 - t4).toFixed(0)}ms -- imported ${importedCount} rows`);

    if (importedCount !== ROW_COUNT) {
      throw new Error(`Expected commit to report ${ROW_COUNT}, got ${importedCount}`);
    }

    const { count: rowCountAfterCommit, error: countError } = await supabase
      .from("entity_records")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("entity_type_id", entity.id);
    if (countError) throw new Error(countError.message);
    console.log(`Actual entity_records rows for this entity: ${rowCountAfterCommit}`);
    if (rowCountAfterCommit !== ROW_COUNT) {
      throw new Error(`Expected exactly ${ROW_COUNT} committed rows, found ${rowCountAfterCommit}`);
    }

    // Retry the exact same import id -- proves the idempotency boundary
    // holds at this scale too, not just on the small fixtures in the unit
    // suite, and confirms a retry never creates duplicate rows.
    const t6 = performance.now();
    const retryCount = await bulkCreateEntityRecords({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: entity.id,
      fields,
      rows: preflight.rows.map((row) => row.values),
      importId,
      supabase,
    });
    const t7 = performance.now();
    console.log(`Retry (same import id): ${(t7 - t6).toFixed(0)}ms -- reported ${retryCount} rows`);
    if (retryCount !== ROW_COUNT) {
      throw new Error(`Expected retry to report the cached ${ROW_COUNT}, got ${retryCount}`);
    }

    const { count: rowCountAfterRetry, error: retryCountError } = await supabase
      .from("entity_records")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("entity_type_id", entity.id);
    if (retryCountError) throw new Error(retryCountError.message);
    console.log(`Actual entity_records rows after retry: ${rowCountAfterRetry}`);
    if (rowCountAfterRetry !== ROW_COUNT) {
      throw new Error(
        `Retry created duplicates: expected ${ROW_COUNT}, found ${rowCountAfterRetry}`,
      );
    }

    console.log(`\nTotal end-to-end (parse + preflight + commit): ${(t5 - t0).toFixed(0)}ms`);
    console.log("PASS: 5,000-row import completed synchronously with an exact, non-duplicated count.");
  } finally {
    await cleanupE2eRun(run);
    console.log(`Cleaned up fixture run ${run.label}.`);
  }
}

main().catch((error) => {
  console.error("FAIL:", error);
  process.exitCode = 1;
});
