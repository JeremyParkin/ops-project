import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createSupabaseTestClient, deleteE2eUsers } from "./helpers/supabase-test-data";

test.describe.configure({ mode: "serial" });
test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };

type Fixture = {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  archivedRecordId: string;
  activeRunId: string;
  completedRunId: string;
  archivedOriginRunId: string;
  humanStepId: string;
  approvalStepId: string;
  waitStepId: string;
  completedStepId: string;
  completedRunStepId: string;
  archivedOriginStepId: string;
  worker: User;
  secondWorker: User;
  administrator: User;
  readOnly: User;
};

let fixture: Fixture;
const createdUserIds: string[] = [];

function uniqueEmail(label: string) {
  return `e2e-step-discussion-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `StepDiscussion-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: uniqueEmail(label),
    password,
    email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create E2E user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email: data.user.email, password };
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({
    id: roleId,
    workspace_id: workspaceId,
    name,
  });
  if (roleError) throw new Error(roleError.message);

  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }

  return roleId;
}

async function signIn(page: Page, user: User) {
  await page.context().clearCookies();
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

async function createProcessRunFixture({
  workspaceId,
  entityTypeId,
  recordId,
  completed = false,
  suffix,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  completed?: boolean;
  suffix: string;
}) {
  const admin = createSupabaseTestClient();
  const templateId = randomUUID();
  const runId = randomUUID();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: workspaceId,
    name: `E2E Step Discussion ${suffix}`,
    applies_to_entity_type_id: entityTypeId,
  });
  if (templateError) throw new Error(templateError.message);

  const { error: runError } = await admin.from("process_runs").insert({
    id: runId,
    workspace_id: workspaceId,
    process_template_id: templateId,
    process_template_name: `E2E Step Discussion ${suffix}`,
    origin_entity_type_id: entityTypeId,
    origin_record_id: recordId,
    status: completed ? "completed" : "active",
    completed_at: completed ? new Date().toISOString() : null,
  });
  if (runError) throw new Error(runError.message);

  return runId;
}

async function createStep({
  workspaceId,
  processRunId,
  stepIndex,
  nodeType,
  status,
  name,
}: {
  workspaceId: string;
  processRunId: string;
  stepIndex: number;
  nodeType: "human_task" | "approval" | "wait";
  status: "active" | "completed";
  name: string;
}) {
  const admin = createSupabaseTestClient();
  const stepId = randomUUID();
  const { error } = await admin.from("process_step_runs").insert({
    id: stepId,
    workspace_id: workspaceId,
    process_run_id: processRunId,
    step_index: stepIndex,
    node_type: nodeType,
    name,
    config: nodeType === "wait" ? { wait_rule: { kind: "duration", amount: 1, unit: "hours" } } : {},
    status,
    started_at: new Date().toISOString(),
    completed_at: status === "completed" ? new Date().toISOString() : null,
    resume_at: nodeType === "wait" ? new Date(Date.now() + 60_000).toISOString() : null,
  });
  if (error) throw new Error(error.message);
  return stepId;
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const entityTypeId = randomUUID();
  const recordId = randomUUID();
  const archivedRecordId = randomUUID();
  const fieldId = randomUUID();
  const worker = await createUser("worker");
  const secondWorker = await createUser("second-worker");
  const administrator = await createUser("administrator");
  const readOnly = await createUser("read-only");

  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: `E2E Step Discussion ${workspaceId.slice(0, 8)}`,
  });
  if (workspaceError) throw new Error(workspaceError.message);

  const workerRoleId = await createRole(workspaceId, "Process worker", ["processes.operate"]);
  const adminRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members",
    "workspace.manage_roles",
    "processes.operate",
  ]);
  const readOnlyRoleId = await createRole(workspaceId, "Read only", []);

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: worker.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: secondWorker.id, role_id: workerRoleId },
    { workspace_id: workspaceId, user_id: administrator.id, role_id: adminRoleId },
    { workspace_id: workspaceId, user_id: readOnly.id, role_id: readOnlyRoleId },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityTypeId,
    workspace_id: workspaceId,
    name: "E2E Step Discussion Client",
    slug: `e2e-step-discussion-client-${workspaceId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);

  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: fieldId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    key: "name",
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);

  const { error: recordError } = await admin.from("entity_records").insert([
    {
      id: recordId,
      workspace_id: workspaceId,
      entity_type_id: entityTypeId,
      values: { name: "Active origin" },
    },
    {
      id: archivedRecordId,
      workspace_id: workspaceId,
      entity_type_id: entityTypeId,
      values: { name: "Archived origin" },
      archived_at: new Date().toISOString(),
    },
  ]);
  if (recordError) throw new Error(recordError.message);

  const activeRunId = await createProcessRunFixture({ workspaceId, entityTypeId, recordId, suffix: "Active" });
  const completedRunId = await createProcessRunFixture({ workspaceId, entityTypeId, recordId, completed: true, suffix: "Completed" });
  const archivedOriginRunId = await createProcessRunFixture({ workspaceId, entityTypeId, recordId: archivedRecordId, suffix: "Archived Origin" });

  const humanStepId = await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 1, nodeType: "human_task", status: "active", name: "Human review" });
  const approvalStepId = await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 2, nodeType: "approval", status: "active", name: "Manager approval" });
  const waitStepId = await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 3, nodeType: "wait", status: "active", name: "Timer wait" });
  const completedStepId = await createStep({ workspaceId, processRunId: activeRunId, stepIndex: 4, nodeType: "human_task", status: "completed", name: "Completed handoff" });
  const completedRunStepId = await createStep({ workspaceId, processRunId: completedRunId, stepIndex: 1, nodeType: "human_task", status: "completed", name: "Completed run step" });
  const archivedOriginStepId = await createStep({ workspaceId, processRunId: archivedOriginRunId, stepIndex: 1, nodeType: "human_task", status: "active", name: "Archived origin step" });

  const archivedCommentId = randomUUID();
  const { error: archivedCommentError } = await admin.from("process_step_run_comments").insert({
    id: archivedCommentId,
    workspace_id: workspaceId,
    process_run_id: archivedOriginRunId,
    process_step_run_id: archivedOriginStepId,
    body: "Existing archived-origin context",
    author_user_id: worker.id,
    author_label: worker.email,
  });
  if (archivedCommentError) throw new Error(archivedCommentError.message);
  const { error: archiveError } = await admin
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", archivedRecordId);
  if (archiveError) throw new Error(archiveError.message);
  if (!archivedCommentId) throw new Error("Archived-origin comment setup failed.");

  return {
    workspaceId,
    entityTypeId,
    recordId,
    archivedRecordId,
    activeRunId,
    completedRunId,
    archivedOriginRunId,
    humanStepId,
    approvalStepId,
    waitStepId,
    completedStepId,
    completedRunStepId,
    archivedOriginStepId,
    worker,
    secondWorker,
    administrator,
    readOnly,
  };
}

function stepItem(page: Page, stepId: string) {
  return page.getByTestId(`process-step-run-${stepId}`);
}

function stepDiscussion(page: Page, stepId: string) {
  return stepItem(page, stepId).locator("section").filter({
    has: page.getByRole("heading", { name: "Step discussion", exact: true }),
  });
}

test.beforeAll(async () => {
  fixture = await createFixture();
});

test.afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];
  if (fixture?.workspaceId) {
    for (const table of [
      "notifications",
      "process_step_run_input_requests",
      "process_step_run_comments",
      "process_runs",
      "process_templates",
      "field_definitions",
      "entity_records",
      "entity_types",
      "workspaces",
    ]) {
      const { error } = await admin.from(table).delete().eq(table === "workspaces" ? "id" : "workspace_id", fixture.workspaceId);
      if (error) failures.push(`${table}: ${error.message}`);
    }
  }
  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (failures.length > 0) {
    throw new Error(`process-step-discussion cleanup failed:\n${failures.join("\n")}`);
  }
});

test("Process Run detail renders step discussion only for human-operable steps", async ({ page }) => {
  await signIn(page, fixture.worker);
  await page.goto(`/process-runs/${fixture.activeRunId}`);

  await expect(stepDiscussion(page, fixture.humanStepId)).toBeVisible();
  await expect(stepDiscussion(page, fixture.approvalStepId)).toBeVisible();
  await expect(stepDiscussion(page, fixture.completedStepId)).toBeVisible();
  await expect(stepItem(page, fixture.waitStepId).getByRole("heading", { name: "Step discussion" })).toHaveCount(0);
  await expect(stepItem(page, fixture.humanStepId).getByRole("button", { name: "Complete" })).toBeVisible();
  await expect(stepDiscussion(page, fixture.humanStepId).getByText("No comments yet.")).toBeVisible();
});

test("Step discussion supports comments, validation, ordering, tombstones, and completed-run commenting", async ({ page }) => {
  await signIn(page, fixture.worker);
  await page.goto(`/process-runs/${fixture.activeRunId}`);

  const humanDiscussion = stepDiscussion(page, fixture.humanStepId);
  await humanDiscussion.getByLabel("Add a comment").fill("   ");
  await humanDiscussion.getByRole("button", { name: "Add comment" }).click();
  await expect(humanDiscussion.getByRole("alert")).toContainText("Comment body is required.");

  await humanDiscussion.getByLabel("Add a comment").fill("Second visible comment");
  await humanDiscussion.getByRole("button", { name: "Add comment" }).click();
  await expect(humanDiscussion.getByText("Second visible comment")).toBeVisible();

  await humanDiscussion.getByLabel("Add a comment").fill("First visible comment");
  await expect(humanDiscussion.getByLabel("Add a comment")).toHaveValue("First visible comment");
  await humanDiscussion.getByRole("button", { name: "Add comment" }).click();
  await expect(humanDiscussion.getByText("First visible comment")).toBeVisible();
  await expect(humanDiscussion.locator("li").filter({ hasText: "Second visible comment" })).toBeVisible();

  await humanDiscussion.locator("li").filter({ hasText: "First visible comment" }).getByRole("button", { name: "Remove" }).click();
  await expect(humanDiscussion.getByText("Comment removed")).toBeVisible();
  await expect(humanDiscussion.getByText("First visible comment")).toHaveCount(0);

  await page.goto(`/process-runs/${fixture.completedRunId}`);
  const completedRunDiscussion = stepDiscussion(page, fixture.completedRunStepId);
  await expect(completedRunDiscussion).toBeVisible();
  await completedRunDiscussion.getByLabel("Add a comment").fill("Post-completion clarification");
  await completedRunDiscussion.getByRole("button", { name: "Add comment" }).click();
  await expect(completedRunDiscussion.getByText("Post-completion clarification")).toBeVisible();
});

test("Archived origins are read-only and process capability gates creation", async ({ page }) => {
  await signIn(page, fixture.worker);
  await page.goto(`/process-runs/${fixture.archivedOriginRunId}`);

  const archivedDiscussion = stepDiscussion(page, fixture.archivedOriginStepId);
  await expect(archivedDiscussion.getByText("Existing archived-origin context")).toBeVisible();
  await expect(archivedDiscussion.getByText("Archived origin records are read-only. Existing discussion remains available.")).toBeVisible();
  await expect(archivedDiscussion.getByLabel("Add a comment")).toHaveCount(0);

  await signIn(page, fixture.readOnly);
  await page.goto(`/process-runs/${fixture.activeRunId}`);
  const readOnlyDiscussion = stepDiscussion(page, fixture.approvalStepId);
  await readOnlyDiscussion.getByLabel("Add a comment").fill("Read only should fail");
  await readOnlyDiscussion.getByRole("button", { name: "Add comment" }).click();
  await expect(readOnlyDiscussion.getByRole("alert")).toContainText("processes.operate");
});

test("Mentions create recipient notifications with exact step-comment deep links and mark-read behavior", async ({ browser }) => {
  const workerContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const workerPage = await workerContext.newPage();
  await signIn(workerPage, fixture.worker);
  await workerPage.goto(`/process-runs/${fixture.activeRunId}`);

  const approvalDiscussion = stepDiscussion(workerPage, fixture.approvalStepId);
  await approvalDiscussion.getByLabel("Add a comment").fill(`Please review @${fixture.secondWorker.email.slice(0, 8)}`);
  await approvalDiscussion.getByRole("option", { name: `@${fixture.secondWorker.email}` }).click();
  await approvalDiscussion.getByRole("button", { name: "Add comment" }).click();
  await expect(approvalDiscussion.getByText(`Please review @${fixture.secondWorker.email}`)).toBeVisible();

  const admin = createSupabaseTestClient();
  const { data: commentRows, error: commentError } = await admin
    .from("process_step_run_comments")
    .select("id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("process_step_run_id", fixture.approvalStepId)
    .eq("body", `Please review @${fixture.secondWorker.email}`)
    .single<{ id: string }>();
  expect(commentError).toBeNull();
  const commentId = commentRows!.id;

  const { data: notifications, error: notificationError } = await admin
    .from("notifications")
    .select("id, recipient_user_id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("process_step_run_comment_id", commentId);
  expect(notificationError).toBeNull();
  expect(notifications).toEqual([{ id: notifications![0].id, recipient_user_id: fixture.secondWorker.id }]);

  const recipientContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const recipientPage = await recipientContext.newPage();
  await signIn(recipientPage, fixture.secondWorker);
  await recipientPage.goto("/notifications");
  await expect(recipientPage.getByText("1 unread")).toBeVisible();
  await recipientPage.getByRole("link", { name: /mentioned you in a process step/ }).click();
  await expect(recipientPage).toHaveURL(new RegExp(`/process-runs/${fixture.activeRunId}#step-comment-${commentId}$`));
  await expect(recipientPage.locator(`#step-comment-${commentId}`)).toContainText(`Please review @${fixture.secondWorker.email}`);

  await recipientPage.goto("/notifications");
  await recipientPage.getByRole("button", { name: "Mark read" }).click();
  await expect(recipientPage.getByText("All caught up")).toBeVisible();

  await workerContext.close();
  await recipientContext.close();
});

test("Workspace administrators can tombstone another member's step comment", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const commentId = randomUUID();
  const { error } = await admin.from("process_step_run_comments").insert({
    id: commentId,
    workspace_id: fixture.workspaceId,
    process_run_id: fixture.completedRunId,
    process_step_run_id: fixture.completedRunStepId,
    body: "Administrator removal target",
    author_user_id: fixture.worker.id,
    author_label: fixture.worker.email,
  });
  expect(error).toBeNull();

  await signIn(page, fixture.administrator);
  await page.goto(`/process-runs/${fixture.completedRunId}`);
  const completedRunDiscussion = stepDiscussion(page, fixture.completedRunStepId);
  await completedRunDiscussion.locator("li").filter({ hasText: "Administrator removal target" }).getByRole("button", { name: "Remove" }).click();
  await expect(completedRunDiscussion.locator(`#step-comment-${commentId}`)).toContainText("Comment removed");
  await expect(completedRunDiscussion.getByText("Administrator removal target")).toHaveCount(0);
});

test("Request input on a step: recipient picker is eligibility-scoped, request text renders once and is visually distinct from an ordinary mention, and the actual task control stays primary", async ({
  page,
}) => {
  await signIn(page, fixture.worker);
  await page.goto(`/process-runs/${fixture.activeRunId}`);

  const humanDiscussion = stepDiscussion(page, fixture.humanStepId);
  // Post an ordinary @mention first, so the request treatment below can be
  // asserted as visually/structurally distinct from it, not just present.
  await humanDiscussion.getByLabel("Add a comment").fill(`FYI @${fixture.secondWorker.email.slice(0, 8)}`);
  await humanDiscussion.getByRole("option", { name: `@${fixture.secondWorker.email}` }).click();
  await humanDiscussion.getByRole("button", { name: "Add comment" }).click();
  await expect(humanDiscussion.getByText(`FYI @${fixture.secondWorker.email}`)).toBeVisible();
  await expect(humanDiscussion.getByText("Input requested from")).toHaveCount(0);

  await expect(humanDiscussion.getByText("Request input")).toBeVisible();
  await humanDiscussion.getByText("Request input").click();
  const recipientSelect = humanDiscussion.getByLabel("Recipient");
  await expect(recipientSelect.locator("option", { hasText: fixture.secondWorker.email })).toHaveCount(1);
  await expect(recipientSelect.locator("option", { hasText: fixture.administrator.email })).toHaveCount(1);
  // readOnly lacks processes.operate -- cannot receive a step input request
  // even though they can already read this same Step Discussion.
  await expect(recipientSelect.locator("option", { hasText: fixture.readOnly.email })).toHaveCount(0);
  // Requester cannot target themselves.
  await expect(recipientSelect.locator("option", { hasText: fixture.worker.email })).toHaveCount(0);

  const requestBody = `Need explicit input on this step ${randomUUID()}`;
  await recipientSelect.selectOption(fixture.secondWorker.id);
  await humanDiscussion.getByLabel("Request body").fill(requestBody);
  await humanDiscussion.getByRole("button", { name: "Send request" }).click();
  await expect(humanDiscussion.getByText("Input requested.")).toBeVisible();
  // Request text appears exactly once -- not duplicated between the comment
  // body and any separate request-summary copy.
  await expect(humanDiscussion.getByText(requestBody)).toHaveCount(1);
  const requestItem = humanDiscussion.locator("li").filter({ hasText: requestBody });
  await expect(requestItem.getByText(`Input requested from ${fixture.secondWorker.email}`)).toBeVisible();
  await expect(requestItem.getByText("Open")).toBeVisible();
  await expect(requestItem.getByRole("button", { name: "Cancel request" })).toBeVisible();

  // The step's own primary work control (Complete) stays visually/DOM
  // primary -- request treatment lives inside Step discussion, never
  // replacing or crowding the actual task control above it.
  await expect(stepItem(page, fixture.humanStepId).getByRole("button", { name: "Complete" })).toBeVisible();

  const requestTreatmentId = await requestItem.locator("[id^='step-input-request-']").getAttribute("id");
  expect(requestTreatmentId).toBeTruthy();
  const requestId = requestTreatmentId!.replace("step-input-request-", "");
  expect(requestId).not.toBe(requestTreatmentId);
});

test("Request input: create/respond/cancel lifecycle, deep link, notifications, and ordinary comments never satisfy a request", async ({
  browser,
}) => {
  const requesterContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const requesterPage = await requesterContext.newPage();
  await signIn(requesterPage, fixture.worker);
  await requesterPage.goto(`/process-runs/${fixture.activeRunId}`);

  const requesterDiscussion = stepDiscussion(requesterPage, fixture.approvalStepId);
  const requestBody = `Confirm the outcome before I approve ${randomUUID()}`;
  await requesterDiscussion.getByText("Request input").click();
  await requesterDiscussion.getByLabel("Recipient").selectOption(fixture.secondWorker.id);
  await requesterDiscussion.getByLabel("Request body").fill(requestBody);
  await requesterDiscussion.getByRole("button", { name: "Send request" }).click();
  const requestItem = requesterDiscussion.locator("li").filter({ hasText: requestBody });
  const requestTreatmentId = await requestItem.locator("[id^='step-input-request-']").getAttribute("id");
  expect(requestTreatmentId).toBeTruthy();
  const requestId = requestTreatmentId!.replace("step-input-request-", "");

  const recipientContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const recipientPage = await recipientContext.newPage();
  await signIn(recipientPage, fixture.secondWorker);
  await recipientPage.goto("/notifications");
  await expect(recipientPage.getByText(/\d+ unread/)).toBeVisible();
  // Notification titles are intentionally generic (never leak step/request
  // detail), so a recipient with more than one open request -- as here,
  // since an earlier test in this serial file also requested input from
  // this same recipient -- can have several identically-worded links.
  // Match by href (carries the specific request id) rather than link text.
  await recipientPage.locator(`a[href*="step-input-request-${requestId}"]`).click();
  await recipientPage.waitForURL(`**/process-runs/${fixture.activeRunId}#step-input-request-${requestId}`);
  const recipientDiscussion = stepDiscussion(recipientPage, fixture.approvalStepId);
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`)).toBeVisible();
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Respond" })).toBeVisible();

  // An ordinary comment from the recipient must not satisfy the request.
  await recipientDiscussion.getByLabel("Add a comment").fill("Ordinary comment should not close request");
  await recipientDiscussion.getByRole("button", { name: "Add comment" }).click();
  await expect(recipientDiscussion.getByText("Ordinary comment should not close request")).toBeVisible();
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`).getByText("Open")).toBeVisible();

  await recipientDiscussion.locator(`#step-input-request-${requestId}`).getByLabel("Response").fill("Approved, go ahead.");
  await recipientDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Respond" }).click();
  await expect(recipientDiscussion.getByText("Approved, go ahead.")).toBeVisible();
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`).getByText("Responded")).toBeVisible();
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Respond" })).toHaveCount(0);
  await expect(recipientDiscussion.getByText("Response to input request")).toBeVisible();

  await requesterPage.goto("/notifications");
  await expect(
    requesterPage.getByRole("link", { name: new RegExp(`${fixture.secondWorker.email} responded to your request`) }),
  ).toBeVisible();

  await requesterContext.close();
  await recipientContext.close();
});

test("Request input cancellation: recipient cannot cancel, read-only sees no controls, administrator can cancel and preserve history", async ({
  page,
}) => {
  await signIn(page, fixture.worker);
  await page.goto(`/process-runs/${fixture.activeRunId}`);
  const requesterDiscussion = stepDiscussion(page, fixture.humanStepId);
  await requesterDiscussion.getByText("Request input").click();
  await requesterDiscussion.getByLabel("Recipient").selectOption(fixture.secondWorker.id);
  await requesterDiscussion.getByLabel("Request body").fill("Open step request for cancellation UI");
  await requesterDiscussion.getByRole("button", { name: "Send request" }).click();
  const requestItem = requesterDiscussion.locator("li").filter({ hasText: "Open step request for cancellation UI" });
  const requestTreatmentId = await requestItem.locator("[id^='step-input-request-']").getAttribute("id");
  expect(requestTreatmentId).toBeTruthy();
  const requestId = requestTreatmentId!.replace("step-input-request-", "");

  await signIn(page, fixture.secondWorker);
  await page.goto(`/process-runs/${fixture.activeRunId}#step-input-request-${requestId}`);
  const recipientDiscussion = stepDiscussion(page, fixture.humanStepId);
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Respond" })).toBeVisible();
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Cancel request" })).toHaveCount(0);

  await signIn(page, fixture.readOnly);
  await page.goto(`/process-runs/${fixture.activeRunId}#step-input-request-${requestId}`);
  const readOnlyDiscussion = stepDiscussion(page, fixture.humanStepId);
  await expect(readOnlyDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Respond" })).toHaveCount(0);
  await expect(readOnlyDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Cancel request" })).toHaveCount(0);

  await signIn(page, fixture.administrator);
  await page.goto(`/process-runs/${fixture.activeRunId}#step-input-request-${requestId}`);
  const adminDiscussion = stepDiscussion(page, fixture.humanStepId);
  await adminDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Cancel request" }).click();
  await expect(adminDiscussion.locator(`#step-input-request-${requestId}`).getByText("Cancelled")).toBeVisible();
  await expect(adminDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Cancel request" })).toHaveCount(0);
  // Cancellation preserves the origin comment/history -- it isn't deleted.
  await expect(adminDiscussion.getByText("Open step request for cancellation UI")).toBeVisible();
});

test("Archived-origin steps preserve request history read-only, deny new request/respond, but still allow admin cancellation", async ({
  page,
}) => {
  const admin = createSupabaseTestClient();
  await signIn(page, fixture.worker);

  // Create a fresh active-origin run/step specifically for this test so
  // archival doesn't interfere with the shared archivedOriginRunId fixture
  // (which is archived from the start and has no open request to cancel).
  const templateId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const originRecordId = randomUUID();
  const { error: recordError } = await admin.from("entity_records").insert({
    id: originRecordId,
    workspace_id: fixture.workspaceId,
    entity_type_id: fixture.entityTypeId,
    values: { name: "Archive after step request E2E" },
  });
  expect(recordError).toBeNull();
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: fixture.workspaceId,
    name: "E2E Archive After Step Request",
    applies_to_entity_type_id: fixture.entityTypeId,
  });
  expect(templateError).toBeNull();
  const { error: runError } = await admin.from("process_runs").insert({
    id: runId,
    workspace_id: fixture.workspaceId,
    process_template_id: templateId,
    process_template_name: "E2E Archive After Step Request",
    origin_entity_type_id: fixture.entityTypeId,
    origin_record_id: originRecordId,
    status: "active",
  });
  expect(runError).toBeNull();
  const { error: stepError } = await admin.from("process_step_runs").insert({
    id: stepId,
    workspace_id: fixture.workspaceId,
    process_run_id: runId,
    step_index: 1,
    node_type: "human_task",
    name: "Archive after request step",
    config: {},
    status: "active",
    started_at: new Date().toISOString(),
  });
  expect(stepError).toBeNull();

  await page.goto(`/process-runs/${runId}`);
  const discussion = stepDiscussion(page, stepId);
  await discussion.getByText("Request input").click();
  await discussion.getByLabel("Recipient").selectOption(fixture.secondWorker.id);
  await discussion.getByLabel("Request body").fill("Archive step request stays historical");
  await discussion.getByRole("button", { name: "Send request" }).click();
  const requestItem = discussion.locator("li").filter({ hasText: "Archive step request stays historical" });
  const requestTreatmentId = await requestItem.locator("[id^='step-input-request-']").getAttribute("id");
  expect(requestTreatmentId).toBeTruthy();
  const requestId = requestTreatmentId!.replace("step-input-request-", "");

  const archive = await admin.rpc("set_entity_records_archived_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_entity_type_id: fixture.entityTypeId,
    p_record_ids: [originRecordId],
    p_archived: true,
  });
  expect(archive.error).toBeNull();

  await signIn(page, fixture.secondWorker);
  await page.goto(`/process-runs/${runId}#step-input-request-${requestId}`);
  const recipientDiscussion = stepDiscussion(page, stepId);
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`).getByText("Open")).toBeVisible();
  await expect(recipientDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Respond" })).toHaveCount(0);
  await expect(
    recipientDiscussion.getByText("Archived origin records are read-only. Existing discussion remains available."),
  ).toBeVisible();

  await signIn(page, fixture.administrator);
  await page.goto(`/process-runs/${runId}#step-input-request-${requestId}`);
  const adminDiscussion = stepDiscussion(page, stepId);
  await adminDiscussion.locator(`#step-input-request-${requestId}`).getByRole("button", { name: "Cancel request" }).click();
  await expect(adminDiscussion.locator(`#step-input-request-${requestId}`).getByText("Cancelled")).toBeVisible();
});
