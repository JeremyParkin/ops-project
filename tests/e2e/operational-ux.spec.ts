import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestRun,
} from "./helpers/supabase-test-data";
import {
  addRecordSection,
  fillRecordField,
  gotoEntity,
  rowForText,
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

test("keeps the entity table operational-first and opens record creation intentionally", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Operational Work", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
  ]);

  await gotoEntity(page, entity);

  await expect(page.getByText("0 records in All Records")).toBeVisible();
  await expect(page.getByRole("heading", { name: `No ${entity.name.toLowerCase()} records yet.` })).toBeVisible();
  await expect(page.locator("details#add-record")).not.toHaveAttribute("open", "");
  await expect(page.getByRole("heading", { name: "Create a saved view" })).toHaveCount(0);

  await page.getByRole("link", { name: `Add ${entity.name}` }).first().click();
  const createForm = addRecordSection(page, entity);
  await expect(createForm).toHaveAttribute("open", "");
  await expect(createForm.getByText("Fields marked * are required.")).toBeVisible();
  await fillRecordField(createForm, entity.fields.title, `${run.label} First record`);
  await submitAddRecord(page, entity);

  await expect(page.getByText(`${entity.name} created.`)).toBeVisible();
  await expect(rowForText(page, `${run.label} First record`)).toBeVisible();
});

test("keeps saved-view configuration and record lifecycle controls secondary", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Operational Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Acme` },
  });
  const viewName = `${run.label} Current`;
  const viewResult = await supabase.from("entity_views").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    entity_type_id: entity.id,
    name: viewName,
    position: 1,
    filters: [],
    sorts: [],
    column_field_definition_ids: [entity.fields.name.id],
  });
  expect(viewResult.error).toBeNull();

  await page.goto(`/entities/${entity.id}?view=all`);
  await expect(page.getByRole("link", { name: "All Records" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: viewName })).toBeVisible();
  const manageViews = page.getByText("Manage views", { exact: true });
  await expect(manageViews).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create a saved view" })).toHaveCount(0);
  await manageViews.click();
  await expect(page.getByRole("heading", { name: "Create a saved view" })).toBeVisible();

  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await page.getByText("Record actions", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
});
