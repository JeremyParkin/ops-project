import { randomUUID } from "node:crypto";
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

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";

// The fixed E2E runner Playwright's default storageState signs page.goto()
// calls in as -- needed as an explicit assignee so the started run's first
// step actually produces a step_assigned event (an unassigned human_task
// produces process_started only, matching 0064's own assignee-required
// gate).
async function getE2eRunnerUserId() {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(error.message);
  const runner = (data?.users ?? []).find((candidate) => candidate.email === E2E_RUNNER_EMAIL);
  if (!runner) throw new Error("E2E runner user not found.");
  return runner.id;
}

async function createSingleStepTemplate(run: TestRun, entity: TestEntity, assigneeUserId: string) {
  const supabase = createSupabaseTestClient();
  const templateId = randomUUID();
  const { error: templateError } = await supabase.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Monthly Client Report`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await supabase.from("process_nodes").insert({
    id: randomUUID(),
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    node_type: "human_task",
    name: "Review summary",
    position: 1,
    assignee_user_id: assigneeUserId,
    config: {},
  });
  if (nodeError) throw new Error(nodeError.message);

  return templateId;
}

test("record detail shows a manual process start and assignment in Activity, newest first, with click-through to the run", async ({
  page,
}) => {
  const run = scenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Activity Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Acme` },
  });
  const runnerUserId = await getE2eRunnerUserId();
  await createSingleStepTemplate(run, entity, runnerUserId);

  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByText("No activity yet.")).toBeVisible();

  await page.getByRole("button", { name: "Start process" }).click();
  await page.waitForURL(/\/process-runs\//);
  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await page.waitForLoadState("networkidle");

  const activitySection = page.locator("section", { has: page.getByRole("heading", { name: "Activity" }) });
  const items = activitySection.locator("li");
  await expect(items).toHaveCount(2);
  // Newest first: assignment (the second thing that happened) renders above
  // the process start (the first thing that happened).
  await expect(items.nth(0)).toContainText("was assigned Review summary");
  await expect(items.nth(1)).toContainText(`${run.label} Monthly Client Report started`);
  await expect(items.nth(1)).not.toContainText("automatically");

  await items.nth(0).getByRole("link").click();
  await page.waitForURL(/\/process-runs\//);
  await expect(page.getByText("Review summary")).toBeVisible();
});

test("a system-triggered process start reads as automatic, with no human actor implied", async ({ page }) => {
  const run = scenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Activity System Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Acme` },
  });
  const runnerUserId = await getE2eRunnerUserId();
  const templateId = await createSingleStepTemplate(run, entity, runnerUserId);

  const { error } = await supabase.rpc("start_process_run_system", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: templateId,
    p_origin_entity_type_id: entity.id,
    p_origin_record_id: recordId,
    p_originating_recurrence_occurrence_id: null,
  });
  expect(error).toBeNull();

  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await page.waitForLoadState("networkidle");

  const activitySection = page.locator("section", { has: page.getByRole("heading", { name: "Activity" }) });
  await expect(activitySection.getByText(`${run.label} Monthly Client Report started automatically`)).toBeVisible();
});
