import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestEntity,
  type TestRun,
} from "./helpers/supabase-test-data";
import { gotoEntity } from "./helpers/ui";

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

function fieldRow(page: Page, fieldName: string) {
  return page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="${fieldName}"]`) })
    .locator("..");
}

function fieldArchiveButton(page: Page, fieldName: string, label: string | RegExp) {
  return fieldRow(page, fieldName)
    .locator('button[form^="field-archive-"]')
    .getByText(label);
}

async function addWorkStatusFixture(entity: TestEntity, run: TestRun) {
  const supabase = createSupabaseTestClient();
  const assignmentFieldId = randomUUID();
  const statusFieldId = randomUUID();
  const doneOptionId = randomUUID();
  const suffix = run.id.replace(/-/g, "_");

  const { error: fieldError } = await supabase.from("field_definitions").insert([
    {
      id: assignmentFieldId,
      workspace_id: DEMO_WORKSPACE_ID,
      entity_type_id: entity.id,
      key: `fld_e2e_${suffix}_assignee`,
      name: "Assignee",
      slug: "assignee",
      type: "workspace_member",
      required: false,
      position: 2,
    },
    {
      id: statusFieldId,
      workspace_id: DEMO_WORKSPACE_ID,
      entity_type_id: entity.id,
      key: `fld_e2e_${suffix}_status`,
      name: "Status",
      slug: "status",
      type: "choice",
      required: false,
      position: 3,
    },
  ]);
  expect(fieldError).toBeNull();

  const { error: optionError } = await supabase.from("field_choice_options").insert({
    id: doneOptionId,
    workspace_id: DEMO_WORKSPACE_ID,
    field_definition_id: statusFieldId,
    label: "Done",
    color: "emerald",
    position: 1,
  });
  expect(optionError).toBeNull();

  const { error: settingsError } = await supabase
    .from("entity_types")
    .update({
      work_enabled: true,
      work_assignment_field_id: assignmentFieldId,
      work_status_field_id: statusFieldId,
    })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", entity.id);
  expect(settingsError).toBeNull();

  const { error: completionError } = await supabase.from("entity_type_work_completion_options").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    entity_type_id: entity.id,
    status_field_id: statusFieldId,
    option_id: doneOptionId,
  });
  expect(completionError).toBeNull();

  return { statusFieldId };
}

test("archiving a Work Settings status field requires confirmation, then clears status mapping and archives", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Archive Work Settings", [
    { slug: "title", name: "Title", type: "text" },
  ]);
  const { statusFieldId } = await addWorkStatusFixture(entity, run);

  await gotoEntity(page, entity, true);

  await fieldArchiveButton(page, "Status", "Archive").click();
  await expect(page.getByText(/This field is used by Work Settings/i)).toBeVisible();

  await fieldArchiveButton(page, "Status", "Remove from Work Settings and archive").click();
  await expect(page.locator('input[name="fieldName"][value="Status"]')).toHaveCount(0);

  const { data: entityType, error: entityError } = await supabase
    .from("entity_types")
    .select("work_enabled, work_status_field_id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", entity.id)
    .single();
  expect(entityError).toBeNull();
  expect(entityType).toEqual({ work_enabled: true, work_status_field_id: null });

  const { data: completionOptions, error: completionError } = await supabase
    .from("entity_type_work_completion_options")
    .select("option_id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id);
  expect(completionError).toBeNull();
  expect(completionOptions).toEqual([]);

  const { data: field, error: fieldError } = await supabase
    .from("field_definitions")
    .select("archived_at")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", statusFieldId)
    .single();
  expect(fieldError).toBeNull();
  expect(field?.archived_at).not.toBeNull();
});
