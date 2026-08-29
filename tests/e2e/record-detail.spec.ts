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

async function createSavedView({
  entity,
  name,
  columnFieldDefinitionIds,
}: {
  entity: TestEntity;
  name: string;
  columnFieldDefinitionIds: string[];
}) {
  const supabase = createSupabaseTestClient();
  const result = await supabase
    .from("entity_views")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      entity_type_id: entity.id,
      name,
      position: 1,
      column_field_definition_ids: columnFieldDefinitionIds,
    })
    .select("id")
    .single<{ id: string }>();

  expect(result.error).toBeNull();

  return String(result.data?.id);
}

async function createDetailScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Detail Client", [
    { slug: "name", name: "Company Name", type: "text", required: true },
    { slug: "code", name: "Client Code", type: "text" },
    { slug: "region", name: "Region", type: "text" },
    { slug: "active", name: "Active", type: "boolean" },
  ]);
  await setDisplayField(client, client.fields.code.id);
  const deliverable = await createEntity(supabase, run, "Detail Deliverable", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "budget", name: "Budget", type: "number" },
    { slug: "due", name: "Due", type: "date" },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const project = await createEntity(supabase, run, "Detail Project", [
    { slug: "name", name: "Name", type: "text", required: true },
    {
      slug: "primary-client",
      name: "Primary Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
    {
      slug: "billing-client",
      name: "Billing Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const acmeId = await createEntityRecord({
    entity: client,
    valuesBySlug: {
      name: `${run.label} Acme Corp`,
      code: `${run.label} ACM`,
      region: "Canada",
      active: true,
    },
  });
  const betaId = await createEntityRecord({
    entity: client,
    valuesBySlug: {
      name: `${run.label} Beta Corp`,
      code: `${run.label} BET`,
      region: "USA",
      active: false,
    },
  });
  const reportId = await createEntityRecord({
    entity: deliverable,
    valuesBySlug: {
      title: `${run.label} Q3 Media Report`,
      budget: 12500,
      due: "2026-09-15",
    },
    relationsBySlug: { client: acmeId },
  });
  const reviewId = await createEntityRecord({
    entity: deliverable,
    valuesBySlug: {
      title: `${run.label} Annual Review`,
      budget: 7500,
      due: "2026-10-01",
    },
    relationsBySlug: { client: acmeId },
  });
  const projectId = await createEntityRecord({
    entity: project,
    valuesBySlug: { name: `${run.label} Website Relaunch` },
    relationsBySlug: {
      "primary-client": acmeId,
      "billing-client": betaId,
    },
  });

  return {
    client,
    deliverable,
    project,
    acmeId,
    betaId,
    reportId,
    reviewId,
    projectId,
  };
}

test("clicking a record opens detail with display heading and primitive values", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client } = await createDetailScenario(run);

  await gotoEntity(page, client);
  await rowForText(page, `${run.label} ACM`)
    .getByRole("link", { name: `${run.label} ACM` })
    .click();

  await expect(
    page.getByRole("heading", { name: `${run.label} ACM`, exact: true }),
  ).toBeVisible();
  // Scoped past the contextual object rail ("aside"), which also renders
  // the entity name as its own label -- this checks the record page's own
  // PageHeader eyebrow specifically.
  await expect(page.locator("main > div p").filter({ hasText: client.name })).toBeVisible();
  await expect(page.getByText("Company Name")).toBeVisible();
  await expect(page.getByText(`${run.label} Acme Corp`)).toBeVisible();
  await expect(page.getByText("Region")).toBeVisible();
  await expect(page.getByText("Canada")).toBeVisible();
  await expect(page.getByText("Active")).toBeVisible();
  await expect(page.getByText("Yes")).toBeVisible();
});

test("hidden identity field uses explicit Open action instead of arbitrary cell link", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client } = await createDetailScenario(run);
  const viewId = await createSavedView({
    entity: client,
    name: `${run.label} Region Only`,
    columnFieldDefinitionIds: [client.fields.region.id],
  });

  await page.goto(`/entities/${client.id}?view=${viewId}`);
  const row = rowForText(page, "Canada");
  await expect(row.getByRole("link", { name: "Canada" })).toHaveCount(0);
  await row.getByRole("link", { name: "Open" }).click();
  await expect(
    page.getByRole("heading", { name: `${run.label} ACM`, exact: true }),
  ).toBeVisible();
});

test("outgoing relation displays a linked label and archived target marker", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { client, deliverable, acmeId, reportId } = await createDetailScenario(run);
  const archiveResult = await supabase
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", client.id)
    .eq("id", acmeId);
  expect(archiveResult.error).toBeNull();

  await page.goto(`/entities/${deliverable.id}/records/${reportId}`);
  const relationLink = page.getByRole("link", {
    name: `${run.label} ACM (Archived)`,
  });
  await expect(relationLink).toBeVisible();
  await relationLink.click();
  await expect(
    page.getByRole("heading", { name: `${run.label} ACM`, exact: true }),
  ).toBeVisible();
  await expect(page.locator("span").filter({ hasText: /^Archived$/ })).toBeVisible();
});

test("reverse relationships are grouped by source entity and relation field", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client, acmeId } = await createDetailScenario(run);

  await page.goto(`/entities/${client.id}/records/${acmeId}`);
  await expect(page.getByRole("heading", { name: "Related", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: `${run.label} Detail Deliverables via Client`,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: `${run.label} Q3 Media Report` })).toBeVisible();
  await expect(page.getByRole("link", { name: `${run.label} Annual Review` })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: `${run.label} Detail Projects via Primary Client`,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: `${run.label} Detail Projects via Billing Client`,
    }),
  ).toBeVisible();
  await expect(page.getByText("No related records yet.")).toBeVisible();

  await page.getByRole("link", { name: `${run.label} Q3 Media Report` }).click();
  await expect(
    page.getByRole("heading", {
      name: `${run.label} Q3 Media Report`,
      exact: true,
    }),
  ).toBeVisible();
});

test("archived source records, relation fields, and source entities are excluded", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { client, deliverable, project, acmeId, reviewId } =
    await createDetailScenario(run);

  const archiveRecordResult = await supabase
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", deliverable.id)
    .eq("id", reviewId);
  expect(archiveRecordResult.error).toBeNull();
  const archiveFieldResult = await supabase
    .from("field_definitions")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", project.id)
    .eq("id", project.fields["primary-client"].id);
  expect(archiveFieldResult.error).toBeNull();
  const archiveEntityResult = await supabase
    .from("entity_types")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", project.id);
  expect(archiveEntityResult.error).toBeNull();

  await page.goto(`/entities/${client.id}/records/${acmeId}`);
  await expect(page.getByRole("link", { name: `${run.label} Q3 Media Report` })).toBeVisible();
  await expect(page.getByRole("link", { name: `${run.label} Annual Review` })).toHaveCount(0);
  await expect(page.getByText(`${run.label} Detail Projects via Primary Client`)).toHaveCount(0);
});

test("edit from detail returns to detail with updated label", async ({ page }) => {
  const run = createScenarioRun();
  const { client, acmeId } = await createDetailScenario(run);

  await page.goto(`/entities/${client.id}/records/${acmeId}`);
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(/returnTo=detail/);
  await page.locator(`[name="${client.fields.code.key}"]`).fill(`${run.label} ACME-EDIT`);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/entities/${client.id}/records/${acmeId}$`));
  await expect(
    page.getByRole("heading", { name: `${run.label} ACME-EDIT`, exact: true }),
  ).toBeVisible();
});

test("archive, restore, and safe delete actions work from detail", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client, acmeId } = await createDetailScenario(run);
  const recordActions = page.locator("details").filter({
    has: page.getByText("More actions", { exact: true }),
  });

  await page.goto(`/entities/${client.id}/records/${acmeId}`);
  await recordActions.locator("summary").click();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Record archived.")).toBeVisible();
  await expect(page.locator("span").filter({ hasText: /^Archived$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Company Name" })).toHaveCount(0);
  if (!(await page.getByRole("button", { name: "Restore" }).isVisible())) {
    await recordActions.locator("summary").click();
  }
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Record restored.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Company Name" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  if (!(await page.getByRole("button", { name: "Delete" }).isVisible())) {
    await recordActions.locator("summary").click();
  }
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/Cannot delete this/)).toBeVisible();
});

async function createOverviewScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Overview Widget", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "alpha", name: "Alpha", type: "text" },
    { slug: "bravo", name: "Bravo", type: "text" },
    { slug: "charlie", name: "Charlie", type: "text" },
    { slug: "delta", name: "Delta", type: "text" },
    { slug: "echo", name: "Echo", type: "text" },
    { slug: "foxtrot", name: "Foxtrot", type: "text" },
    { slug: "golf", name: "Golf", type: "text" },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: {
      name: `${run.label} Widget One`,
      alpha: "Alpha value",
      charlie: "Charlie value",
      echo: "Echo value",
    },
  });

  return { entity, recordId };
}

test("Overview prefers populated fields up to the cap, with All fields revealing the canonical rest", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { entity, recordId } = await createOverviewScenario(run);

  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  // "All fields" duplicates the capped summary's fields inside its own
  // (initially collapsed) list, so scope to the always-visible summary <dl>
  // -- the first one on the page -- to avoid matching the hidden copy.
  const overviewList = page.locator("dl").first();

  // 6 populated-first fields (3 populated + 3 empty backfilled by position)
  // are visible without expanding; the last empty field (Golf, position 8)
  // is beyond the cap and only appears once "All fields" is opened.
  for (const label of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]) {
    await expect(overviewList.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("Golf", { exact: true })).not.toBeVisible();

  // Inline editing reuses the same EditableTableCell/updateRecordField
  // wiring as the records table.
  await overviewList.getByRole("button", { name: "Edit Alpha" }).click();
  const input = page.locator('input[name="value"]');
  await input.fill("Alpha updated");
  await input.press("Enter");
  await expect(overviewList.getByRole("button", { name: "Edit Alpha" })).toBeVisible();
  await expect(overviewList.getByText("Alpha updated")).toBeVisible();

  await page.getByText("All fields").click();
  await expect(page.getByText("Golf", { exact: true })).toBeVisible();

  await page.reload();
  await expect(overviewList.getByText("Alpha updated")).toBeVisible();
});

test("a sparse record still renders Overview structure instead of looking empty", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Sparse Widget", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "note", name: "Note", type: "text" },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Sparse One` },
  });

  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Note", { exact: true })).toBeVisible();
  await expect(page.getByText("—", { exact: true })).toBeVisible();
});

async function createUnifiedRelatedScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const manager = await createEntity(supabase, run, "Related Manager", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const client = await createEntity(supabase, run, "Related Widget Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    {
      slug: "manager",
      name: "Manager",
      type: "relation",
      relatedEntityTypeId: manager.id,
    },
  ]);
  const deliverable = await createEntity(supabase, run, "Related Widget Deliverable", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      relatedEntityTypeId: client.id,
    },
  ]);
  const managerId = await createEntityRecord({
    entity: manager,
    valuesBySlug: { name: `${run.label} Jordan Lee` },
  });
  const clientId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Acme` },
    relationsBySlug: { manager: managerId },
  });
  const deliverableIds: string[] = [];
  for (let index = 1; index <= 7; index += 1) {
    deliverableIds.push(
      await createEntityRecord({
        entity: deliverable,
        valuesBySlug: { title: `${run.label} Deliverable ${index}` },
        relationsBySlug: { client: clientId },
      }),
    );
  }

  return { manager, client, deliverable, managerId, clientId, deliverableIds };
}

test("Overview holds the forward relation field; Related holds only the reverse group, capping the preview with an expand", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client, clientId } = await createUnifiedRelatedScenario(run);

  await page.goto(`/entities/${client.id}/records/${clientId}`);

  // The forward "Manager" relation lives in Overview, alongside primitive
  // fields, not in Related -- it renders read-only (chip/link), never as an
  // inline-editable cell.
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Manager", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `${run.label} Jordan Lee` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Manager" })).toHaveCount(0);

  // Related holds only the reverse-derived group -- no "Manager" heading
  // there.
  await expect(page.getByRole("heading", { name: "Related", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manager", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: `${run.label} Related Widget Deliverables via Client` }),
  ).toBeVisible();

  // 7 related deliverables, capped preview of 5, with the remaining 2
  // behind an expand.
  for (let index = 1; index <= 5; index += 1) {
    await expect(
      page.getByRole("link", { name: `${run.label} Deliverable ${index}` }),
    ).toBeVisible();
  }
  await expect(page.getByRole("link", { name: `${run.label} Deliverable 6` })).toHaveCount(0);
  await expect(page.getByRole("link", { name: `${run.label} Deliverable 7` })).toHaveCount(0);

  await page.getByText("2 more").click();
  await expect(page.getByRole("link", { name: `${run.label} Deliverable 6` })).toBeVisible();
  await expect(page.getByRole("link", { name: `${run.label} Deliverable 7` })).toBeVisible();

  await page.getByRole("link", { name: `${run.label} Jordan Lee` }).click();
  await expect(
    page.getByRole("heading", { name: `${run.label} Jordan Lee`, exact: true }),
  ).toBeVisible();
});
