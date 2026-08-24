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
import { selectReactOption } from "./helpers/ui";

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

function stepNameInput(page: import("@playwright/test").Page, index: number) {
  return page.locator('input[name="stepName"]').nth(index);
}

async function fillTemplateBasics(
  page: import("@playwright/test").Page,
  {
    name,
    appliesTo,
  }: {
    name: string;
    appliesTo?: TestEntity;
  },
) {
  await page.locator("#process-template-name").fill(name);

  if (appliesTo) {
    await selectReactOption(page.locator("#process-template-applies-to"), {
      value: appliesTo.id,
    });
  }
}

test.describe("process templates", () => {
  test("persists optional hours and days due rules through the template editor", async ({ page }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Due Rule Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Four-hour review");
    await stepNameInput(page, 1).fill("Two-day approval");
    await page.locator('input[name="stepDueAmount"]').nth(0).fill("4");
    await page.locator('input[name="stepDueAmount"]').nth(1).fill("2");
    await page.getByLabel("Due unit for step 1").selectOption("hours");
    await page.getByLabel("Due unit for step 2").selectOption("days");
    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: templateName })).toBeVisible();

    const { data: template } = await supabase
      .from("process_templates")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("name", templateName)
      .single();
    const { data: nodes } = await supabase
      .from("process_nodes")
      .select("name, config")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", template!.id)
      .order("created_at", { ascending: true });
    expect(nodes).toEqual([
      { name: "Four-hour review", config: { due_rule: { amount: 4, unit: "hours" } } },
      { name: "Two-day approval", config: { due_rule: { amount: 2, unit: "days" } } },
    ]);
  });

  test("creates a template with ordered steps, then rename/reorder preserves stable node IDs", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Monthly Report Production`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Prepare Data");
    await stepNameInput(page, 1).fill("Draft Report");
    await page.getByRole("button", { name: "+ Add step" }).click();
    await stepNameInput(page, 2).fill("Review");

    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: templateName })).toBeVisible();

    await page.getByRole("link", { name: templateName }).click();
    await expect(
      page.getByRole("heading", { name: "Edit Process Template" }),
    ).toBeVisible();
    await expect(stepNameInput(page, 0)).toHaveValue("Prepare Data");
    await expect(stepNameInput(page, 1)).toHaveValue("Draft Report");
    await expect(stepNameInput(page, 2)).toHaveValue("Review");

    const { data: templateRows } = await supabase
      .from("process_templates")
      .select("id")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .ilike("name", templateName);
    const templateId = templateRows?.[0]?.id as string;
    expect(templateId).toBeTruthy();

    const { data: nodesBefore } = await supabase
      .from("process_nodes")
      .select("id, name")
      .eq("process_template_id", templateId)
      .order("created_at", { ascending: true });
    const nodeIdsBefore = new Set((nodesBefore ?? []).map((node) => node.id as string));
    expect(nodeIdsBefore.size).toBe(3);

    // Rename the first step and move it down one position.
    await stepNameInput(page, 0).fill("Prepare Source Data");
    await page.getByRole("button", { name: "Move Down" }).first().click();
    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: templateName })).toBeVisible();

    const { data: nodesAfter } = await supabase
      .from("process_nodes")
      .select("id, name")
      .eq("process_template_id", templateId);
    const nodeIdsAfter = new Set((nodesAfter ?? []).map((node) => node.id as string));

    expect(nodeIdsAfter).toEqual(nodeIdsBefore);

    const renamedNode = (nodesAfter ?? []).find(
      (node) => node.name === "Prepare Source Data",
    );
    expect(renamedNode).toBeTruthy();

    await page.getByRole("link", { name: templateName }).click();
    await expect(stepNameInput(page, 0)).toHaveValue("Draft Report");
    await expect(stepNameInput(page, 1)).toHaveValue("Prepare Source Data");
    await expect(stepNameInput(page, 2)).toHaveValue("Review");
  });

  test("archived templates are read-only and cannot be edited until restored", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Ticket", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Archive Lifecycle Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Step One");
    await stepNameInput(page, 1).fill("Step Two");
    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: templateName })).toBeVisible();

    await page
      .getByRole("row")
      .filter({ hasText: templateName })
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: templateName }),
    ).toContainText("Archived");

    await page.getByRole("link", { name: templateName }).click();
    await expect(
      page.getByText("This process template is archived and read-only."),
    ).toBeVisible();

    await page.goto("/processes");
    await page
      .getByRole("row")
      .filter({ hasText: templateName })
      .getByRole("button", { name: "Restore" })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: templateName }),
    ).toContainText("Active");
  });

  test("hard delete is blocked while a process run references the template, and succeeds once unreferenced", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Project", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const unreferencedTemplateName = `${run.label} Unreferenced Template`;
    const referencedTemplateName = `${run.label} Referenced Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, {
      name: unreferencedTemplateName,
      appliesTo: entity,
    });
    await stepNameInput(page, 0).fill("Only Step");
    await stepNameInput(page, 1).fill("Second Step");
    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: unreferencedTemplateName })).toBeVisible();

    await page.goto("/processes/new");
    await fillTemplateBasics(page, {
      name: referencedTemplateName,
      appliesTo: entity,
    });
    await stepNameInput(page, 0).fill("Only Step");
    await stepNameInput(page, 1).fill("Second Step");
    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: referencedTemplateName })).toBeVisible();

    const recordId = await createEntityRecord({
      entity,
      valuesBySlug: { name: `${run.label} Blocking Record` },
    });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    const referencedTemplateCard = page
      .locator("div")
      .filter({ has: page.getByRole("heading", { name: referencedTemplateName, level: 3 }) })
      .last();
    await referencedTemplateCard.getByRole("button", { name: "Start process" }).click();
    // "Start process" redirects to the new run's detail page; wait for that
    // before moving on, so the run genuinely exists before we try to delete
    // the template it belongs to.
    await page.waitForURL(/\/process-runs\//);

    await page.goto("/processes");
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("row")
      .filter({ hasText: unreferencedTemplateName })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: unreferencedTemplateName }),
    ).toHaveCount(0);

    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("row")
      .filter({ hasText: referencedTemplateName })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByText(/Cannot delete this process template because 1 process run/),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: referencedTemplateName })).toBeVisible();
  });

  test("entity safe-delete is blocked by an applicable process template, and restored once the template is removed", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Campaign", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Entity Delete Guard Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Only Step");
    await stepNameInput(page, 1).fill("Second Step");
    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: templateName })).toBeVisible();

    await page.goto(`/entities/${entity.id}?manage=true`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete Entity" }).click();
    await expect(
      page.getByText(new RegExp(`Cannot delete .* because 1 process template`)),
    ).toBeVisible();

    await page.goto("/processes");
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("row")
      .filter({ hasText: templateName })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: templateName }),
    ).toHaveCount(0);

    await page.goto(`/entities/${entity.id}?manage=true`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete Entity" }).click();
    await expect(page).toHaveURL("/");
  });
});
