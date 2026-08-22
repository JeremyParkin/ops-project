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
  await expect(page.locator("p").filter({ hasText: client.name })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Related Records" })).toBeVisible();
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
  ).toHaveCount(0);

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

  await page.goto(`/entities/${client.id}/records/${acmeId}`);
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Record archived.")).toBeVisible();
  await expect(page.locator("span").filter({ hasText: /^Archived$/ })).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Record restored.")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/Cannot delete this/)).toBeVisible();
});
