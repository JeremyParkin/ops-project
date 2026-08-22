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

async function updateRecordViaRpc({
  entity,
  recordId,
  values,
  relationFieldIds = [],
  relations = [],
}: {
  entity: TestEntity;
  recordId: string;
  values: Record<string, unknown>;
  relationFieldIds?: string[];
  relations?: Array<{
    field_definition_id: string;
    target_entity_type_id: string;
    target_record_id: string;
  }>;
}) {
  const supabase = createSupabaseTestClient();

  return supabase.rpc("update_entity_record_with_relations", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_record_id: recordId,
    p_values: values,
    p_relation_field_ids: relationFieldIds,
    p_relations: relations,
  });
}

async function createPrimitiveEntity(run: TestRun) {
  const supabase = createSupabaseTestClient();

  return createEntity(supabase, run, "Required Update Primitive", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "amount", name: "Amount", type: "number", required: true },
    { slug: "due-date", name: "Due Date", type: "date", required: true },
    { slug: "approved", name: "Approved", type: "boolean", required: true },
  ]);
}

function validPrimitiveValues(entity: TestEntity, run: TestRun) {
  return {
    [entity.fields.name.key]: `${run.label} Updated`,
    [entity.fields.amount.key]: 42,
    [entity.fields["due-date"].key]: "2026-08-16",
    [entity.fields.approved.key]: true,
  };
}

test("direct update RPC rejects clearing required text", async () => {
  const run = createScenarioRun();
  const entity = await createPrimitiveEntity(run);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: {
      name: `${run.label} Original`,
      amount: 1,
      "due-date": "2026-08-15",
      approved: true,
    },
  });

  const result = await updateRecordViaRpc({
    entity,
    recordId,
    values: {
      ...validPrimitiveValues(entity, run),
      [entity.fields.name.key]: "",
    },
  });

  expect(result.error?.message).toContain("Name is required.");
});

test("direct update RPC rejects missing or invalid required number, date, and boolean values", async () => {
  const run = createScenarioRun();
  const entity = await createPrimitiveEntity(run);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: {
      name: `${run.label} Original`,
      amount: 1,
      "due-date": "2026-08-15",
      approved: true,
    },
  });
  const baseValues = validPrimitiveValues(entity, run);

  const missingNumber = await updateRecordViaRpc({
    entity,
    recordId,
    values: {
      [entity.fields.name.key]: baseValues[entity.fields.name.key],
      [entity.fields["due-date"].key]: baseValues[entity.fields["due-date"].key],
      [entity.fields.approved.key]: baseValues[entity.fields.approved.key],
    },
  });
  expect(missingNumber.error?.message).toContain("Amount is required.");

  const invalidDate = await updateRecordViaRpc({
    entity,
    recordId,
    values: {
      ...baseValues,
      [entity.fields["due-date"].key]: "2026-02-31",
    },
  });
  expect(invalidDate.error?.message).toContain("Due Date is required.");

  const invalidBoolean = await updateRecordViaRpc({
    entity,
    recordId,
    values: {
      ...baseValues,
      [entity.fields.approved.key]: "false",
    },
  });
  expect(invalidBoolean.error?.message).toContain("Approved is required.");
});

test("required boolean false and valid direct primitive update succeed", async () => {
  const run = createScenarioRun();
  const entity = await createPrimitiveEntity(run);
  const supabase = createSupabaseTestClient();
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: {
      name: `${run.label} Original`,
      amount: 1,
      "due-date": "2026-08-15",
      approved: true,
    },
  });

  const result = await updateRecordViaRpc({
    entity,
    recordId,
    values: {
      ...validPrimitiveValues(entity, run),
      [entity.fields.approved.key]: false,
    },
  });

  expect(result.error).toBeNull();

  const { data, error } = await supabase
    .from("entity_records")
    .select("values")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id)
    .eq("id", recordId)
    .single<{ values: Record<string, unknown> }>();

  expect(error).toBeNull();
  expect(data?.values[entity.fields.approved.key]).toBe(false);
});

async function createRelationScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Required Update Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const task = await createEntity(supabase, run, "Required Update Task", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      required: true,
      relatedEntityTypeId: client.id,
    },
    {
      slug: "reviewer",
      name: "Reviewer",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const firstClientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Alpha` },
  });
  const secondClientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Beta` },
  });
  const taskRecordId = await createEntityRecord({
    entity: task,
    valuesBySlug: { title: `${run.label} Task` },
    relationsBySlug: { client: firstClientRecordId },
  });

  return {
    client,
    task,
    firstClientRecordId,
    secondClientRecordId,
    taskRecordId,
  };
}

test("direct update RPC rejects clearing required relation", async () => {
  const run = createScenarioRun();
  const { task, taskRecordId } = await createRelationScenario(run);

  const result = await updateRecordViaRpc({
    entity: task,
    recordId: taskRecordId,
    values: {
      [task.fields.title.key]: `${run.label} Updated Task`,
    },
    relationFieldIds: [task.fields.client.id],
  });

  expect(result.error?.message).toContain("Client is required.");
});

test("updating unrelated relation preserves an existing required relation", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { client, task, firstClientRecordId, secondClientRecordId, taskRecordId } =
    await createRelationScenario(run);

  const result = await updateRecordViaRpc({
    entity: task,
    recordId: taskRecordId,
    values: {
      [task.fields.title.key]: `${run.label} Reviewer Update`,
    },
    relationFieldIds: [task.fields.reviewer.id],
    relations: [
      {
        field_definition_id: task.fields.reviewer.id,
        target_entity_type_id: client.id,
        target_record_id: secondClientRecordId,
      },
    ],
  });

  expect(result.error).toBeNull();

  const { data, error } = await supabase
    .from("entity_record_relation_values")
    .select("field_definition_id, target_record_id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("source_entity_type_id", task.id)
    .eq("source_record_id", taskRecordId)
    .returns<Array<{ field_definition_id: string; target_record_id: string }>>();

  expect(error).toBeNull();
  expect(
    data?.find((relation) => relation.field_definition_id === task.fields.client.id)
      ?.target_record_id,
  ).toBe(firstClientRecordId);
  expect(
    data?.find((relation) => relation.field_definition_id === task.fields.reviewer.id)
      ?.target_record_id,
  ).toBe(secondClientRecordId);
});

test("replacing a required relation with another valid target succeeds", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { client, task, secondClientRecordId, taskRecordId } =
    await createRelationScenario(run);

  const result = await updateRecordViaRpc({
    entity: task,
    recordId: taskRecordId,
    values: {
      [task.fields.title.key]: `${run.label} Replacement`,
    },
    relationFieldIds: [task.fields.client.id],
    relations: [
      {
        field_definition_id: task.fields.client.id,
        target_entity_type_id: client.id,
        target_record_id: secondClientRecordId,
      },
    ],
  });

  expect(result.error).toBeNull();

  const { data, error } = await supabase
    .from("entity_record_relation_values")
    .select("target_record_id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("source_entity_type_id", task.id)
    .eq("source_record_id", taskRecordId)
    .eq("field_definition_id", task.fields.client.id)
    .single<{ target_record_id: string }>();

  expect(error).toBeNull();
  expect(data?.target_record_id).toBe(secondClientRecordId);
});

test("updates preserve archived primitive data without reviving orphan JSON keys", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Archived Primitive Preserve", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "legacy", name: "Legacy", type: "text" },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: {
      name: `${run.label} Original`,
      legacy: "keep me",
    },
  });

  const seedResult = await supabase
    .from("entity_records")
    .update({
      values: {
        [entity.fields.name.key]: `${run.label} Original`,
        [entity.fields.legacy.key]: "keep me",
        orphan_key: "drop me",
      },
    })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id)
    .eq("id", recordId);
  expect(seedResult.error).toBeNull();

  const archiveFieldResult = await supabase
    .from("field_definitions")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", entity.fields.legacy.id);
  expect(archiveFieldResult.error).toBeNull();

  const result = await updateRecordViaRpc({
    entity,
    recordId,
    values: {
      [entity.fields.name.key]: `${run.label} Updated`,
    },
  });

  expect(result.error).toBeNull();

  const { data, error } = await supabase
    .from("entity_records")
    .select("values")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id)
    .eq("id", recordId)
    .single<{ values: Record<string, unknown> }>();

  expect(error).toBeNull();
  expect(data?.values[entity.fields.name.key]).toBe(`${run.label} Updated`);
  expect(data?.values[entity.fields.legacy.key]).toBe("keep me");
  expect(data?.values.orphan_key).toBeUndefined();
});
