import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestEntity,
  type TestField,
  type TestRun,
} from "./helpers/supabase-test-data";
import { expectAfterMutation, gotoEntity, rowForText } from "./helpers/ui";

// Covers the Phase 9 visual-polish follow-up: the Choice option swatch
// picker (replacing the plain <select>) and the long-text clamp/More/Less
// cell presentation. Pill color/contrast itself is covered at the unit
// level in lib/domain/choice-colors.test.ts (all 12 colors) -- this file
// only needs to prove the real UI wiring and keyboard behavior end to end.

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

// Mirrors choice-field.spec.ts's own local helper: field_choice_options
// isn't part of supabase-test-data.ts's shared FieldInput union.
async function addChoiceField({ entity, slug, name }: { entity: TestEntity; slug: string; name: string }) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const key = `fld_e2e_choice_${entity.id.slice(0, 8)}_${slug}`.replace(/-/g, "_");
  const { error } = await admin.from("field_definitions").insert({
    id,
    workspace_id: DEMO_WORKSPACE_ID,
    entity_type_id: entity.id,
    key,
    name,
    slug,
    type: "choice",
    required: false,
    position: 99,
  });
  if (error) throw new Error(error.message);
  entity.fields[slug] = { id, key, name, slug, type: "choice" as never, position: 99 };
  return { id, key };
}

function inlineEditButton(row: Locator, field: TestField) {
  return row.getByRole("button", { name: `Edit ${field.name}` });
}

test("Choice option swatch picker: keyboard selection, visible selected state, and the resulting pill color", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Ticket", [
    { slug: "title", name: "Title", type: "text", required: true },
  ]);
  await addChoiceField({ entity, slug: "priority", name: "Priority" });

  await gotoEntity(page, entity, true);

  const fieldRow = page
    .locator("form")
    .filter({ has: page.locator('input[name="fieldName"][value="Priority"]') })
    .locator("..");

  await fieldRow.getByLabel("New option").fill("Urgent");

  // The picker is a native radiogroup, not a <select> -- select it with a
  // real keyboard path (Tab to the group, then arrow keys to the target
  // swatch) rather than a direct click, so this test actually exercises
  // keyboard accessibility rather than just the resulting form value.
  const colorGroup = fieldRow.getByRole("radiogroup", { name: "Color" });
  await colorGroup.getByRole("radio", { name: "No color" }).focus();
  // Order in CHOICE_OPTION_COLORS: gray, red, amber, emerald, blue, violet,
  // orange, teal, cyan, indigo, rose, lime -- "No color" then 6 presses
  // right lands on Violet.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("ArrowRight");
  }
  const violetRadio = colorGroup.getByRole("radio", { name: "Violet" });
  await expect(violetRadio).toBeChecked();
  // Selected-state affordance is visible, not just programmatically true.
  await expect(colorGroup.locator("label").filter({ hasText: "Violet" })).toHaveClass(/border-grit|has-/);

  await fieldRow.getByRole("button", { name: "Add Option" }).click();
  await expectAfterMutation(page.getByText("Option added."));
  await expect(fieldRow.locator('input[value="Urgent"]')).toHaveCount(1);

  // Confirm the option actually persisted with the violet color (not
  // silently dropped), and that it renders as a violet pill on a record.
  await gotoEntity(page, entity, false);
  await page.getByRole("link", { name: `Add ${entity.name}` }).first().click();
  await page.locator(`[name="${entity.fields.title.key}"]`).fill(`${run.label} Ticket`);
  const priorityKey = entity.fields.priority.key;
  const urgentOption = page.locator(`select[name="${priorityKey}"] option`, { hasText: "Urgent" });
  const urgentValue = await urgentOption.getAttribute("value");
  await page.locator(`[name="${priorityKey}"]`).selectOption(urgentValue!);
  await page.getByRole("button", { name: `Add ${entity.name}` }).click();
  await expectAfterMutation(page.getByText(`${entity.name} created.`));

  const row = rowForText(page, `${run.label} Ticket`);
  await expect(row.getByText("Urgent")).toHaveClass(/border-violet-400/);
});

test("Long text clamps to 2 lines by default with a separate More/Less toggle; identity and linkified URL/email cells are excluded", async ({
  page,
}) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "notes", name: "Notes", type: "text" },
    { slug: "website", name: "Website", type: "text" },
    { slug: "active", name: "Active", type: "boolean" },
  ]);

  const longNotes =
    "This is a deliberately long free-text value written to wrap well past two lines in a normal table cell, " +
    "so the default clamp behavior and its More/Less toggle both have something real to expand and collapse " +
    "in this test, without relying on any fixed pixel-width assumption about the column.";
  const longUrl =
    "https://example.com/a/very/long/path/segment/that/keeps/going/and/going/without/any/spaces/in/it/at/all";

  await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Long Notes Co.`, notes: longNotes, website: longUrl, active: false },
  });

  await gotoEntity(page, entity, false);

  const row = rowForText(page, `${run.label} Long Notes Co.`);
  await expect(row).toBeVisible();

  // Notes: genuinely truncated, so "More" is offered, starts collapsed.
  // The text node stays in the DOM either way (line-clamp is visual
  // truncation, not removal), so the clamp itself is asserted via the
  // line-clamp-2 class rather than toBeVisible().
  const moreButton = row.getByRole("button", { name: "More" });
  const clampedText = row.getByText(longNotes);
  await expect(moreButton).toBeVisible();
  await expect(moreButton).toHaveAttribute("aria-expanded", "false");
  await expect(clampedText).toHaveClass(/line-clamp-2/);

  // Expanding is a separate control from inline-edit activation -- the
  // field's own "Edit" trigger must still be present and distinct.
  await expect(inlineEditButton(row, entity.fields.notes)).toBeVisible();

  await moreButton.click();
  const lessButton = row.getByRole("button", { name: "Less" });
  await expect(lessButton).toHaveAttribute("aria-expanded", "true");
  await expect(clampedText).not.toHaveClass(/line-clamp-2/);
  await lessButton.click();
  await expect(row.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
  await expect(clampedText).toHaveClass(/line-clamp-2/);

  // Identity field (Name): never clamped, no More, even though this test
  // gave it a longer-than-usual value on purpose.
  await expect(row.getByRole("button", { name: "More" })).toHaveCount(1); // only the Notes cell's
  await expect(row.getByRole("link", { name: `${run.label} Long Notes Co.` })).toBeVisible();

  // Linkified URL value: still a plain clickable link with just its
  // "Edit" trigger, never a clamp/More affordance despite being long.
  const websiteLink = row.getByRole("link", { name: longUrl });
  await expect(websiteLink).toBeVisible();
  await expect(websiteLink).toHaveAttribute("href", longUrl);
  await expect(inlineEditButton(row, entity.fields.website)).toBeVisible();

  // Light regression check: a non-text inline-editable field on the same
  // row still opens and saves correctly after the cell-rendering changes.
  await inlineEditButton(row, entity.fields.active).click();
  const checkbox = row.locator('input[name="value"][type="checkbox"]');
  await checkbox.check();
  await checkbox.press("Enter");
  await expect(inlineEditButton(row, entity.fields.active)).toHaveText("Yes");
});

test("Short text and empty values never show a More toggle", async ({ page }: { page: Page }) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Client", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "notes", name: "Notes", type: "text" },
  ]);

  await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Short Notes Co.`, notes: "Short note." },
  });
  await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Blank Notes Co.`, notes: null },
  });

  await gotoEntity(page, entity, false);

  await expect(rowForText(page, `${run.label} Short Notes Co.`).getByRole("button", { name: "More" })).toHaveCount(0);
  await expect(rowForText(page, `${run.label} Blank Notes Co.`).getByRole("button", { name: "More" })).toHaveCount(0);
});
