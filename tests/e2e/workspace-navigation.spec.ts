import { expect, test, type Page } from "@playwright/test";
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
import { rowForText } from "./helpers/ui";

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

async function createView({
  entity,
  name,
  position,
  isDefault = false,
  filters = [],
}: {
  entity: TestEntity;
  name: string;
  position: number;
  isDefault?: boolean;
  filters?: unknown[];
}) {
  const supabase = createSupabaseTestClient();
  const result = await supabase
    .from("entity_views")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      entity_type_id: entity.id,
      name,
      position,
      is_default: isDefault,
      filters,
      sorts: [],
      column_field_definition_ids: Object.values(entity.fields).map((field) => field.id),
    })
    .select("id")
    .single<{ id: string }>();

  expect(result.error).toBeNull();
  return String(result.data?.id);
}

function entityCard(page: Page, entity: TestEntity) {
  return page.getByRole("heading", { name: entity.name, exact: true }).locator("..").locator("..");
}

test("home provides shared navigation and keeps the entity card on its default view", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Workspace Work", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
  ]);
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Ready`, status: "Ready" },
  });
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Draft`, status: "Draft" },
  });
  await createView({
    entity,
    name: `${run.label} Ready Only`,
    position: 1,
    isDefault: true,
    filters: [
      {
        fieldDefinitionId: entity.fields.status.id,
        operator: "equals",
        value: "Ready",
      },
    ],
  });
  await createView({ entity, name: `${run.label} First`, position: 2 });
  await createView({ entity, name: `${run.label} Second`, position: 3 });
  await createView({ entity, name: `${run.label} Hidden`, position: 4 });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Workflows", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create Entity", exact: true })).toBeVisible();

  const card = entityCard(page, entity);
  await expect(card.getByRole("link", { name: "All Records" })).toBeVisible();
  await expect(card.getByRole("link", { name: `${run.label} Ready Only · Default` })).toBeVisible();
  await expect(card.getByRole("link", { name: `${run.label} First` })).toBeVisible();
  await expect(card.getByRole("link", { name: `${run.label} Second` })).toBeVisible();
  await expect(card.getByRole("link", { name: `${run.label} Hidden` })).toHaveCount(0);

  await card.locator("a").first().click();
  await expect(rowForText(page, `${run.label} Ready`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Draft`)).toHaveCount(0);

  await page.goto("/");
  await entityCard(page, entity).getByRole("link", { name: "All Records" }).click();
  await expect(page).toHaveURL(new RegExp(`/entities/${entity.id}\\?view=all$`));
  await expect(rowForText(page, `${run.label} Draft`)).toBeVisible();

  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  await page.getByRole("link", { name: "Create Entity", exact: true }).click();
  await expect(page).toHaveURL(/\/entities\/new$/);
});

test("archived entities stay out of normal home navigation but remain available through management mode", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Archived Workspace Entity", [
    { slug: "name", name: "Name", type: "text" },
  ]);
  const archiveResult = await supabase
    .from("entity_types")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", entity.id);
  expect(archiveResult.error).toBeNull();

  await page.goto("/");
  await expect(page.getByRole("link", { name: entity.name, exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Show archived entities" }).click();
  await expect(page).toHaveURL(/showArchivedEntities=true/);
  await expect(page.getByRole("heading", { name: entity.name, exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Entity navigation" })
      .getByRole("link")
      .filter({ hasText: entity.name }),
  ).toHaveCount(1);
  await expect(page.getByText("Archived", { exact: true }).last()).toBeVisible();
});
