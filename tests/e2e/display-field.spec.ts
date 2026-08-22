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
  type TestField,
  type TestRun,
} from "./helpers/supabase-test-data";
import {
  addRecordSection,
  chooseRecordField,
  expectTableValue,
  fillRecordField,
  gotoEntity,
  rowForText,
  selectReactOption,
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

async function setDisplayField(entity: TestEntity, field?: TestField) {
  const supabase = createSupabaseTestClient();

  const result = await supabase.rpc("set_entity_display_field", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_field_definition_id: field?.id ?? null,
  });

  expect(result.error).toBeNull();
}

async function createClientDeliverableScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Display Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "code", name: "Code", type: "text" },
  ]);
  const deliverable = await createEntity(supabase, run, "Display Deliverable", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const clientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: {
      name: `${run.label} Acme`,
      code: `${run.label} ACM`,
    },
  });

  return { client, deliverable, clientRecordId };
}

test("existing entity with no display field keeps first-text fallback", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { deliverable, clientRecordId } = await createClientDeliverableScenario(run);

  await createEntityRecord({
    entity: deliverable,
    valuesBySlug: { title: `${run.label} Website` },
    relationsBySlug: { client: clientRecordId },
  });

  await gotoEntity(page, deliverable);
  await expect(rowForText(page, `${run.label} Website`)).toContainText(
    `${run.label} Acme`,
  );
});

test("setting display field changes relation labels", async ({ page }) => {
  const run = createScenarioRun();
  const { client, deliverable, clientRecordId } =
    await createClientDeliverableScenario(run);
  await setDisplayField(client, client.fields.code);

  await createEntityRecord({
    entity: deliverable,
    valuesBySlug: { title: `${run.label} Display Switch` },
    relationsBySlug: { client: clientRecordId },
  });

  await gotoEntity(page, deliverable);
  await expect(rowForText(page, `${run.label} Display Switch`)).toContainText(
    `${run.label} ACM`,
  );
});

test("renaming configured display field preserves record labels", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { client, deliverable, clientRecordId } =
    await createClientDeliverableScenario(run);
  await setDisplayField(client, client.fields.code);

  const renameResult = await supabase.rpc("update_field_definition", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: client.id,
    p_field_definition_id: client.fields.code.id,
    p_name: "Customer Code",
    p_slug: `customer-code-${randomUUID().slice(0, 8)}`,
    p_required: false,
  });
  expect(renameResult.error).toBeNull();

  await createEntityRecord({
    entity: deliverable,
    valuesBySlug: { title: `${run.label} Rename Display` },
    relationsBySlug: { client: clientRecordId },
  });

  await gotoEntity(page, deliverable);
  await expect(rowForText(page, `${run.label} Rename Display`)).toContainText(
    `${run.label} ACM`,
  );
});

test("duplicate field names resolve configured display field by id", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Duplicate Name Client", [
    { slug: "name-primary", name: "Name", type: "text", required: true },
    { slug: "name-secondary", name: "Name", type: "text" },
  ]);
  const deliverable = await createEntity(supabase, run, "Duplicate Name Deliverable", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const clientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: {
      "name-primary": `${run.label} Primary`,
      "name-secondary": `${run.label} Secondary`,
    },
  });
  await setDisplayField(client, client.fields["name-secondary"]);
  await createEntityRecord({
    entity: deliverable,
    valuesBySlug: { title: `${run.label} Duplicate` },
    relationsBySlug: { client: clientRecordId },
  });

  await gotoEntity(page, deliverable);
  await expect(rowForText(page, `${run.label} Duplicate`)).toContainText(
    `${run.label} Secondary`,
  );
  await gotoEntity(page, client);
  await expect(page.getByLabel("Display field")).toContainText("Name (field 1)");
  await expect(page.getByLabel("Display field")).toContainText("Name (field 2)");
});

test("configured display field with empty value falls back to shortened record id", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client, deliverable } = await createClientDeliverableScenario(run);
  await setDisplayField(client, client.fields.code);
  const clientRecordId = await createEntityRecord({
    entity: client,
    valuesBySlug: {
      name: `${run.label} Empty Code`,
      code: null,
    },
  });

  await createEntityRecord({
    entity: deliverable,
    valuesBySlug: { title: `${run.label} Empty Display` },
    relationsBySlug: { client: clientRecordId },
  });

  await gotoEntity(page, deliverable);
  await expect(rowForText(page, `${run.label} Empty Display`)).toContainText(
    `${clientRecordId.slice(0, 8)}...`,
  );
});

test("no display field option keeps fallback behavior explicit", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client, deliverable, clientRecordId } =
    await createClientDeliverableScenario(run);
  await setDisplayField(client, client.fields.code);

  await gotoEntity(page, client);
  await selectReactOption(page.getByLabel("Display field"), { value: "" });
  await page.getByRole("button", { name: "Save Entity" }).click();
  await expect(page.getByText("Entity updated.")).toBeVisible();
  await expect(
    page.getByText(
      "No display field selected means record labels fall back to the first active text field.",
    ),
  ).toBeVisible();

  await createEntityRecord({
    entity: deliverable,
    valuesBySlug: { title: `${run.label} Null Display` },
    relationsBySlug: { client: clientRecordId },
  });

  await gotoEntity(page, deliverable);
  await expect(rowForText(page, `${run.label} Null Display`)).toContainText(
    `${run.label} Acme`,
  );
});

test("archiving configured display field is blocked", async ({ page }) => {
  const run = createScenarioRun();
  const { client } = await createClientDeliverableScenario(run);
  await setDisplayField(client, client.fields.code);

  await gotoEntity(page, client);
  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator('input[name="fieldName"][value="Code"]') })
    .locator("..");

  await fieldRow.getByRole("button", { name: "Archive Field" }).click();
  await expect(
    page.getByText(
      `This field is used as the display field for ${client.name}. Choose another display field before archiving it.`,
    ),
  ).toBeVisible();
});

test("safe field deletion blocks configured display field dependency", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { client } = await createClientDeliverableScenario(run);
  await setDisplayField(client, client.fields.code);

  const result = await supabase.rpc("delete_field_definition_if_safe", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: client.id,
    p_field_definition_id: client.fields.code.id,
  });

  expect(result.error).toBeNull();
  expect(result.data?.[0]?.deleted).toBe(false);
  expect(result.data?.[0]?.display_field_reference_count).toBe(1);
});

test("changing display field allows old display field to archive and delete", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Display Lifecycle", [
    { slug: "name", name: "Name", type: "text" },
    { slug: "code", name: "Code", type: "text" },
  ]);
  await setDisplayField(entity, entity.fields.name);
  await setDisplayField(entity, entity.fields.code);

  const archiveResult = await supabase
    .from("field_definitions")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id)
    .eq("id", entity.fields.name.id);
  expect(archiveResult.error).toBeNull();

  const deleteResult = await supabase.rpc("delete_field_definition_if_safe", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_field_definition_id: entity.fields.name.id,
  });

  expect(deleteResult.error).toBeNull();
  expect(deleteResult.data?.[0]?.deleted).toBe(true);
});

test("new entity creation defaults display field to first text field", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const fields = [
    {
      key: `fld_e2e_${run.id}_amount`.replace(/-/g, "_"),
      name: "Amount",
      slug: "amount",
      type: "number",
      required: false,
      position: 1,
      related_entity_type_id: null,
    },
    {
      key: `fld_e2e_${run.id}_name`.replace(/-/g, "_"),
      name: "Name",
      slug: "name",
      type: "text",
      required: false,
      position: 2,
      related_entity_type_id: null,
    },
  ];
  const entityIdResult = await supabase.rpc("create_entity_type_with_fields", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_name: `${run.label} Default Display`,
    p_entity_slug: `e2e-default-display-${run.id}`,
    p_entity_description: "Created by display-field E2E tests.",
    p_fields: fields,
  });
  expect(entityIdResult.error).toBeNull();

  const entityId = String(entityIdResult.data);
  const entityRun: TestRun = {
    ...run,
    label: `${run.label} Default Display`,
  };
  runs.push(entityRun);

  const [{ data: entityRow, error: entityError }, { data: fieldRows, error: fieldError }] =
    await Promise.all([
      supabase
        .from("entity_types")
        .select("display_field_definition_id")
        .eq("workspace_id", DEMO_WORKSPACE_ID)
        .eq("id", entityId)
        .single<{ display_field_definition_id: string | null }>(),
      supabase
        .from("field_definitions")
        .select("id, slug")
        .eq("workspace_id", DEMO_WORKSPACE_ID)
        .eq("entity_type_id", entityId)
        .returns<Array<{ id: string; slug: string }>>(),
    ]);

  expect(entityError).toBeNull();
  expect(fieldError).toBeNull();
  expect(entityRow?.display_field_definition_id).toBe(
    fieldRows?.find((field) => field.slug === "name")?.id,
  );
});

test("workflow relation templates use configured display field", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Workflow Display Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "code", name: "Code", type: "text" },
  ]);
  const ticket = await createEntity(supabase, run, "Workflow Display Ticket", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const activity = await createEntity(supabase, run, "Workflow Display Activity", [
    { slug: "summary", name: "Summary", type: "text", required: true },
  ]);
  await createEntityRecord({
    entity: client,
    valuesBySlug: {
      name: `${run.label} Client Name`,
      code: `${run.label} Client Code`,
    },
  });
  await setDisplayField(client, client.fields.code);

  const workflowResult = await supabase.from("workflows").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Display Template Workflow`,
    trigger_type: "record_created",
    trigger_entity_type_id: ticket.id,
    action_config: {},
    actions: [
      {
        actionType: "create_record",
        actionTargetEntityTypeId: activity.id,
        fieldMappings: [
          {
            targetFieldDefinitionId: activity.fields.summary.id,
            source: {
              type: "template",
              template: `{{field:${ticket.fields.client.id}}}`,
            },
          },
        ],
      },
    ],
  });
  expect(workflowResult.error).toBeNull();

  await gotoEntity(page, ticket);
  const form = addRecordSection(page, ticket);
  await fillRecordField(form, ticket.fields.title, `${run.label} Ticket`);
  await chooseRecordField(form, ticket.fields.client, `${run.label} Client Code`);
  await submitAddRecord(page, ticket);
  await expect(page.getByText(/1 workflow succeeded/)).toBeVisible();

  await gotoEntity(page, activity);
  await expectTableValue(page, `${run.label} Client Code`);
});
