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
  deleteE2eUsers,
  getE2eWorkspaceAdministratorRoleId,
  type TestEntity,
  type TestRun,
} from "./helpers/supabase-test-data";

// Phase 11.2 Reassign Active Human Work: focused E2E coverage over the real
// UI -- control visibility (current-assignee-only), member-picker exclusion
// (self, deactivated), the resulting displayed owner, My Work moving from
// old to new assignee, and Activity rendering the handoff. RPC-level
// coverage (every rejection path, generation increments, notification dedup
// across episodes, serialization, impersonation) lives in
// lib/domain/process-step-run-reassignment-commit.test.ts; this spec only
// proves the UI wires up to that RPC correctly.

test.describe.configure({ mode: "serial" });

const E2E_RUNNER_EMAIL = "e2e-runner@ops-project.test";
const runs: TestRun[] = [];
const secondMemberUserIds: string[] = [];
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

async function createSecondMember(label: string, { deactivated = false } = {}) {
  const admin = createSupabaseTestClient();
  const email = `e2e-reassign-${label}-${randomUUID()}@ops-project.test`;
  const password = "E2E-reassign-second-password-2026";

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`Unable to create second test user: ${error?.message}`);
  secondMemberUserIds.push(data.user.id);

  const roleId = await getE2eWorkspaceAdministratorRoleId(admin, DEMO_WORKSPACE_ID);
  const { error: membershipError } = await admin.from("workspace_memberships").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    user_id: data.user.id,
    role_id: roleId,
    deactivated_at: deactivated ? new Date().toISOString() : null,
  });
  if (membershipError) throw new Error(`Unable to add second member: ${membershipError.message}`);

  return { userId: data.user.id, email, password };
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
  if (secondMemberUserIds.length > 0) {
    try {
      await deleteE2eUsers(secondMemberUserIds, createSupabaseTestClient());
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(`process-step-run-reassignment afterAll cleanup failed:\n${failures.join("\n")}`);
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

async function startProcess(page: Page, entity: TestEntity, recordId: string, templateName: string) {
  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await processCard(page, templateName).getByRole("button", { name: "Start process" }).click();
  await page.waitForURL(/\/process-runs\//);
}

test.describe("process step run reassignment", () => {
  test("Reassign is visible only to the current assignee, the picker excludes self and deactivated members, and a successful reassignment updates the displayed owner", async ({
    page,
  }) => {
    const runnerId = await getE2eRunnerUserId();
    const target = await createSecondMember("target");
    const deactivatedTarget = await createSecondMember("deactivated", { deactivated: true });
    const { entity, template } = await createScenario(["Handoff Task"], "Reassign Visibility Playbook", [runnerId]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Reassign Visibility Record" } });

    await startProcess(page, entity, recordId, template.name);

    const reassignButton = stepRow(page, "Handoff Task").getByRole("button", { name: "Reassign" });
    await expect(reassignButton).toBeVisible();
    await reassignButton.click();

    const picker = stepRow(page, "Handoff Task").getByLabel("Reassign to");
    const optionLabels = await picker.locator("option").allTextContents();
    expect(optionLabels).toContain(target.email);
    expect(optionLabels).not.toContain(E2E_RUNNER_EMAIL);
    expect(optionLabels).not.toContain(deactivatedTarget.email);

    await picker.selectOption({ label: target.email });
    await stepRow(page, "Handoff Task").getByRole("button", { name: "Confirm reassignment" }).click();

    await expect(stepRow(page, "Handoff Task")).toContainText(`Assigned to ${target.email}`);
    // No longer the assignee -- Reassign (and Complete) disappear for the
    // current viewer, proving visibility is genuinely assignee-scoped, not
    // just a static "processes.operate holder" control.
    await expect(stepRow(page, "Handoff Task").getByRole("button", { name: "Reassign" })).toHaveCount(0);
    await expect(stepRow(page, "Handoff Task").getByRole("button", { name: "Complete" })).toHaveCount(0);
  });

  test("old assignee loses the item from My Work and the new assignee gains it", async ({ page, browser }) => {
    // A genuinely long sequential flow (record + run setup, a UI
    // reassignment across two page loads, a My Work check, then a second
    // real browser context signing in and navigating) -- some headroom over
    // the 30s default under this project's established single-worker
    // serial timing.
    test.setTimeout(45_000);
    const runnerId = await getE2eRunnerUserId();
    const target = await createSecondMember("mywork-target");
    const { entity, template } = await createScenario(["My Work Handoff"], "Reassign My Work Playbook", [runnerId]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Reassign My Work Record" } });

    await startProcess(page, entity, recordId, template.name);
    await page.goto("/my-work");
    await expect(page.getByText(template.name)).toBeVisible();

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await page.getByRole("link", { name: "Open process" }).click();
    await page.waitForURL(/\/process-runs\//);
    await stepRow(page, "My Work Handoff").getByRole("button", { name: "Reassign" }).click();
    await stepRow(page, "My Work Handoff").getByLabel("Reassign to").selectOption({ label: target.email });
    await stepRow(page, "My Work Handoff").getByRole("button", { name: "Confirm reassignment" }).click();
    await expect(stepRow(page, "My Work Handoff")).toContainText(`Assigned to ${target.email}`);

    await page.goto("/my-work");
    await expect(page.getByText(template.name)).toHaveCount(0);

    // browser.newContext() inherits this project's `use` config as its
    // defaults -- including storageState, which points at the already-
    // authenticated E2E runner session. Both must be overridden explicitly
    // for a genuine, anonymous second-user sign-in: storageState to a truly
    // empty session (otherwise goto("/sign-in") just redirects straight
    // back to "/", already signed in as the runner), and baseURL (not
    // inherited either) so a relative goto() resolves at all.
    const targetContext = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      storageState: { cookies: [], origins: [] },
    });
    const targetPage = await targetContext.newPage();
    try {
      await targetPage.goto("/sign-in");
      await targetPage.getByLabel("Email").fill(target.email);
      await targetPage.getByLabel("Password").fill(target.password);
      await targetPage.getByRole("button", { name: "Sign in" }).click();
      await targetPage.waitForURL("/");
      await targetPage.goto("/my-work");
      await expect(targetPage.getByText(template.name)).toBeVisible();
    } finally {
      await targetContext.close();
    }
  });

  test("Activity renders the reassignment handoff from the old to the new assignee", async ({ page }) => {
    const runnerId = await getE2eRunnerUserId();
    const target = await createSecondMember("activity-target");
    const { entity, template } = await createScenario(["Activity Handoff"], "Reassign Activity Playbook", [runnerId]);
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Reassign Activity Record" } });

    await startProcess(page, entity, recordId, template.name);
    await stepRow(page, "Activity Handoff").getByRole("button", { name: "Reassign" }).click();
    await stepRow(page, "Activity Handoff").getByLabel("Reassign to").selectOption({ label: target.email });
    await stepRow(page, "Activity Handoff").getByRole("button", { name: "Confirm reassignment" }).click();
    await expect(stepRow(page, "Activity Handoff")).toContainText(`Assigned to ${target.email}`);

    await page.goto(`/entities/${entity.id}/records/${recordId}`);
    await expect(
      page.getByText(new RegExp(`Activity Handoff reassigned from ${E2E_RUNNER_EMAIL} to ${target.email}`)),
    ).toBeVisible();
  });
});
