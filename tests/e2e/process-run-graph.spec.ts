import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createEntity,
  createEntityRecord,
  createSupabaseTestClient,
  createTestRun,
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

function processCard(page: Page, templateName: string): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: templateName, level: 3 }) })
    .last();
}

function nodeCard(page: Page, label: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `) });
}

function edgePath(page: Page, from: string, to: string): Locator {
  return page.locator(`[data-testid="edge-${from}-to-${to}"]`);
}

test.describe("process run graph", () => {
  test("shows node/edge execution state as a run progresses, and actions from the Graph panel work identically to List", async ({
    page,
  }) => {
    const run = createScenarioRun();
    const supabase = createSupabaseTestClient();
    const entity = await createEntity(supabase, run, "Deliverable", [
      { slug: "name", name: "Name", type: "text", required: true },
    ]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Widget rollout" } });
    const templateName = `${run.label} Run Graph Template`;

    // Build Intake -> Approval (Approve/Reject) -> [Approved follow-up |
    // Rejected follow-up] -> Parallel split -> [First | Second] -> Join,
    // via the same toolbar convenience already covered by
    // process-graph-builder.spec.ts — this test is about the run graph,
    // not template construction.
    await page.goto("/processes/new");
    await page.locator("#process-template-name").fill(templateName);
    await selectReactOption(page.locator("#process-template-applies-to"), { value: entity.id });
    await page.getByRole("button", { name: "Remove" }).nth(1).click();
    await page.locator('input[name="stepName"]').nth(0).fill("Intake");
    await page.getByRole("button", { name: "+ Add approval" }).click();
    await page.getByRole("button", { name: "+ Add parallel paths" }).click();
    await page.getByRole("button", { name: "Save Process Template" }).click();
    await expect(page.getByRole("link", { name: templateName })).toBeVisible();

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, templateName).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);

    await page.getByRole("button", { name: "Graph", exact: true }).click();

    // Initial state: Intake active, everything else pending, and every
    // outgoing edge undetermined (dashed, neutral) since nothing has
    // resolved yet.
    await expect(nodeCard(page, "Human task").filter({ hasText: "Intake" })).toHaveAttribute(
      "aria-label",
      /\(active\)/,
    );
    await expect(edgePath(page, "Intake", "Approval")).toHaveAttribute("data-taken", "undetermined");

    // Complete Intake from the Graph panel.
    await nodeCard(page, "Human task").filter({ hasText: "Intake" }).click();
    await page.getByRole("region", { name: "Selected step" }).getByRole("button", { name: "Complete" }).click();

    await expect(nodeCard(page, "Approval").filter({ hasText: "Approval" })).toHaveAttribute(
      "aria-label",
      /\(active\)/,
    );
    await expect(edgePath(page, "Intake", "Approval")).toHaveAttribute("data-taken", "true");

    // Reject the approval — the taken route to "Rejected follow-up" must
    // read as visually dominant, the untaken route to "Approved follow-up"
    // low-emphasis, and "Approved follow-up" itself skipped.
    await nodeCard(page, "Approval").filter({ hasText: "Approval" }).click();
    await page.getByRole("region", { name: "Selected step" }).getByRole("button", { name: "Reject" }).click();

    const takenEdge = edgePath(page, "Approval", "Rejected follow-up");
    const untakenEdge = edgePath(page, "Approval", "Approved follow-up");
    await expect(takenEdge).toHaveAttribute("data-taken", "true");
    await expect(untakenEdge).toHaveAttribute("data-taken", "false");
    const takenOpacity = await takenEdge.evaluate((el) => Number(el.getAttribute("stroke-opacity")));
    const untakenOpacity = await untakenEdge.evaluate((el) => Number(el.getAttribute("stroke-opacity")));
    expect(takenOpacity).toBeGreaterThan(untakenOpacity);
    await expect(untakenOpacity).toBeLessThan(0.5);

    await expect(nodeCard(page, "Human task").filter({ hasText: "Approved follow-up" })).toHaveAttribute(
      "aria-label",
      /\(skipped\)/,
    );
    await expect(page.getByText("Skipped", { exact: true }).first()).toBeVisible();

    await nodeCard(page, "Human task").filter({ hasText: "Approved follow-up" }).click();
    await expect(page.getByRole("region", { name: "Selected step" })).not.toContainText("Complete");

    // Advance through Rejected follow-up into the parallel region.
    await nodeCard(page, "Human task").filter({ hasText: "Rejected follow-up" }).click();
    await page.getByRole("region", { name: "Selected step" }).getByRole("button", { name: "Complete" }).click();

    await expect(nodeCard(page, "Human task").filter({ hasText: "First parallel task" })).toHaveAttribute(
      "aria-label",
      /\(active\)/,
    );

    // Complete one branch; the join must show it's still waiting for the
    // other, then flip to fully joined once both arrive.
    await nodeCard(page, "Human task").filter({ hasText: "First parallel task" }).click();
    await page.getByRole("region", { name: "Selected step" }).getByRole("button", { name: "Complete" }).click();

    await expect(
      nodeCard(page, "Join parallel paths").filter({ hasText: "Join parallel paths" }),
    ).toContainText("Waiting for 1 of 2 branches.");

    await nodeCard(page, "Human task").filter({ hasText: "Second parallel task" }).click();
    await page.getByRole("region", { name: "Selected step" }).getByRole("button", { name: "Complete" }).click();

    await expect(
      nodeCard(page, "Join parallel paths").filter({ hasText: "Join parallel paths" }),
    ).toHaveAttribute("aria-label", /\(completed\)/);
    await expect(
      nodeCard(page, "Join parallel paths").filter({ hasText: "Join parallel paths" }),
    ).toContainText("2 of 2 branches joined.");

    // The run is now fully complete — the completed-run picture, including
    // the earlier skip, must be intact, and switching to List must show the
    // exact same terminal state (the two views share one data source).
    await expect(page.getByText("Complete", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByText("7 of 8 steps complete, 1 skipped")).toBeVisible();
  });
});
