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
const workspaceIds: string[] = [];
const userIds: string[] = [];

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }

  const admin = createSupabaseTestClient();
  if (workspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", workspaceIds);
    if (error) throw new Error(error.message);
  }
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function createSingleStepTemplate(run: TestRun, entity: TestEntity) {
  const supabase = createSupabaseTestClient();
  const templateId = randomUUID();
  const { error: templateError } = await supabase.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Recurring Report`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: nodeError } = await supabase.from("process_nodes").insert({
    id: randomUUID(),
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    node_type: "human_task",
    name: "Only step",
    position: 1,
    config: {},
  });
  if (nodeError) throw new Error(nodeError.message);

  return templateId;
}

test("a builder can create, edit, and disable a recurring schedule from record detail", async ({
  page,
}) => {
  const run = scenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Recurrence Account", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Meridian Health Partners` },
  });
  await createSingleStepTemplate(run, entity);

  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await page.waitForLoadState("networkidle");

  await page.getByText("Set up a recurring schedule").click();
  await page.locator('select[name="frequency"]').selectOption("monthly");
  await page.locator('input[name="intervalCount"]').fill("1");
  await page.locator('input[name="dayOfMonth"]').fill("15");
  await page.locator('input[name="startDate"]').fill("2026-01-01");
  await page.locator('input[name="timeOfDay"]').fill("09:00");
  await page.getByRole("button", { name: "Save schedule" }).click();

  await expect(page.getByText(/Repeats monthly on day 15 at 09:00/)).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.locator('input[name="dayOfMonth"]').fill("20");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Repeats monthly on day 20 at 09:00/)).toBeVisible();

  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByText(/Repeats monthly on day 20 at 09:00.*Disabled/)).toBeVisible();

  await page.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByText(/Repeats monthly on day 20 at 09:00/)).toBeVisible();
  await expect(page.getByText("Disabled")).toHaveCount(0);
});

test("a worker without automation.manage sees no recurrence configuration UI", async ({ browser }) => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();

  const workspaceId = randomUUID();
  workspaceIds.push(workspaceId);
  const { error: workspaceError } = await admin
    .from("workspaces")
    .insert({ id: workspaceId, name: `Recurrence Worker ${workspaceId.slice(0, 8)}` });
  expect(workspaceError).toBeNull();

  const entityId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityId,
    workspace_id: workspaceId,
    name: "Recurrence Worker Client",
    slug: `recurrence-worker-client-${workspaceId.slice(0, 8)}`,
  });
  expect(entityError).toBeNull();
  const fieldKey = `fld_recurrence_worker_${workspaceId.slice(0, 8)}`;
  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: randomUUID(),
    workspace_id: workspaceId,
    entity_type_id: entityId,
    key: fieldKey,
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
  });
  expect(fieldError).toBeNull();
  const recordId = randomUUID();
  const { error: recordError } = await admin.from("entity_records").insert({
    id: recordId,
    workspace_id: workspaceId,
    entity_type_id: entityId,
    values: { [fieldKey]: `${run.label} Client` },
  });
  expect(recordError).toBeNull();
  const templateId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: workspaceId,
    name: `${run.label} Worker Template`,
    applies_to_entity_type_id: entityId,
  });
  expect(templateError).toBeNull();
  const { error: nodeError } = await admin.from("process_nodes").insert({
    id: randomUUID(),
    workspace_id: workspaceId,
    process_template_id: templateId,
    node_type: "human_task",
    name: "Only step",
    position: 1,
    config: {},
  });
  expect(nodeError).toBeNull();

  const roleId = randomUUID();
  const { error: roleError } = await admin
    .from("workspace_roles")
    .insert({ id: roleId, workspace_id: workspaceId, name: "E2E recurrence worker" });
  expect(roleError).toBeNull();
  const { error: capabilityError } = await admin.from("workspace_role_capabilities").insert([
    { workspace_id: workspaceId, role_id: roleId, capability: "records.operate" },
    { workspace_id: workspaceId, role_id: roleId, capability: "processes.operate" },
  ]);
  expect(capabilityError).toBeNull();

  const password = `E2E-recurrence-worker-${randomUUID()}!`;
  const email = `e2e-recurrence-worker-${randomUUID()}@example.test`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError || !userData.user) throw new Error(userError?.message ?? "Unable to create worker user.");
  userIds.push(userData.user.id);
  const { error: membershipError } = await admin
    .from("workspace_memberships")
    .insert({ workspace_id: workspaceId, user_id: userData.user.id, role_id: roleId });
  expect(membershipError).toBeNull();

  // The project's default storageState is already authenticated as the E2E
  // runner -- a plain newContext() would inherit that, so /sign-in would
  // redirect an already-signed-in session away instead of rendering the
  // form. An explicit blank storageState is required for a genuinely
  // unauthenticated context.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");

  await page.goto(`/entities/${entityId}/records/${recordId}`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Set up a recurring schedule")).toHaveCount(0);
  await expect(page.getByText("Not started")).toBeVisible();

  await context.close();
});

test("a scheduler-started recurring ProcessRun appears normally on record detail", async ({ page }) => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();
  const entity = await createEntity(admin, run, "Recurrence Result Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const recordId = await createEntityRecord({
    entity,
    valuesBySlug: { name: `${run.label} Client` },
  });
  const templateId = await createSingleStepTemplate(run, entity);

  const ruleId = randomUUID();
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const { error: ruleError } = await admin.from("process_recurrence_rules").insert({
    id: ruleId,
    workspace_id: DEMO_WORKSPACE_ID,
    process_template_id: templateId,
    origin_entity_type_id: entity.id,
    origin_record_id: recordId,
    frequency: "daily",
    interval_count: 1,
    start_date: yesterday.toISOString().slice(0, 10),
    time_of_day: "00:00",
    active: true,
  });
  expect(ruleError).toBeNull();

  // Simulates a scheduler invocation -- this project has no committed cron
  // frequency, so E2E drives the same RPC a deployed scheduler would call,
  // rather than waiting on real wall-clock time.
  const { error: schedulerError } = await admin.rpc(
    "discover_and_start_recurrence_occurrences_system",
    { p_limit: 500 },
  );
  expect(schedulerError).toBeNull();

  await page.goto(`/entities/${entity.id}/records/${recordId}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/^Active/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open process" })).toBeVisible();
});
