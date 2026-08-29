// Relation resolution needs live target records to match against, so these
// run against the real (dev/E2E) Supabase project via the same admin-client
// fixture helpers the Playwright suite uses -- not a browser, just Node
// hitting the database directly. Kept separate from record-import.test.ts
// so the pure, dependency-free unit tests stay fast and obviously isolated.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildImportPreflight } from "./record-import";
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

afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
});

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function createTargetAndSourceFixture(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const target = await createEntity(supabase, run, "Import Relation Target", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const source = await createEntity(supabase, run, "Import Relation Source", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "account",
      name: "Account",
      type: "relation",
      relatedEntityTypeId: target.id,
    },
  ]);
  const sourceContext = await getEntityContext({
    workspaceId: DEMO_WORKSPACE_ID,
    entityTypeId: source.id,
    supabase,
  });

  return { target, source, sourceFields: sourceContext.fields };
}

describe("buildImportPreflight relation resolution", () => {
  it("resolves an exact UUID cell to that target record", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { target, source, sourceFields } = await createTargetAndSourceFixture(run);
    const targetId = await createEntityRecord({
      entity: target,
      valuesBySlug: { name: `${run.label} Acme` },
    });

    const result = await buildImportPreflight({
      workspaceId: DEMO_WORKSPACE_ID,
      supabase,
      fields: sourceFields,
      headers: ["Title", "Account"],
      dataRows: [[`${run.label} Deal`, targetId]],
      mapping: [
        { columnIndex: 0, fieldId: source.fields.title.id },
        { columnIndex: 1, fieldId: source.fields.account.id },
      ],
    });

    expect(result.readyCount).toBe(1);
    expect(result.rows[0].values[source.fields.account.key]).toBe(targetId);
  });

  it("resolves a unique exact display-label match", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { target, source, sourceFields } = await createTargetAndSourceFixture(run);
    const targetId = await createEntityRecord({
      entity: target,
      valuesBySlug: { name: `${run.label} Acme` },
    });

    const result = await buildImportPreflight({
      workspaceId: DEMO_WORKSPACE_ID,
      supabase,
      fields: sourceFields,
      headers: ["Title", "Account"],
      dataRows: [[`${run.label} Deal`, `${run.label} Acme`]],
      mapping: [
        { columnIndex: 0, fieldId: source.fields.title.id },
        { columnIndex: 1, fieldId: source.fields.account.id },
      ],
    });

    expect(result.readyCount).toBe(1);
    expect(result.rows[0].values[source.fields.account.key]).toBe(targetId);
  });

  it("blocks a row when the relation label matches nothing", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { source, sourceFields } = await createTargetAndSourceFixture(run);

    const result = await buildImportPreflight({
      workspaceId: DEMO_WORKSPACE_ID,
      supabase,
      fields: sourceFields,
      headers: ["Title", "Account"],
      dataRows: [[`${run.label} Deal`, `${run.label} Nonexistent`]],
      mapping: [
        { columnIndex: 0, fieldId: source.fields.title.id },
        { columnIndex: 1, fieldId: source.fields.account.id },
      ],
    });

    expect(result.errorCount).toBe(1);
    expect(result.rows[0].errors[0].message).toMatch(/No .* matches/);
  });

  it("blocks a row when the relation label matches more than one target record", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { target, source, sourceFields } = await createTargetAndSourceFixture(run);
    const sharedName = `${run.label} Ambiguous`;
    await createEntityRecord({ entity: target, valuesBySlug: { name: sharedName } });
    await createEntityRecord({ entity: target, valuesBySlug: { name: sharedName } });

    const result = await buildImportPreflight({
      workspaceId: DEMO_WORKSPACE_ID,
      supabase,
      fields: sourceFields,
      headers: ["Title", "Account"],
      dataRows: [[`${run.label} Deal`, sharedName]],
      mapping: [
        { columnIndex: 0, fieldId: source.fields.title.id },
        { columnIndex: 1, fieldId: source.fields.account.id },
      ],
    });

    expect(result.errorCount).toBe(1);
    expect(result.rows[0].errors[0].message).toMatch(/Multiple .* match/);
  });

  it("blocks a row whose relation value resolves only to an archived target", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { target, source, sourceFields } = await createTargetAndSourceFixture(run);
    const archivedName = `${run.label} Archived Account`;
    const archivedId = await createEntityRecord({
      entity: target,
      valuesBySlug: { name: archivedName },
    });
    const archiveResult = await supabase
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("id", archivedId);
    expect(archiveResult.error).toBeNull();

    const result = await buildImportPreflight({
      workspaceId: DEMO_WORKSPACE_ID,
      supabase,
      fields: sourceFields,
      headers: ["Title", "Account"],
      dataRows: [[`${run.label} Deal`, archivedName]],
      mapping: [
        { columnIndex: 0, fieldId: source.fields.title.id },
        { columnIndex: 1, fieldId: source.fields.account.id },
      ],
    });

    expect(result.errorCount).toBe(1);
    expect(result.rows[0].errors[0].message).toMatch(/archived/i);
  });

  it("does not resolve a label that only matches a record in a different workspace", async () => {
    const run = scenarioRun();
    const supabase = createSupabaseTestClient();
    const { source, sourceFields } = await createTargetAndSourceFixture(run);
    const foreignOnlyLabel = `${run.label} Foreign Workspace Account`;

    // A fully independent workspace, with its own entity type of the same
    // shape and a record whose label would match if resolution ever
    // ignored workspace boundaries. resolveRelationValues only ever queries
    // field.relatedEntityTypeId (itself workspace-scoped), so this foreign
    // entity type is structurally unreachable from the real import below --
    // this test is a regression guard for that, not a discovery.
    const foreignWorkspaceId = randomUUID();
    const { error: workspaceError } = await supabase
      .from("workspaces")
      .insert({ id: foreignWorkspaceId, name: `Import Isolation ${foreignWorkspaceId.slice(0, 8)}` });
    expect(workspaceError).toBeNull();

    const foreignEntityTypeId = randomUUID();
    const { error: entityTypeError } = await supabase.from("entity_types").insert({
      id: foreignEntityTypeId,
      workspace_id: foreignWorkspaceId,
      name: "Foreign Target",
      slug: `foreign-target-${foreignWorkspaceId.slice(0, 8)}`,
    });
    expect(entityTypeError).toBeNull();
    const { error: fieldError } = await supabase.from("field_definitions").insert({
      id: randomUUID(),
      workspace_id: foreignWorkspaceId,
      entity_type_id: foreignEntityTypeId,
      key: `fld_foreign_${foreignWorkspaceId.slice(0, 8)}`,
      name: "Name",
      slug: "name",
      type: "text",
      required: true,
      position: 1,
    });
    expect(fieldError).toBeNull();
    const { error: recordError } = await supabase.from("entity_records").insert({
      id: randomUUID(),
      workspace_id: foreignWorkspaceId,
      entity_type_id: foreignEntityTypeId,
      values: { [`fld_foreign_${foreignWorkspaceId.slice(0, 8)}`]: foreignOnlyLabel },
    });
    expect(recordError).toBeNull();

    const result = await buildImportPreflight({
      workspaceId: DEMO_WORKSPACE_ID,
      supabase,
      fields: sourceFields,
      headers: ["Title", "Account"],
      dataRows: [[`${run.label} Deal`, foreignOnlyLabel]],
      mapping: [
        { columnIndex: 0, fieldId: source.fields.title.id },
        { columnIndex: 1, fieldId: source.fields.account.id },
      ],
    });

    expect(result.errorCount).toBe(1);
    expect(result.rows[0].errors[0].message).toMatch(/No .* matches/);

    const { error: cleanupError } = await supabase.from("workspaces").delete().eq("id", foreignWorkspaceId);
    expect(cleanupError).toBeNull();
  });
});
