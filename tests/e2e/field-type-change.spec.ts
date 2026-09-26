import { expect, type Page, test } from "@playwright/test";
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
import { gotoEntity } from "./helpers/ui";

// Focused coverage for safe pristine-only field-type recovery (migration
// 0141/0154): the Manage Fields type-badge recovery affordance. Backend
// dependency-surface coverage (all nine categories, concurrency, workflow
// trigger regressions) lives in lib/domain/field-type-change-commit.test.ts;
// this file only verifies the real UI: type-badge entry by default,
// the preflight-gated picker for a pristine field, a truthful blocked
// explanation for a data-bearing field, and the Relation target picker.

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
}: {
  entity: TestEntity;
  name: string;
  filters?: unknown[];
  sorts?: unknown[];
  columnFieldDefinitionIds?: string[];
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
      is_default: false,
      filters,
      sorts,
      column_field_definition_ids:
        columnFieldDefinitionIds ??
        Object.values(entity.fields)
          .sort((left, right) => left.position - right.position)
          .map((field) => field.id),
      presentation_mode: "table",
      presentation_config: {},
    })
    .select("id")
    .single<{ id: string }>();
  expect(result.error).toBeNull();

  return result.data!.id;
}

function lightnessOf(value: string): number {
  const oklch = value.match(/oklch\(([\d.]+)/);

  if (oklch) {
    return Number(oklch[1]);
  }

  const rgbMatch = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!rgbMatch) {
    throw new Error(`Unable to parse color value: ${value}`);
  }

  const [r, g, b] = [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function readTextAndBackgroundLightness(page: Page, selector: string) {
  const [color, background] = await page.locator(selector).first().evaluate((element) => {
    let node: Element | null = element;
    let backgroundColor = "rgba(0, 0, 0, 0)";

    while (node) {
      const resolved = getComputedStyle(node).backgroundColor;

      if (resolved && resolved !== "rgba(0, 0, 0, 0)" && resolved !== "transparent") {
        backgroundColor = resolved;
        break;
      }

      node = node.parentElement;
    }

    return [getComputedStyle(element).color, backgroundColor];
  });

  return { textLightness: lightnessOf(color), backgroundLightness: lightnessOf(background) };
}

test("Type badge opens the type-change panel, and a pristine field can change type through the real UI", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Ticket", [
    { slug: "priority", name: "Priority", type: "text" },
  ]);
  const viewId = await createView({
    entity,
    name: `${run.label} Column View`,
    columnFieldDefinitionIds: [entity.fields.priority.id],
  });

  await gotoEntity(page, entity, true);

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="Priority"]`) })
    .locator("..");

  await expect(
    fieldRow.getByRole("button", { name: "Change type for Priority, currently Text." }),
  ).toBeVisible();
  await expect(fieldRow.locator('select[name="newType"]')).toHaveCount(0);
  await expect(fieldRow.getByRole("button", { name: "Change type…" })).toHaveCount(0);

  const badge = fieldRow.getByRole("button", {
    name: "Change type for Priority, currently Text.",
  });
  await badge.focus();
  await page.keyboard.press("Enter");
  await expect(fieldRow.locator('select[name="newType"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fieldRow.locator('select[name="newType"]')).toHaveCount(0);
  await expect(badge).toBeFocused();

  await badge.click();
  const newTypeSelect = fieldRow.locator('select[name="newType"]');
  await expect(newTypeSelect).toBeVisible();
  await expect(fieldRow.getByText("Table column references will be preserved.")).toBeVisible();

  await newTypeSelect.selectOption("number");
  await fieldRow.getByRole("button", { name: "Change type", exact: true }).click();

  await expect(fieldRow.getByText("Field type changed.")).toBeVisible();
  await expect(
    fieldRow.getByRole("button", { name: "Change type for Priority, currently Number." }),
  ).toBeVisible();

  const view = await admin
    .from("entity_views")
    .select("column_field_definition_ids")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", viewId)
    .single<{ column_field_definition_ids: string[] }>();
  expect(view.error).toBeNull();
  expect(view.data?.column_field_definition_ids).toEqual([entity.fields.priority.id]);
});

test("a data-bearing field shows a truthful blocking explanation and disables the change", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Note", [
    { slug: "body", name: "Body", type: "text" },
  ]);
  await createEntityRecord({ entity, valuesBySlug: { body: "Has a value" } });

  await gotoEntity(page, entity, true);

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="Body"]`) })
    .locator("..");

  await fieldRow.getByRole("button", { name: "Change type for Body, currently Text." }).click();

  await expect(fieldRow.getByText(/record value/i)).toBeVisible();
  await expect(fieldRow.locator('select[name="newType"]')).toBeVisible();
  await expect(fieldRow.getByRole("button", { name: "Change type", exact: true })).toBeDisabled();
});

test("a saved-view filter dependency gives actionable guidance and the panel stays readable in dark mode", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Filtered Ticket", [
    { slug: "priority", name: "Priority", type: "text" },
  ]);
  await createView({
    entity,
    name: `${run.label} High-priority tasks`,
    filters: [
      {
        fieldDefinitionId: entity.fields.priority.id,
        operator: "equals",
        value: "High",
      },
    ],
  });

  await gotoEntity(page, entity, true);

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="Priority"]`) })
    .locator("..");

  await fieldRow.getByRole("button", { name: "Change type for Priority, currently Text." }).click();
  await expect(fieldRow.getByText("Change unavailable")).toBeVisible();
  await expect(fieldRow.getByText(/used by a filter in/i)).toBeVisible();
  await expect(fieldRow.getByText(/Remove or update that filter/i)).toBeVisible();

  const panelContrast = await readTextAndBackgroundLightness(page, ".field-type-change-panel");
  expect(Math.abs(panelContrast.textLightness - panelContrast.backgroundLightness)).toBeGreaterThan(0.45);
});

test("changing a pristine field to Relation offers the same active-object target picker as Add Field", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const client = await createEntity(admin, run, "Client", []);
  const deal = await createEntity(admin, run, "Deal", [
    { slug: "owner", name: "Owner", type: "text" },
  ]);

  await gotoEntity(page, deal, true);

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator(`input[name="fieldName"][value="Owner"]`) })
    .locator("..");

  await fieldRow.getByRole("button", { name: "Change type for Owner, currently Text." }).click();
  await fieldRow.locator('select[name="newType"]').selectOption("relation");

  const relatedSelect = fieldRow.locator('select[name="newRelatedEntityTypeId"]');
  await expect(relatedSelect).toBeVisible();
  await expect(relatedSelect.getByRole("option", { name: client.name })).toHaveCount(1);
  await relatedSelect.selectOption({ label: client.name });

  await fieldRow.getByRole("button", { name: "Change type", exact: true }).click();

  await expect(fieldRow.getByText("Field type changed.")).toBeVisible();
  await expect(
    fieldRow.getByRole("button", { name: "Change type for Owner, currently Relation." }),
  ).toBeVisible();
});
