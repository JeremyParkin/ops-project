import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
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
  { name, appliesTo }: { name: string; appliesTo: TestEntity },
) {
  await page.locator("#process-template-name").fill(name);
  await selectReactOption(page.locator("#process-template-applies-to"), {
    value: appliesTo.id,
  });
}

test.describe("process graph builder", () => {
  test("Graph view renders every node type distinctly and shares state with the List view", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Graph Node Types Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Intake");
    await stepNameInput(page, 1).fill("Review");
    await page.getByRole("button", { name: "+ Add approval" }).click();
    await page.getByRole("button", { name: "+ Add wait" }).click();
    await page.getByRole("button", { name: "+ Add condition wait" }).click();
    await page.getByRole("button", { name: "+ Add parallel paths" }).click();

    await page.getByRole("button", { name: "Graph", exact: true }).click();

    await expect(page.getByRole("button", { name: "Human task: Intake" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Human task: Review" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approval: Approval" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Wait: Wait" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Wait for condition: Wait for condition" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Parallel paths: Parallel paths" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Join parallel paths: Join parallel paths" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(stepNameInput(page, 0)).toHaveValue("Intake");
    await expect(stepNameInput(page, 1)).toHaveValue("Review");
  });

  test("selecting a node opens a pre-filled side panel, and editing there persists on save", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Task", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Graph Panel Edit Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Original name");
    await stepNameInput(page, 1).fill("Second step");

    await page.getByRole("button", { name: "Graph", exact: true }).click();

    const originalNodeButton = page.getByRole("button", { name: "Human task: Original name" });
    await expect(originalNodeButton).toBeVisible();
    await originalNodeButton.click();
    await expect(originalNodeButton).toHaveAttribute("aria-pressed", "true");

    const panel = page.getByRole("region", { name: "Selected step" });
    const nameField = panel.locator('input[type="text"]').first();
    await expect(nameField).toHaveValue("Original name");
    await nameField.fill("Renamed via graph panel");

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
      .select("name")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", template!.id)
      .order("position", { ascending: true });
    expect(nodes?.[0]?.name).toBe("Renamed via graph panel");
    expect(nodes?.[1]?.name).toBe("Second step");
  });

  test("keyboard selection: Enter opens the panel, Escape deselects", async ({ page }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Graph Keyboard Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Keyboard step");
    await stepNameInput(page, 1).fill("Next step");

    await page.getByRole("button", { name: "Graph", exact: true }).click();

    const nodeButton = page.getByRole("button", { name: "Human task: Keyboard step" });
    await nodeButton.focus();
    await page.keyboard.press("Enter");
    await expect(nodeButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Selected step" }).getByRole("textbox").first()).toHaveValue(
      "Keyboard step",
    );

    await nodeButton.focus();
    await page.keyboard.press("Escape");
    await expect(nodeButton).toHaveAttribute("aria-pressed", "false");
  });
});
