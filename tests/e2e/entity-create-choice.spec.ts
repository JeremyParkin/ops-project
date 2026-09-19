import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createSupabaseTestClient,
  createTestRun,
  type TestRun,
} from "./helpers/supabase-test-data";

// Focused coverage for the Create Object Choice draft-option editor polish
// slice: default row count, Add option placement, the swatch+name color
// selector, and the compact trash remove control. The underlying migration
// 0140 (zero-option Choice fields are backend-valid) is verified/complete
// elsewhere and not retested here.

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

test("selecting Choice starts with one empty option row, Add option appends another, and removing a draft option works", async ({
  page,
}) => {
  await page.goto("/entities/new");

  await page.locator("#fieldName\\:field-1").fill("Priority");
  await page.locator("#fieldType\\:field-1").selectOption("choice");

  const optionLabelInputs = page.getByPlaceholder(/^Option \d+$/);
  await expect(optionLabelInputs).toHaveCount(1);
  await expect(page.getByPlaceholder("Option 1")).toBeVisible();

  await optionLabelInputs.nth(0).fill("Red");

  await page.getByRole("button", { name: "Add option" }).click();
  await expect(optionLabelInputs).toHaveCount(2);
  await expect(page.getByPlaceholder("Option 2")).toBeVisible();
  await optionLabelInputs.nth(1).fill("Blue");
  await page.getByLabel("Option 2 color").selectOption("orange");

  // Remove the FIRST draft row (not the last) to confirm removal targets
  // the clicked row's own identity, not just "pop the end of the list".
  await page.getByRole("button", { name: "Remove option" }).first().click();
  await expect(optionLabelInputs).toHaveCount(1);
  await expect(optionLabelInputs.first()).toHaveValue("Blue");
  await expect(page.getByLabel("Option 1 color")).toHaveValue("orange");
});

test("color selection persists the expected draft value, and the submitted object creates with correct option labels/colors", async ({
  page,
}) => {
  const run = createScenarioRun();
  const entityName = `${run.label} Status Board`;

  await page.goto("/entities/new");
  await page.locator("#entityName").fill(entityName);
  await page.locator("#fieldName\\:field-1").fill("Status");
  await page.locator("#fieldType\\:field-1").selectOption("choice");

  const optionLabelInputs = page.getByPlaceholder(/^Option \d+$/);
  await optionLabelInputs.nth(0).fill("Todo");
  await page.getByLabel("Option 1 color").selectOption("teal");

  await page.getByRole("button", { name: "Add option" }).click();
  await optionLabelInputs.nth(1).fill("Done");
  await page.getByLabel("Option 2 color").selectOption("emerald");

  await page.getByRole("button", { name: "Create object" }).click();
  await page.waitForURL(/\/entities\/[0-9a-f-]{36}$/);
  const entityTypeId = page.url().match(/entities\/([0-9a-f-]{36})/)?.[1];
  expect(entityTypeId).toBeTruthy();

  const admin = createSupabaseTestClient();
  const { data: field } = await admin
    .from("field_definitions")
    .select("id")
    .eq("entity_type_id", entityTypeId)
    .eq("type", "choice")
    .single<{ id: string }>();
  expect(field).toBeTruthy();

  const { data: options } = await admin
    .from("field_choice_options")
    .select("label, color, position")
    .eq("field_definition_id", field!.id)
    .order("position", { ascending: true });

  expect(options).toEqual([
    { label: "Todo", color: "teal", position: 1 },
    { label: "Done", color: "emerald", position: 2 },
  ]);
});

test("narrow viewport: the Choice option editor wraps without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/entities/new");

  await page.locator("#fieldName\\:field-1").fill("Priority");
  await page.locator("#fieldType\\:field-1").selectOption("choice");
  await expect(page.getByPlaceholder("Option 1")).toBeVisible();

  // Scoped to the Create Object form itself, not the whole document: the
  // app header (notification bell) has its own small pre-existing overflow
  // at this width, unrelated to this slice and out of scope to fix here.
  const overflowX = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const form = document.querySelector("form");
    if (!form) {
      throw new Error("Create Object form not found");
    }
    return form.scrollWidth > viewportWidth || form.getBoundingClientRect().right > viewportWidth + 1;
  });
  expect(overflowX).toBe(false);

  await expect(page.getByRole("button", { name: "Add option" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove option" })).toBeVisible();
});
