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
  getE2eWorkspaceAdministratorRoleId,
  type TestEntity,
  type TestRun,
} from "./helpers/supabase-test-data";

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const userIds: string[] = [];

test.beforeAll(async () => {
  await cleanupStaleE2eData();
});

test.afterAll(async () => {
  for (const run of runs) {
    await cleanupE2eRun(run);
  }
  const admin = createSupabaseTestClient();
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

function scenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function createMemberWithPassword(label: string) {
  const admin = createSupabaseTestClient();
  const password = `E2E-notif-${randomUUID()}!`;
  const email = `e2e-notif-${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create member.");
  userIds.push(data.user.id);
  const roleId = await getE2eWorkspaceAdministratorRoleId(admin, DEMO_WORKSPACE_ID);
  const { error: membershipError } = await admin
    .from("workspace_memberships")
    .insert({ workspace_id: DEMO_WORKSPACE_ID, user_id: data.user.id, role_id: roleId });
  if (membershipError) throw new Error(membershipError.message);
  return { userId: data.user.id, email, password };
}

async function createAssignedStepFixture(run: TestRun, entity: TestEntity, assigneeUserId: string) {
  const admin = createSupabaseTestClient();
  const recordId = await createEntityRecord({ entity, valuesBySlug: { name: `${run.label} Acme` } });
  const templateId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: DEMO_WORKSPACE_ID,
    name: `${run.label} Notification Template`,
    applies_to_entity_type_id: entity.id,
  });
  if (templateError) throw new Error(templateError.message);
  const { error: nodeError } = await admin.from("process_nodes").insert({
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

  const { data: runId, error: startError } = await admin.rpc("start_process_run_authorized", {
    p_workspace_id: DEMO_WORKSPACE_ID,
    p_process_template_id: templateId,
    p_origin_entity_type_id: entity.id,
    p_origin_record_id: recordId,
  });
  if (startError) throw new Error(startError.message);
  return String(runId);
}

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

test("a worker sees the header badge and notifications page for an assignment, and click-through/mark-read work", async ({
  browser,
}) => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();
  const worker = await createMemberWithPassword("badge");
  const entity = await createEntity(admin, run, "Notif E2E Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const runId = await createAssignedStepFixture(run, entity, worker.userId);

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signIn(page, worker.email, worker.password);

  await expect(page.getByRole("link", { name: /Notifications, 1 unread/ })).toBeVisible();

  await page.goto("/notifications");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("1 unread")).toBeVisible();
  await expect(page.getByRole("link", { name: /Review summary is ready for you/ })).toBeVisible();
  await expect(page.getByText("Notification Template")).toBeVisible();

  await page.getByRole("link", { name: /Review summary is ready for you/ }).click();
  await page.waitForURL(`**/process-runs/${runId}`);
  await expect(page.getByText("Review summary")).toBeVisible();

  await page.goto("/notifications");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Mark read" }).click();
  await expect(page.getByText("All caught up")).toBeVisible();

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: "Notifications" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Notifications, \d+ unread/ })).toHaveCount(0);

  await context.close();
});

test("mark all read only affects the current user, and a worker cannot see another member's notifications", async ({
  browser,
}) => {
  const run = scenarioRun();
  const admin = createSupabaseTestClient();
  const workerA = await createMemberWithPassword("iso-a");
  const workerB = await createMemberWithPassword("iso-b");
  const entity = await createEntity(admin, run, "Notif Isolation E2E Client", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  await createAssignedStepFixture(run, entity, workerA.userId);
  await createAssignedStepFixture(run, entity, workerB.userId);

  const contextA = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const pageA = await contextA.newPage();
  await signIn(pageA, workerA.email, workerA.password);
  await pageA.goto("/notifications");
  await pageA.waitForLoadState("networkidle");
  await expect(pageA.getByText("1 unread")).toBeVisible();
  await pageA.getByRole("button", { name: "Mark all read" }).click();
  await expect(pageA.getByText("All caught up")).toBeVisible();
  await contextA.close();

  const contextB = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const pageB = await contextB.newPage();
  await signIn(pageB, workerB.email, workerB.password);
  await pageB.goto("/notifications");
  await pageB.waitForLoadState("networkidle");
  // Worker B's own notification is untouched by worker A's mark-all-read,
  // and worker B never sees worker A's notification at all.
  await expect(pageB.getByText("1 unread")).toBeVisible();
  const notificationLinks = pageB.getByRole("link", { name: /Review summary is ready for you/ });
  await expect(notificationLinks).toHaveCount(1);
  await contextB.close();
});
