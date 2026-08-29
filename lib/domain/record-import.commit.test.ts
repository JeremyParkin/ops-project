// Commit-level coverage for bulk_create_entity_records_authorized (migration
// 0061): atomicity and the import-batch idempotency boundary. Runs against
// the real Supabase project via the same admin-client fixture helpers as
// record-import.relations.test.ts -- these assert on actual committed rows,
// not just preflight output, so they belong here rather than in the pure
// unit tests.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { bulkCreateEntityRecords } from "./record-repository";
import { getEntityContext } from "./metadata-repository";
import {
  cleanupE2eRun,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestRun,
} from "../../tests/e2e/helpers/supabase-test-data";

const runs: TestRun[] = [];
const foreignWorkspaceIds: string[] = [];

afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }

  if (foreignWorkspaceIds.length > 0) {
    const supabase = createSupabaseTestClient();
    await supabase.from("workspaces").delete().in("id", foreignWorkspaceIds);
  }
});

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function createImportEntity(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Import Commit Target", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const context = await getEntityContext({
    workspaceId: DEMO_WORKSPACE_ID,
    entityTypeId: entity.id,
    supabase,
  });

  return { entity, fields: context.fields };
}

async function countRecords(entityTypeId: string) {
  const supabase = createSupabaseTestClient();
  const { data, error } = await supabase
    .from("entity_records")
    .select("id, values")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entityTypeId);
  expect(error).toBeNull();
  return data ?? [];
}

describe("bulkCreateEntityRecords commit behavior", () => {
  it("commits a clean batch and every row is queryable afterward", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, fields } = await createImportEntity(run);
    const nameKey = entity.fields.name.key;

    const importedCount = await bulkCreateEntityRecords({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: entity.id,
      fields,
      rows: [
        { [nameKey]: `${run.label} Acme` },
        { [nameKey]: `${run.label} Globex` },
        { [nameKey]: `${run.label} Initech` },
      ],
      importId: randomUUID(),
      supabase,
    });

    expect(importedCount).toBe(3);
    const records = await countRecords(entity.id);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.values[nameKey]).sort()).toEqual(
      [`${run.label} Acme`, `${run.label} Globex`, `${run.label} Initech`].sort(),
    );
  });

  it("is fully atomic: a batch with one invalid row inserts zero records", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, fields } = await createImportEntity(run);
    const nameKey = entity.fields.name.key;

    await expect(
      bulkCreateEntityRecords({
        workspaceId: DEMO_WORKSPACE_ID,
        entityTypeId: entity.id,
        fields,
        rows: [
          { [nameKey]: `${run.label} Valid One` },
          { [nameKey]: `${run.label} Valid Two` },
          // Missing the required "name" value -- the RPC's required-field
          // defense-in-depth check should reject this row and roll back
          // the whole transaction, including the two valid rows above it.
          {},
        ],
        importId: randomUUID(),
        supabase,
      }),
    ).rejects.toThrow(/Name is required/);

    const records = await countRecords(entity.id);
    expect(records).toHaveLength(0);
  });

  it("treats a retry with the same import id, workspace, and entity type as a safe no-op", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, fields } = await createImportEntity(run);
    const nameKey = entity.fields.name.key;
    const importId = randomUUID();
    const rows = [{ [nameKey]: `${run.label} Retry Row` }];

    const firstCount = await bulkCreateEntityRecords({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: entity.id,
      fields,
      rows,
      importId,
      supabase,
    });
    const secondCount = await bulkCreateEntityRecords({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: entity.id,
      fields,
      rows,
      importId,
      supabase,
    });

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
    const records = await countRecords(entity.id);
    expect(records).toHaveLength(1);
  });

  it("rejects reuse of an import id already claimed by a different workspace", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity, fields } = await createImportEntity(run);
    const nameKey = entity.fields.name.key;
    const importId = randomUUID();

    const originalCount = await bulkCreateEntityRecords({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: entity.id,
      fields,
      rows: [{ [nameKey]: `${run.label} Owner Workspace Row` }],
      importId,
      supabase,
    });
    expect(originalCount).toBe(1);

    // Built with raw inserts (not createEntity, which always targets
    // DEMO_WORKSPACE_ID) so the fixture is a fully independent workspace,
    // matching the pattern already used by record-import.relations.test.ts's
    // cross-workspace isolation test.
    const foreignWorkspaceId = randomUUID();
    foreignWorkspaceIds.push(foreignWorkspaceId);
    const { error: workspaceError } = await supabase
      .from("workspaces")
      .insert({ id: foreignWorkspaceId, name: `Import Idempotency ${foreignWorkspaceId.slice(0, 8)}` });
    expect(workspaceError).toBeNull();

    const foreignEntityTypeId = randomUUID();
    const { error: entityTypeError } = await supabase.from("entity_types").insert({
      id: foreignEntityTypeId,
      workspace_id: foreignWorkspaceId,
      name: "Foreign Workspace Target",
      slug: `foreign-workspace-target-${foreignWorkspaceId.slice(0, 8)}`,
    });
    expect(entityTypeError).toBeNull();
    const foreignFieldKey = `fld_foreign_${foreignWorkspaceId.slice(0, 8)}`;
    const { error: fieldError } = await supabase.from("field_definitions").insert({
      id: randomUUID(),
      workspace_id: foreignWorkspaceId,
      entity_type_id: foreignEntityTypeId,
      key: foreignFieldKey,
      name: "Name",
      slug: "name",
      type: "text",
      required: true,
      position: 1,
    });
    expect(fieldError).toBeNull();
    const foreignContext = await getEntityContext({
      workspaceId: foreignWorkspaceId,
      entityTypeId: foreignEntityTypeId,
      supabase,
    });

    await expect(
      bulkCreateEntityRecords({
        workspaceId: foreignWorkspaceId,
        entityTypeId: foreignEntityTypeId,
        fields: foreignContext.fields,
        rows: [{ [foreignFieldKey]: `${run.label} Foreign Row` }],
        importId,
        supabase,
      }),
    ).rejects.toThrow(/Import ID already used for a different object/);

    const foreignRecords = await supabase
      .from("entity_records")
      .select("id")
      .eq("workspace_id", foreignWorkspaceId)
      .eq("entity_type_id", foreignEntityTypeId);
    expect(foreignRecords.data ?? []).toHaveLength(0);

    const originalWorkspaceRecords = await countRecords(entity.id);
    expect(originalWorkspaceRecords).toHaveLength(1);
  });

  it("rejects reuse of an import id already claimed by a different entity type in the same workspace", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { entity: firstEntity, fields: firstFields } = await createImportEntity(run);
    const secondEntity = await createEntity(supabase, run, "Import Commit Target Two", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const secondContext = await getEntityContext({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: secondEntity.id,
      supabase,
    });
    const importId = randomUUID();

    const firstCount = await bulkCreateEntityRecords({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: firstEntity.id,
      fields: firstFields,
      rows: [{ [firstEntity.fields.name.key]: `${run.label} First Entity Row` }],
      importId,
      supabase,
    });
    expect(firstCount).toBe(1);

    await expect(
      bulkCreateEntityRecords({
        workspaceId: DEMO_WORKSPACE_ID,
        entityTypeId: secondEntity.id,
        fields: secondContext.fields,
        rows: [{ [secondEntity.fields.name.key]: `${run.label} Second Entity Row` }],
        importId,
        supabase,
      }),
    ).rejects.toThrow(/Import ID already used for a different object/);

    const secondEntityRecords = await countRecords(secondEntity.id);
    expect(secondEntityRecords).toHaveLength(0);
    const firstEntityRecords = await countRecords(firstEntity.id);
    expect(firstEntityRecords).toHaveLength(1);
  });

  it("imports relation values end to end via UUID and label resolution together", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const target = await createEntity(supabase, run, "Import Commit Relation Target", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const source = await createEntity(supabase, run, "Import Commit Relation Source", [
      { slug: "title", name: "Title", type: "text", required: true },
      { slug: "account", name: "Account", type: "relation", relatedEntityTypeId: target.id },
    ]);
    const sourceContext = await getEntityContext({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: source.id,
      supabase,
    });
    const acmeId = await createEntityRecord({
      entity: target,
      valuesBySlug: { name: `${run.label} Acme` },
    });
    const globexId = await createEntityRecord({
      entity: target,
      valuesBySlug: { name: `${run.label} Globex` },
    });

    const { buildImportPreflight } = await import("./record-import");
    const preflight = await buildImportPreflight({
      workspaceId: DEMO_WORKSPACE_ID,
      supabase,
      fields: sourceContext.fields,
      headers: ["Title", "Account"],
      dataRows: [
        [`${run.label} Deal One`, acmeId],
        [`${run.label} Deal Two`, `${run.label} Globex`],
      ],
      mapping: [
        { columnIndex: 0, fieldId: source.fields.title.id },
        { columnIndex: 1, fieldId: source.fields.account.id },
      ],
    });
    expect(preflight.readyCount).toBe(2);

    const importedCount = await bulkCreateEntityRecords({
      workspaceId: DEMO_WORKSPACE_ID,
      entityTypeId: source.id,
      fields: sourceContext.fields,
      rows: preflight.rows.map((row) => row.values),
      importId: randomUUID(),
      supabase,
    });
    expect(importedCount).toBe(2);

    const { data: relationRows, error } = await supabase
      .from("entity_record_relation_values")
      .select("source_record_id, target_record_id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("field_definition_id", source.fields.account.id);
    expect(error).toBeNull();
    expect((relationRows ?? []).map((r) => r.target_record_id).sort()).toEqual(
      [acmeId, globexId].sort(),
    );
  });
});
