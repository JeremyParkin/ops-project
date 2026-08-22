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

async function setDisplayField(entity: TestEntity, fieldId: string) {
  const supabase = createSupabaseTestClient();
  const result = await supabase.rpc("set_entity_display_field", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: entity.id,
    p_field_definition_id: fieldId,
  });

  expect(result.error).toBeNull();
}

test("search groups active records by entity and links to their details", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Search Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "notes", name: "Notes", type: "text" },
  ]);
  const deliverable = await createEntity(supabase, run, "Search Deliverable", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "notes", name: "Notes", type: "text" },
  ]);
  await setDisplayField(client, client.fields.name.id);
  await setDisplayField(deliverable, deliverable.fields.title.id);
  await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Acme`, notes: "Regular account" },
  });
  const deliverableId = await createEntityRecord({
    entity: deliverable,
    valuesBySlug: {
      title: `${run.label} Quarterly Report`,
      notes: "Discuss ACME renewal",
    },
  });

  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search records" }).fill("  acme ");
  await page.getByRole("button", { name: "Search", exact: true }).first().click();

  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.getByRole("heading", { name: client.name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: deliverable.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `${run.label} Acme`, exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: `${run.label} Quarterly Report`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Matched in Notes", { exact: true })).toBeVisible();

  await page
    .getByRole("link", { name: `${run.label} Quarterly Report`, exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/entities/${deliverable.id}/records/${deliverableId}$`),
  );
});

test("search excludes archived records and archived entities", async ({ page }) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const activeEntity = await createEntity(supabase, run, "Search Active", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const archivedEntity = await createEntity(supabase, run, "Search Archived", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const activeRecordId = await createEntityRecord({
    entity: activeEntity,
    valuesBySlug: { name: `${run.label} Visible needle` },
  });
  const archivedRecordId = await createEntityRecord({
    entity: activeEntity,
    valuesBySlug: { name: `${run.label} Archived record needle` },
  });
  await createEntityRecord({
    entity: archivedEntity,
    valuesBySlug: { name: `${run.label} Archived entity needle` },
  });
  const archiveRecordResult = await supabase
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", archivedRecordId);
  expect(archiveRecordResult.error).toBeNull();
  const archiveEntityResult = await supabase
    .from("entity_types")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", archivedEntity.id);
  expect(archiveEntityResult.error).toBeNull();

  await page.goto(`/search?q=${encodeURIComponent("needle")}`);

  await expect(
    page.getByRole("link", { name: `${run.label} Visible needle`, exact: true }),
  ).toHaveAttribute(
    "href",
    `/entities/${activeEntity.id}/records/${activeRecordId}`,
  );
  await expect(
    page.getByRole("link", { name: `${run.label} Archived record needle`, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: `${run.label} Archived entity needle`, exact: true }),
  ).toHaveCount(0);
});

test("search caps each entity at twenty records after ranking display-field matches", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Search Cap", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "notes", name: "Notes", type: "text" },
  ]);
  await setDisplayField(entity, entity.fields.name.id);

  for (let index = 1; index <= 21; index += 1) {
    await createEntityRecord({
      entity,
      valuesBySlug: {
        name: `${run.label} Needle ${String(index).padStart(2, "0")}`,
      },
    });
  }
  await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Zeta`, notes: "Needle in notes" },
  });

  await page.goto(`/search?q=${encodeURIComponent("needle")}`);

  await expect(
    page.getByRole("link", { name: new RegExp(`${run.label} Needle`) }),
  ).toHaveCount(20);
  await expect(page.getByRole("link", { name: `${run.label} Zeta`, exact: true })).toHaveCount(
    0,
  );
});
