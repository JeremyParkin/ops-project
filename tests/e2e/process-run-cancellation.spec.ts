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
  type TestRun,
} from "./helpers/supabase-test-data";

// Phase 11.1 Cancel Process Run: focused E2E coverage over the real UI --
// button visibility, the required-reason confirmation interaction, the
// resulting run/step labels, record-detail summary, and My Work exclusion.
// RPC-level coverage (every node type, parallel branches, history
// preservation, authorization boundaries, impersonation) lives in
// lib/domain/process-run-cancellation-commit.test.ts; this spec only proves
// the UI wires up to that RPC correctly.

test.describe.configure({ mode: "serial" });

const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const runs: TestRun[] = [];
let e2eRunnerUserId: string | undefined;

async function getE2eRunnerUserId() {
  if (e2eRunnerUserId) return e2eRunnerUserId;
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(error.message);
  const user = data.users.find((candidate) => candidate.email === E2E_RUNNER_EMAIL);
  if (!user) throw new Error("Unable to find the E2E runner user.");
  e2eRunnerUserId = user.id;
  return e2eRunnerUserId;
}

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async () => {
  const failures: string[] = [];
  await Promise.all(
    runs.map((run) =>
      cleanupE2eRun(run).catch((error) => {
        failures.push(error instanceof Error ? error.message : String(error));
      }),
    ),
  );
  if (failures.length > 0) {
    throw new Error(`process-run-cancellation afterAll cleanup failed:\n${failures.join("\n")}`);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function createProcessTemplateFixture(
  entity: TestEntity,
  stepNames: string[],
  templateName: string,
  assigneeUserIds: Array<string | null> = [],
) {
  const supabase = createSupabaseTestClient();
  const templateId = randomUUID();

  const { error: templateError } = await supabase.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: templateName,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(`Unable to create process template fixture: ${templateError.message}`);

  const nodeIds = stepNames.map(() => randomUUID());
  const { error: nodeError } = await supabase.from("process_nodes").insert(
    stepNames.map((name, index) => ({
      id: nodeIds[index],
      workspace_id: DEMO_WORKSPACE_ID,
      process_template_id: templateId,
      node_type: "human_task",
      name,
      position: index + 1,
      assignee_user_id: assigneeUserIds[index] ?? null,
      config: {},
    })),
  );
  if (nodeError) throw new Error(`Unable to create process node fixtures: ${nodeError.message}`);

  const edges = nodeIds.slice(0, -1).map((sourceNodeId, index) => ({
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    source_node_id: sourceNodeId,
    target_node_id: nodeIds[index + 1],
    priority: 0,
    is_default: true,
  }));
  if (edges.length > 0) {
    const { error: edgeError } = await supabase.from("process_edges").insert(edges);
    if (edgeError) throw new Error(`Unable to create process edge fixtures: ${edgeError.message}`);
  }

  return { id: templateId, name: templateName };
}

async function createScenario(
  stepNames: string[],
  templateNameSuffix: string,
  assigneeUserIds: Array<string | null> = [],
) {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Deliverable", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const template = await createProcessTemplateFixture(
    entity,
    stepNames,
    `${run.label} ${entity.name} ${templateNameSuffix}`,
    assigneeUserIds,
  );
  return { run, entity, template };
}

function stepRow(page: Page, stepName: string): Locator {
  const escapedStepName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator("li").filter({ has: page.getByText(new RegExp(`^\\d+\\. ${escapedStepName}$`)) });
}

function processCard(page: Page, templateName: string): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: templateName, level: 3 }) })
    .last();
}

test.describe("process run cancellation", () => {
  test("cancelling an active run requires a reason, updates run/step labels, and offers a new run from record detail", async ({
    page,
  }) => {
    const { entity, template } = await createScenario(["Task One", "Task Two"], "Cancellation Playbook");
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Cancellation Record" } });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);

    await expect(page.getByText("Active", { exact: true })).toBeVisible();
    const cancelButton = page.getByRole("button", { name: "Cancel process" });
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    const reasonField = page.getByLabel("Reason (required)");
    await expect(reasonField).toBeVisible();
    await expect(reasonField).toHaveAttribute("required", "");

    // Native required-field validation blocks an empty submit -- the RPC is
    // never reached, so the run stays active.
    await page.getByRole("button", { name: "Confirm cancellation" }).click();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();

    await reasonField.fill("No longer needed for this record.");
    await page.getByRole("button", { name: "Confirm cancellation" }).click();

    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel process" })).toHaveCount(0);
    await expect(stepRow(page, "Task One")).toContainText("cancelled");
    await expect(stepRow(page, "Task One").getByRole("button", { name: "Complete" })).toHaveCount(0);
    await expect(stepRow(page, "Task Two")).toContainText("cancelled");
    await expect(page.getByText("No longer needed for this record.")).toBeVisible();

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await expect(processCard(page, template.name)).toContainText("Cancelled");
    await expect(
      processCard(page, template.name).getByRole("button", { name: "Start another run" }),
    ).toBeVisible();
  });

  test("a cancelled step's active work no longer appears in My Work", async ({ page }) => {
    const runnerId = await getE2eRunnerUserId();
    const { entity, template } = await createScenario(["Only Task"], "My Work Cancellation Playbook", [runnerId]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "My Work Cancellation Record" } });

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await processCard(page, template.name).getByRole("button", { name: "Start process" }).click();
    await page.waitForURL(/\/process-runs\//);

    await page.goto("/my-work");
    await expect(page.getByText(template.name)).toBeVisible();

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await page.getByRole("link", { name: "Open process" }).click();
    await page.waitForURL(/\/process-runs\//);
    await page.getByRole("button", { name: "Cancel process" }).click();
    await page.getByLabel("Reason (required)").fill("Cleaning up My Work.");
    await page.getByRole("button", { name: "Confirm cancellation" }).click();
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();

    await page.goto("/my-work");
    await expect(page.getByText(template.name)).toHaveCount(0);
  });
});
