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
import { gotoEntity, rowForText } from "./helpers/ui";
import type { Page } from "@playwright/test";

// The page also renders a persistent, always-present "Show archived
// records"/"Hide archived records" toggle link unrelated to the empty
// state (pre-existing, out of scope for this phase) -- it shares exact
// link text with the new empty-state action, so assertions about the
// empty state's own action must be scoped to its section, not the page.
function emptyStateSection(page: Page, titleText: string) {
  return page.locator("section", { has: page.getByRole("heading", { name: titleText }) });
}

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

// Minimal, filter-only saved-view fixture -- direct DB insert rather than
// driving the Manage Views form, mirroring views.spec.ts's own createView
// helper (not exported from there, so reproduced narrowly here).
async function createFilteredView({
  entity,
  name,
  filters,
}: {
  entity: TestEntity;
  name: string;
  filters: Array<{ fieldDefinitionId: string; operator: string; value?: unknown }>;
}) {
  const admin = createSupabaseTestClient();
  const { data: existingViews, error: viewError } = await admin
    .from("entity_views")
    .select("position")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id);
  if (viewError) throw new Error(viewError.message);

  const position =
    (existingViews ?? []).reduce((max, view) => Math.max(max, Number(view.position)), 0) + 1;
  const { data, error } = await admin
    .from("entity_views")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      entity_type_id: entity.id,
      name,
      position,
      is_default: false,
      filters,
      sorts: [],
      column_field_definition_ids: Object.values(entity.fields)
        .sort((left, right) => left.position - right.position)
        .map((field) => field.id),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(error?.message ?? "Unable to create saved view.");

  return data.id;
}

async function archiveRecordDirect(recordId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", recordId);
  if (error) throw new Error(error.message);
}

test("genuinely empty object shows the no-records-yet state with no resolving action", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "GenuinelyEmpty", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);

  await gotoEntity(page, entity);
  const section = emptyStateSection(page, `No ${entity.name.toLowerCase()} records yet.`);
  await expect(section).toBeVisible();
  await expect(section.getByRole("link", { name: "Show archived records" })).toHaveCount(0);
  await expect(section.getByRole("link", { name: "Clear filters" })).toHaveCount(0);
});

test("all records archived: shows the archived-hidden state, and Show archived records preserves other view state", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "AllArchived", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} OnlyRecord` },
  });
  await archiveRecordDirect(recordId);

  // An unrelated quick-bar sort is already active in the URL -- proves the
  // action link preserves it rather than resetting the user's context.
  const params = new URLSearchParams();
  params.set("sortField:0", entity.fields.title.id);
  params.set("sortDirection:0", "asc");
  params.set("columnFieldDefinitionId", entity.fields.title.id);
  await page.goto(`/entities/${entity.id}?${params.toString()}`);

  const section = emptyStateSection(page, "All records are archived.");
  await expect(section).toBeVisible();
  const showArchivedLink = section.getByRole("link", { name: "Show archived records" });
  await expect(showArchivedLink).toBeVisible();
  await expect(section.getByRole("link", { name: "Clear filters" })).toHaveCount(0);

  const href = await showArchivedLink.getAttribute("href");
  const url = new URL(href ?? "", "http://localhost");
  expect(url.searchParams.get("showArchived")).toBe("true");
  expect(url.searchParams.get("sortField:0")).toBe(entity.fields.title.id);

  await showArchivedLink.click();
  await expect(rowForText(page, `${run.label} OnlyRecord`)).toBeVisible();
});

test("unsaved quick-bar filter zero-result state, and Clear filters preserves the underlying saved view", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "QuickFilterZero", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);
  await createEntityRecord({ entity, valuesBySlug: { title: `${run.label} Alpha` } });
  await createEntityRecord({ entity, valuesBySlug: { title: `${run.label} Beta` } });
  const viewId = await createFilteredView({ entity, name: `${run.label} AllOfThem`, filters: [] });

  await page.goto(`/entities/${entity.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} Alpha`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Beta`)).toBeVisible();

  await page.getByRole("button", { name: "+ Add filter" }).click();
  await page.getByLabel("Quick filter field").selectOption({ label: "Title (text)" });
  await page.getByLabel("Quick filter operator").selectOption({ value: "contains" });
  await page.getByLabel("Quick filter value").fill("Nonexistent Zzz");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const section = emptyStateSection(page, "No records match your current filters.");
  await expect(section).toBeVisible();
  const clearLink = section.getByRole("link", { name: "Clear filters" });
  await expect(clearLink).toBeVisible();
  await expect(section.getByRole("link", { name: "Show archived records" })).toHaveCount(0);

  // The pending filter is gone, but the underlying saved view selection --
  // unrelated context -- survives the clear action.
  const href = await clearLink.getAttribute("href");
  const url = new URL(href ?? "", "http://localhost");
  expect(url.searchParams.get("view")).toBe(viewId);
  expect(url.searchParams.has("filterField:0")).toBe(false);

  await clearLink.click();
  await expect(rowForText(page, `${run.label} Alpha`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Beta`)).toBeVisible();
});

test("a saved view's own filters zero a nonempty active set", async ({ page }) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "SavedViewZero", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);
  await createEntityRecord({ entity, valuesBySlug: { title: `${run.label} Present` } });
  const viewId = await createFilteredView({
    entity,
    name: `${run.label} NoMatches`,
    filters: [
      {
        fieldDefinitionId: entity.fields.title.id,
        operator: "equals",
        value: "Never Matches Anything At All",
      },
    ],
  });

  await page.goto(`/entities/${entity.id}?view=${viewId}`);
  const section = emptyStateSection(page, `No records match ${run.label} NoMatches.`);
  await expect(section).toBeVisible();
  await expect(section.getByRole("link", { name: "Clear filters" })).toHaveCount(0);
  await expect(section.getByRole("link", { name: "Show archived records" })).toHaveCount(0);
});

test("aria-sort marks only the primary sort column; a secondary sort field gets accessible position text", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "MultiSort", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "priority", name: "Priority", type: "number" },
  ]);
  await createEntityRecord({ entity, valuesBySlug: { title: `${run.label} A`, priority: 1 } });
  await createEntityRecord({ entity, valuesBySlug: { title: `${run.label} B`, priority: 2 } });

  await gotoEntity(page, entity);

  await page.getByRole("button", { name: "+ Add sort" }).click();
  await page.getByLabel("Quick sort field").selectOption({ label: "Title (text)" });
  await page.getByLabel("Quick sort direction").selectOption("asc");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // Each "Add sort" is a real navigation (the quick bar encodes state in the
  // URL) -- wait for the first to land before starting the second, or the
  // second click can race the in-flight navigation.
  await page.waitForURL(/sortField/);

  await page.getByRole("button", { name: "+ Add sort" }).click();
  await page.getByLabel("Quick sort field").selectOption({ label: "Priority (number)" });
  await page.getByLabel("Quick sort direction").selectOption("desc");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForURL(/sortField%3A1/);

  const titleHeader = page.getByRole("columnheader", { name: /Title/ });
  const priorityHeader = page.getByRole("columnheader", { name: /Priority/ });
  await expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(priorityHeader).not.toHaveAttribute("aria-sort");
  await expect(priorityHeader.getByText(/sort 2 of 2/)).toHaveCount(1);
  await expect(titleHeader.getByText(/sort \d of \d/)).toHaveCount(0);
});

test("the table's horizontal-scroll region is keyboard-focusable and labeled", async ({ page }) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "ScrollRegion", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);
  await createEntityRecord({ entity, valuesBySlug: { title: `${run.label} Row` } });

  await gotoEntity(page, entity);
  const region = page.getByRole("region", { name: new RegExp(`${entity.name} records table`) });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute("tabindex", "0");
  await region.focus();
  await expect(region).toBeFocused();
});
