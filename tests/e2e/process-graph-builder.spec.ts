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

  test("insert-on-edge splices a node between two existing steps and persists on save", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Graph Insert Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Start");
    // The two default blank steps start with no route between them — remove
    // the second one and re-add a step so "+ Add step"'s own auto-wire
    // (it wires a zero-route trailing step to whatever it adds) gives
    // "Start" a real route to "End", instead of two unconnected steps.
    await page.getByRole("button", { name: "Remove" }).nth(1).click();
    await page.getByRole("button", { name: "+ Add step" }).click();
    await stepNameInput(page, 1).fill("End");

    await page.getByRole("button", { name: "Graph", exact: true }).click();

    await page
      .getByRole("button", { name: "Insert a step between Start and End" })
      .click();
    // Uses Human task rather than Wait: process-validation.ts's wait-amount
    // regex (`/^[1-9]\\d*$/`, an escaped literal backslash+"d" inside a
    // regex literal, not a digit class) rejects every wait amount
    // unconditionally — a pre-existing bug unrelated to 6B, flagged
    // separately rather than fixed here or worked around by asserting on
    // broken behavior.
    await page.getByRole("menuitem", { name: "Human task", exact: true }).click();

    const panel = page.getByRole("region", { name: "Selected step" });
    const nameField = panel.locator('input[type="text"]').first();
    await expect(nameField).toHaveValue("");
    await nameField.fill("Middle");

    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(stepNameInput(page, 0)).toHaveValue("Start");
    await expect(stepNameInput(page, 1)).toHaveValue("Middle");
    await expect(stepNameInput(page, 2)).toHaveValue("End");

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
      .select("name, node_type")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("process_template_id", template!.id)
      .order("position", { ascending: true });
    expect(nodes?.map((node) => [node.name, node.node_type])).toEqual([
      ["Start", "human_task"],
      ["Middle", "human_task"],
      ["End", "human_task"],
    ]);
  });

  test("deleting an unambiguous node offers reconnect vs. no-reconnect; ambiguous nodes delete without a prompt", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Task", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Graph Delete Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("Start");
    await page.getByRole("button", { name: "Remove" }).nth(1).click();
    // Build Start -> Middle -> End via the same trailing-step auto-wire, so
    // "Middle" has exactly one inbound and one outbound route (reconnect-
    // eligible) — the entry step itself never has an inbound route, so it
    // can never be the reconnect example.
    await page.getByRole("button", { name: "+ Add step" }).click();
    await stepNameInput(page, 1).fill("Middle");
    await page.getByRole("button", { name: "+ Add step" }).click();
    await stepNameInput(page, 2).fill("End");
    await page.getByRole("button", { name: "+ Add approval" }).click();

    await page.getByRole("button", { name: "Graph", exact: true }).click();

    // Unambiguous: exactly one inbound edge, one plain outbound route.
    await page.getByRole("button", { name: "Human task: Middle" }).click();
    await page.getByRole("button", { name: "Delete Middle" }).click();
    await expect(page.getByText('Delete "Middle"?')).toBeVisible();
    await expect(
      page.getByRole("button", { name: 'Delete and reconnect "Start" to "End"' }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete without reconnecting" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText('Delete "Middle"?')).toHaveCount(0);

    await page.getByRole("button", { name: "Human task: Middle" }).click();
    await page.getByRole("button", { name: "Delete Middle" }).click();
    await page.getByRole("button", { name: 'Delete and reconnect "Start" to "End"' }).click();
    await expect(page.getByRole("button", { name: "Human task: Middle" })).toHaveCount(0);

    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(stepNameInput(page, 0)).toHaveValue("Start");
    await expect(stepNameInput(page, 1)).toHaveValue("End");

    // Ambiguous: the approval node has two outcomes, so delete happens
    // immediately with no invented rewire — same as today's Remove.
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await page.getByRole("button", { name: "Approval: Approval" }).click();
    await page.getByRole("button", { name: "Delete Approval" }).click();
    await expect(page.getByText('Delete "Approval"?')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approval: Approval" })).toHaveCount(0);
  });

  test("reorder is blocked when it would break an existing route, with a visible reason", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Client", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const templateName = `${run.label} Graph Reorder Guard Template`;

    await page.goto("/processes/new");
    await fillTemplateBasics(page, { name: templateName, appliesTo: entity });
    await stepNameInput(page, 0).fill("First");
    await stepNameInput(page, 1).fill("Second");

    // Freshly typed steps have no route between them yet (the two default
    // blank steps start with empty routes), so swapping them is safe.
    const moveDownFirst = page.getByRole("button", { name: "Move Down" }).first();
    await expect(moveDownFirst).toBeEnabled();

    // Wire First -> Second directly: the same trailing-step auto-wire
    // "+ Add step" always applies (a zero-route last step gets wired to
    // whatever is added) now makes that same swap unsafe.
    await page.getByRole("button", { name: "Remove" }).nth(1).click();
    await page.getByRole("button", { name: "+ Add step" }).click();
    await stepNameInput(page, 1).fill("Second");

    await expect(moveDownFirst).toBeDisabled();
    await expect(moveDownFirst).toHaveAttribute(
      "title",
      'Can\'t reorder: "First" routes directly to "Second".',
    );

    await page.getByRole("button", { name: "Graph", exact: true }).click();
    const graphMoveDown = page.getByRole("button", { name: "Move First down" });
    await expect(graphMoveDown).toBeDisabled();
    await expect(graphMoveDown).toHaveAttribute(
      "title",
      'Can\'t reorder: "First" routes directly to "Second".',
    );
  });
});
