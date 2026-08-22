import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestEntity,
  type TestRun,
} from "./helpers/supabase-test-data";
import {
  addRecordSection,
  fillRecordField,
  gotoEntity,
  submitAddRecord,
} from "./helpers/ui";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);

  return run;
}

async function createRequiredSafetyEntity(run: TestRun, suffix: string) {
  const supabase = createSupabaseTestClient();

  return createEntity(supabase, run, suffix, [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
}

async function addFieldViaRpc({
  entity,
  name,
  type = "text",
  required = false,
  relatedEntityTypeId = null,
}: {
  entity: TestEntity;
  name: string;
  type?: "text" | "number" | "date" | "boolean" | "relation";
  required?: boolean;
  relatedEntityTypeId?: string | null;
}) {
  const supabase = createSupabaseTestClient();

  return supabase.rpc("add_field_definition", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_name: name,
    p_slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`,
    p_key: `fld_e2e_${randomUUID().replace(/-/g, "_")}`,
    p_type: type,
    p_required: required,
    p_related_entity_type_id: relatedEntityTypeId,
  });
}

async function createRecordViaRpc({
  entity,
  values,
  relations = [],
}: {
  entity: TestEntity;
  values: Record<string, unknown>;
  relations?: Array<{
    field_definition_id: string;
    target_entity_type_id: string;
    target_record_id: string;
  }>;
}) {
  const supabase = createSupabaseTestClient();

  return supabase.rpc("create_entity_record_with_relations", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_values: values,
    p_relations: relations,
  });
}

test("optional field can be added when records exist", async () => {
  const run = createScenarioRun();
  const entity = await createRequiredSafetyEntity(run, "Optional Field Entity");

  await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Existing` },
  });

  const result = await addFieldViaRpc({
    entity,
    name: "Optional Notes",
  });

  expect(result.error).toBeNull();
  expect(typeof result.data).toBe("string");
});

test("required field cannot be added when active records exist", async () => {
  const run = createScenarioRun();
  const entity = await createRequiredSafetyEntity(run, "Active Record Entity");

  await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Existing` },
  });

  const result = await addFieldViaRpc({
    entity,
    name: "Required Notes",
    required: true,
  });

  expect(result.error?.message).toContain(
    "Required fields can only be added before this entity has records",
  );
});

test("required field cannot be added when only archived records exist", async () => {
  const run = createScenarioRun();
  const entity = await createRequiredSafetyEntity(run, "Archived Record Entity");
  const supabase = createSupabaseTestClient();
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Archived` },
  });

  const archiveResult = await supabase
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id)
    .eq("id", recordId);

  expect(archiveResult.error).toBeNull();

  const result = await addFieldViaRpc({
    entity,
    name: "Required After Archive",
    required: true,
  });

  expect(result.error?.message).toContain(
    "Required fields can only be added before this entity has records",
  );
});

test("direct record-creation RPC rejects missing required primitive field", async () => {
  const run = createScenarioRun();
  const entity = await createRequiredSafetyEntity(run, "Primitive Required Entity");

  const result = await createRecordViaRpc({
    entity,
    values: {},
  });

  expect(result.error?.message).toContain("Name is required.");
});

test("direct record-creation RPC rejects missing required relation field", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Required Relation Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const task = await createEntity(supabase, run, "Required Relation Task", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      required: true,
      relatedEntityTypeId: client.id,
    },
  ]);

  const result = await createRecordViaRpc({
    entity: task,
    values: {
      [task.fields.title.key]: `${run.label} Task`,
    },
  });

  expect(result.error?.message).toContain("Client is required.");
});

test("direct record-creation RPC accepts valid required primitive and relation values", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Valid Required Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const task = await createEntity(supabase, run, "Valid Required Task", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      required: true,
      relatedEntityTypeId: client.id,
    },
  ]);
  const clientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Client` },
  });

  const result = await createRecordViaRpc({
    entity: task,
    values: {
      [task.fields.title.key]: `${run.label} Task`,
    },
    relations: [
      {
        field_definition_id: task.fields.client.id,
        target_entity_type_id: client.id,
        target_record_id: clientRecordId,
      },
    ],
  });

  expect(result.error).toBeNull();
  expect(typeof result.data).toBe("string");
});

test("existing UI friendly validation still prevents adding required fields after records exist", async ({
  page,
}) => {
  const run = createScenarioRun();
  const entity = await createRequiredSafetyEntity(run, "Friendly UI Entity");

  await gotoEntity(page, entity);
  const form = addRecordSection(page, entity);
  await fillRecordField(form, entity.fields.name, `${run.label} UI Record`);
  await submitAddRecord(page, entity);
  await expect(page.getByText(`${entity.name} created.`)).toBeVisible();

  const addFieldSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Add Field", exact: true }),
  });

  await addFieldSection.getByLabel("Field Name").fill("Required Later");
  await addFieldSection.getByLabel("Required").check();
  await addFieldSection.getByRole("button", { name: "Add Field" }).click();

  await expect(
    page.getByText("Required fields can only be added before this entity has records."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Add this field as optional, or add required fields before creating records.",
    ),
  ).toBeVisible();
});
