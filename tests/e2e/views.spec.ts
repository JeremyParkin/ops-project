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
import {
  addRecordSection,
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

async function createView({
  entity,
  name,
  filters = [],
  sorts = [],
  columnFieldDefinitionIds,
  isDefault = false,
}: {
  entity: TestEntity;
  name: string;
  filters?: unknown[];
  sorts?: unknown[];
  columnFieldDefinitionIds?: string[];
  isDefault?: boolean;
}) {
  const supabase = createSupabaseTestClient();
  const { data: existingViews, error: viewError } = await supabase
    .from("entity_views")
    .select("position")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id);
  expect(viewError).toBeNull();

  const position =
    (existingViews ?? []).reduce(
      (max, view) => Math.max(max, Number(view.position)),
      0,
    ) + 1;
  const result = await supabase
    .from("entity_views")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      entity_type_id: entity.id,
      name,
      position,
      is_default: isDefault,
      filters,
      sorts,
      column_field_definition_ids:
        columnFieldDefinitionIds ??
        Object.values(entity.fields)
          .sort((left, right) => left.position - right.position)
          .map((field) => field.id),
    })
    .select("id")
    .single<{ id: string }>();

  expect(result.error).toBeNull();

  return String(result.data?.id);
}

async function createViewsScenario(run: TestRun) {
  const supabase = createSupabaseTestClient();
  const client = await createEntity(supabase, run, "View Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const work = await createEntity(supabase, run, "View Work", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
    { slug: "priority", name: "Priority", type: "number" },
    { slug: "due", name: "Due", type: "date" },
    { slug: "done", name: "Done", type: "boolean" },
    {
      slug: "client",
      name: "Client",
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

  await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} QA Prep`,
      status: "Needs QA",
      priority: 3,
      due: "2026-08-20",
      done: false,
    },
    relationsBySlug: { client: acmeId },
  });
  await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} Launch`,
      status: "Completed",
      priority: 1,
      due: "2026-08-18",
      done: true,
    },
    relationsBySlug: { client: betaId },
  });
  await createEntityRecord({
    entity: work,
    valuesBySlug: {
      title: `${run.label} QA Fix`,
      status: "Needs QA",
      priority: 2,
      due: "2026-08-22",
      done: false,
    },
    relationsBySlug: { client: acmeId },
  });

  return { client, work, acmeId, betaId };
}

test("existing entity with no saved views still shows all records", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);

  await gotoEntity(page, work);
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Fix`)).toBeVisible();
});

test("creates a saved text-filtered view through the UI", async ({ page }) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);

  await gotoEntity(page, work);
  await page.getByText("Manage views", { exact: true }).click();
  await page.getByLabel("View Name").fill(`${run.label} Needs QA`);
  await page.getByRole("button", { name: "Add Filter" }).click();
  await selectReactOption(page.locator('select[name="filterField:0"]'), {
    label: "Status (text)",
  });
  await selectReactOption(page.locator('select[name="filterOperator:0"]'), {
    value: "contains",
  });
  await page.locator('input[name="filterValue:0"]').fill("qa");
  await page.getByRole("button", { name: "Create View" }).click();
  await expect(page.getByText("View created.")).toBeVisible();

  await page.getByRole("link", { name: `${run.label} Needs QA` }).click();
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Fix`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);
});

test("typed filters and AND semantics evaluate deterministically", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Typed`,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Needs QA",
      },
      {
        fieldDefinitionId: work.fields.priority.id,
        operator: "greater_than_or_equal",
        value: 2,
      },
      {
        fieldDefinitionId: work.fields.due.id,
        operator: "after",
        value: "2026-08-19",
      },
      {
        fieldDefinitionId: work.fields.done.id,
        operator: "equals",
        value: false,
      },
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Fix`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);
});

test("relation filters use human-readable labels", async ({ page }) => {
  const run = createScenarioRun();
  const { work, acmeId } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Acme Work`,
    filters: [
      {
        fieldDefinitionId: work.fields.client.id,
        operator: "equals",
        value: acmeId,
      },
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} QA Prep`)).toContainText(
    `${run.label} Acme`,
  );
  await expect(rowForText(page, `${run.label} QA Fix`)).toContainText(
    `${run.label} Acme`,
  );
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);
});

test("sorting, column visibility, and column order persist", async ({ page }) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Ordered`,
    sorts: [
      {
        fieldDefinitionId: work.fields.priority.id,
        direction: "desc",
      },
    ],
    columnFieldDefinitionIds: [
      work.fields.priority.id,
      work.fields.title.id,
      work.fields.status.id,
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  const headers = page.getByRole("table").getByRole("columnheader");
  await expect(headers.nth(0)).toHaveText("Priority");
  await expect(headers.nth(1)).toHaveText("Title");
  await expect(headers.nth(2)).toHaveText("Status");
  await expect(headers.filter({ hasText: "Due" })).toHaveCount(0);

  const rows = page.getByRole("table").getByRole("row");
  await expect(rows.nth(1)).toContainText(`${run.label} QA Prep`);
  await expect(rows.nth(2)).toContainText(`${run.label} QA Fix`);
  await expect(rows.nth(3)).toContainText(`${run.label} Launch`);

  await page.reload();
  await expect(headers.nth(0)).toHaveText("Priority");
});

test("default view can be used and cleared back to All Records", async ({
  page,
}) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  await createView({
    entity: work,
    name: `${run.label} Default QA`,
    isDefault: true,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Needs QA",
      },
    ],
  });

  await page.goto(`/entities/${work.id}`);
  await expect(rowForText(page, `${run.label} QA Prep`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Launch`)).toHaveCount(0);

  await page.getByRole("link", { name: `All ${work.name}` }).click();
  await expect(rowForText(page, `${run.label} Launch`)).toBeVisible();
});

test("editing a record can move it into a filtered view", async ({ page }) => {
  const run = createScenarioRun();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Completed`,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Completed",
      },
    ],
  });

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} Launch`)).toBeVisible();
  await expect(rowForText(page, `${run.label} New Done`)).toHaveCount(0);

  await gotoEntity(page, work);
  const form = addRecordSection(page, work);
  await fillRecordField(form, work.fields.title, `${run.label} New Done`);
  await fillRecordField(form, work.fields.status, "Completed");
  await submitAddRecord(page, work);
  await expect(page.getByText(`${work.name} created.`)).toBeVisible();

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(rowForText(page, `${run.label} New Done`)).toBeVisible();
});

test("archived filter references fail closed with repair warning", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Stale`,
    filters: [
      {
        fieldDefinitionId: work.fields.status.id,
        operator: "equals",
        value: "Needs QA",
      },
    ],
  });
  const archiveResult = await supabase
    .from("field_definitions")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id)
    .eq("id", work.fields.status.id);
  expect(archiveResult.error).toBeNull();

  await page.goto(`/entities/${work.id}?view=${viewId}`);
  await expect(page.getByText("View needs repair.")).toBeVisible();
  await expect(
    page.getByText("This view cannot be evaluated correctly."),
  ).toBeVisible();
  await expect(rowForText(page, `${run.label} QA Prep`)).toHaveCount(0);
  await expect(page.getByRole("link", { name: `All ${work.name}` })).toBeVisible();
});

test("field hard delete is blocked by saved view dependency and deleting a view preserves records", async () => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const { work } = await createViewsScenario(run);
  const viewId = await createView({
    entity: work,
    name: `${run.label} Dependency`,
    columnFieldDefinitionIds: [work.fields.title.id, work.fields.status.id],
  });

  const blocked = await supabase.rpc("delete_field_definition_if_safe", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_entity_type_id: work.id,
    p_field_definition_id: work.fields.status.id,
  });
  expect(blocked.error).toBeNull();
  expect(blocked.data?.[0]?.deleted).toBe(false);
  expect(blocked.data?.[0]?.view_reference_count).toBe(1);

  const deleteViewResult = await supabase
    .from("entity_views")
    .delete()
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id)
    .eq("id", viewId);
  expect(deleteViewResult.error).toBeNull();

  const records = await supabase
    .from("entity_records")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", work.id);
  expect(records.error).toBeNull();
  expect(records.data?.length).toBe(3);
});
