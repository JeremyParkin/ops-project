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
import { addRecordSection, selectReactOption } from "./helpers/ui";

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

async function createRelatedCreateScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "Related Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const deliverable = await createEntity(supabase, run, "Related Deliverable", [
    { slug: "title", name: "Title", type: "text", required: true },
    {
      slug: "client",
      name: "Client",
      type: "relation",
      required: true,
      relatedEntityTypeId: client.id,
    },
  ]);
  const project = await createEntity(supabase, run, "Related Project", [
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
    valuesBySlug: { name: `${run.label} Acme` },
  });
  const betaId = await createEntityRecord({
    entity: client,
    valuesBySlug: { name: `${run.label} Beta` },
  });

  return { client, deliverable, project, acmeId, betaId };
}

test("an empty reverse group prepopulates the normal create form and returns to its origin", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { client, deliverable, acmeId } = await createRelatedCreateScenario(run);
  const originPath = `/entities/${client.id}/records/${acmeId}`;

  await page.goto(originPath);
  await expect(
    page.getByRole("heading", {
      name: `${run.label} Related Deliverables via Client`,
    }),
  ).toBeVisible();
  const deliverableGroup = page
    .getByRole("heading", {
      name: `${run.label} Related Deliverables via Client`,
    })
    .locator("..")
    .locator("..");
  await expect(deliverableGroup.getByText("No related records yet.")).toBeVisible();
  await page.getByRole("link", { name: `Add ${deliverable.name}` }).click();

  const createSection = addRecordSection(page, deliverable);
  await expect(createSection).toBeVisible();
  await expect(createSection.locator(`[name="${deliverable.fields.client.key}"]`)).toHaveValue(
    acmeId,
  );
  await expect(createSection.getByRole("link", { name: "Cancel" })).toHaveAttribute(
    "href",
    originPath,
  );
  await createSection.locator(`[name="${deliverable.fields.title.key}"]`).fill(`${run.label} Q3 Report`);
  await createSection.getByRole("button", { name: `Add ${deliverable.name}` }).click();

  await expect(page).toHaveURL(new RegExp(`${originPath}$`));
  await expect(page.getByRole("link", { name: `${run.label} Q3 Report` })).toBeVisible();
});

test("each reverse relation field creates its own editable prefill", async ({ page }) => {
  const run = createScenarioRun();
  const { client, project, acmeId, betaId } = await createRelatedCreateScenario(run);

  await page.goto(`/entities/${client.id}/records/${acmeId}`);
  const addProjectLinks = page.getByRole("link", { name: `Add ${project.name}` });
  await expect(addProjectLinks).toHaveCount(2);
  await addProjectLinks.nth(0).click();

  let createSection = addRecordSection(page, project);
  await expect(createSection.locator(`[name="${project.fields["primary-client"].key}"]`)).toHaveValue(
    acmeId,
  );
  await expect(createSection.locator(`[name="${project.fields["billing-client"].key}"]`)).toHaveValue("");
  await createSection.getByRole("link", { name: "Cancel" }).click();

  await page.getByRole("link", { name: `Add ${project.name}` }).nth(1).click();
  createSection = addRecordSection(page, project);
  await expect(createSection.locator(`[name="${project.fields["primary-client"].key}"]`)).toHaveValue("");
  await expect(createSection.locator(`[name="${project.fields["billing-client"].key}"]`)).toHaveValue(
    acmeId,
  );
  await selectReactOption(
    createSection.locator(`[name="${project.fields["billing-client"].key}"]`),
    { value: betaId },
  );
  await createSection.locator(`[name="${project.fields.name.key}"]`).fill(`${run.label} Changed Link`);
  await createSection.getByRole("button", { name: `Add ${project.name}` }).click();

  await expect(page).toHaveURL(
    new RegExp(`/entities/${client.id}/records/${acmeId}$`),
  );
  await expect(page.getByRole("link", { name: `${run.label} Changed Link` })).toHaveCount(0);
  await page.goto(`/entities/${client.id}/records/${betaId}`);
  await expect(page.getByRole("link", { name: `${run.label} Changed Link` })).toBeVisible();
});

test("archived origin records do not offer related creation or accept a forged prefill", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { client, deliverable, acmeId } = await createRelatedCreateScenario(run);
  const archiveResult = await supabase
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", client.id)
    .eq("id", acmeId);
  expect(archiveResult.error).toBeNull();

  await page.goto(`/entities/${client.id}/records/${acmeId}`);
  await expect(page.getByRole("link", { name: `Add ${deliverable.name}` })).toHaveCount(0);
  await page.goto(
    `/entities/${deliverable.id}?prefillRelationFieldId=${deliverable.fields.client.id}&originEntityTypeId=${client.id}&originRecordId=${acmeId}`,
  );
  const createSection = addRecordSection(page, deliverable);
  await expect(createSection.locator(`[name="${deliverable.fields.client.key}"]`)).toHaveValue("");
  await expect(createSection.getByRole("link", { name: "Cancel" })).toHaveCount(0);
});
