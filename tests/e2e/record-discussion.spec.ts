import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { createSupabaseTestClient, deleteE2eUsers } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });

type User = { id: string; email: string; password: string };

type Fixture = {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  archivedRecordId: string;
  worker: User;
  secondWorker: User;
  administrator: User;
  readOnly: User;
};

let fixture: Fixture;
const createdUserIds: string[] = [];

function uniqueEmail(label: string) {
  return `e2e-discussion-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Discussion-${randomUUID()}!`;
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

// Discussion and Activity render as a native <details> now (record-detail
// polish slice: all five record-detail sections are collapsible), not a
// plain <section> -- the heading itself and its text are unchanged.
function discussion(page: Page) {
  return page.locator("details").filter({
    has: page.getByRole("heading", { name: "Discussion", exact: true }),
  });
}

function activity(page: Page) {
  return page.locator("details").filter({
    has: page.getByRole("heading", { name: "Activity", exact: true }),
  });
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
    name: `E2E Discussion ${workspaceId.slice(0, 8)}`,
  });
  if (workspaceError) throw new Error(workspaceError.message);

  const workerRoleId = await createRole(workspaceId, "Worker", ["records.operate"]);
  const adminRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members",
    "workspace.manage_roles",
    "workspace.manage_settings",
    "schema.manage",
    "records.operate",
    "workspace.impersonate_users",
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
    name: "E2E Discussion Client",
    slug: `e2e-discussion-client-${workspaceId.slice(0, 8)}`,
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

  const { error: displayError } = await admin.rpc("set_entity_display_field", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_field_definition_id: fieldId,
  });
  if (displayError) throw new Error(displayError.message);

  const { error: recordError } = await admin.from("entity_records").insert([
    {
      id: recordId,
      workspace_id: workspaceId,
      entity_type_id: entityTypeId,
      values: { name: "Discussion Acme" },
    },
    {
      id: archivedRecordId,
      workspace_id: workspaceId,
      entity_type_id: entityTypeId,
      values: { name: "Archived Discussion Acme" },
      archived_at: new Date().toISOString(),
    },
  ]);
  if (recordError) throw new Error(recordError.message);

  return {
    workspaceId,
    entityTypeId,
    recordId,
    archivedRecordId,
    worker,
    secondWorker,
    administrator,
    readOnly,
  };
}

test.beforeAll(async () => {
  fixture = await createFixture();
});

test.afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];
  if (fixture?.workspaceId) {
    const { error: notificationError } = await admin.from("notifications").delete().eq("workspace_id", fixture.workspaceId);
    if (notificationError) failures.push(notificationError.message);
    const { error: requestError } = await admin.from("record_input_requests").delete().eq("workspace_id", fixture.workspaceId);
    if (requestError) failures.push(requestError.message);
    const { error: commentError } = await admin.from("record_comments").delete().eq("workspace_id", fixture.workspaceId);
    if (commentError) failures.push(commentError.message);
    const { error: workspaceError } = await admin.from("workspaces").delete().eq("id", fixture.workspaceId);
    if (workspaceError) failures.push(workspaceError.message);
  }
  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (failures.length > 0) {
    throw new Error(`record-discussion cleanup failed:\n${failures.join("\n")}`);
  }
});

test("Discussion supports create, ordering, validation, tombstone, and remains distinct from Activity", async ({ page }) => {
  await signIn(page, fixture.worker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);

  await expect(discussion(page).getByText("No comments yet.")).toBeVisible();
  await expect(activity(page)).toBeVisible();

  await discussion(page).getByLabel("Add a comment").fill("   ");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByRole("alert")).toContainText("Comment body is required.");

  await discussion(page).getByLabel("Add a comment").evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.value = "x".repeat(4001);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByRole("alert")).toContainText("4000 characters or fewer");

  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await expect(discussion(page).getByText("No comments yet.")).toBeVisible();

  await discussion(page).getByLabel("Add a comment").fill("Second visible comment");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByText("Second visible comment")).toBeVisible();

  await discussion(page).getByLabel("Add a comment").fill("First visible comment");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByText("First visible comment")).toBeVisible();

  // "Second visible comment" was posted first, "First visible comment"
  // second -- deliberately, so this asserts genuine newest-first display
  // order (record-detail polish slice) rather than merely matching
  // creation order by coincidence.
  const bodies = discussion(page).locator("li").filter({ hasText: "visible comment" });
  await expect(bodies.nth(0)).toContainText("First visible comment");
  await expect(bodies.nth(1)).toContainText("Second visible comment");
  await expect(bodies.first().getByText(fixture.worker.email)).toBeVisible();
  await expect(discussion(page).locator("time").first()).toBeVisible();

  const removedComment = discussion(page).locator("li").filter({ hasText: "Second visible comment" });
  await removedComment.getByRole("button", { name: "Remove" }).click();
  await expect(discussion(page).getByText("Comment removed")).toBeVisible();
  await expect(discussion(page).getByText("Second visible comment")).toHaveCount(0);
  await expect(activity(page).getByText("Comment removed")).toHaveCount(0);
});

test("Discussion mentions active members and creates navigable notifications", async ({ page }) => {
  const admin = createSupabaseTestClient();

  await signIn(page, fixture.worker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);

  const composer = discussion(page).getByLabel("Add a comment");
  await composer.fill("Escape check @");
  await expect(discussion(page).getByRole("listbox")).toBeVisible();
  await composer.press("Escape");
  await expect(discussion(page).getByRole("listbox")).toHaveCount(0);

  await composer.fill("Please review @second");
  await discussion(page).getByRole("option", { name: `@${fixture.secondWorker.email}` }).waitFor();
  await composer.press("ArrowDown");
  await composer.press("ArrowUp");
  await composer.press("Enter");
  await expect(composer).toHaveValue(`Please review @${fixture.secondWorker.email} `);
  await composer.pressSequentially("and duplicate @second");
  await composer.press("Tab");
  await composer.pressSequentially("\nBefore tomorrow.");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();

  const mentionedComment = discussion(page).locator("li").filter({ hasText: "Before tomorrow." });
  await expect(mentionedComment.getByText(`@${fixture.secondWorker.email}`)).toBeVisible();
  await expect(mentionedComment).toHaveAttribute("id", /^comment-/);

  const mentionedStorage = await admin
    .from("record_comments")
    .select("id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("entity_record_id", fixture.recordId)
    .like("body", "Please review%Before tomorrow.");
  expect(mentionedStorage.error).toBeNull();
  expect(mentionedStorage.data).toHaveLength(1);
  const mentionedCommentId = mentionedStorage.data![0].id;

  const durableMentions = await admin
    .from("record_comment_mentions")
    .select("mentioned_user_id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("record_comment_id", mentionedCommentId);
  expect(durableMentions.error).toBeNull();
  expect(durableMentions.data).toEqual([{ mentioned_user_id: fixture.secondWorker.id }]);

  await composer.fill("No durable mention @second");
  await discussion(page).getByRole("option", { name: `@${fixture.secondWorker.email}` }).waitFor();
  await composer.press("Enter");
  await composer.fill("No durable mention after removing visible text");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByText("No durable mention after removing visible text")).toBeVisible();

  await expect
    .poll(async () => {
      const result = await admin
        .from("record_comments")
        .select("id")
        .eq("workspace_id", fixture.workspaceId)
        .eq("entity_record_id", fixture.recordId)
        .eq("body", "No durable mention after removing visible text");
      if (result.error) throw new Error(result.error.message);
      return result.data.length;
    })
    .toBe(1);
  const removedSelectionStorage = await admin
    .from("record_comments")
    .select("id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("entity_record_id", fixture.recordId)
    .eq("body", "No durable mention after removing visible text")
    .single();
  expect(removedSelectionStorage.error).toBeNull();
  const removedDurableMentions = await admin
    .from("record_comment_mentions")
    .select("mentioned_user_id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("record_comment_id", removedSelectionStorage.data!.id);
  expect(removedDurableMentions.error).toBeNull();
  expect(removedDurableMentions.data).toEqual([]);

  await signIn(page, fixture.secondWorker);
  await page.goto("/notifications");
  await expect(page.getByText(`${fixture.worker.email} mentioned you`)).toBeVisible();
  await expect(page.getByText("Discussion Acme")).toBeVisible();

  await page.getByRole("link", { name: new RegExp(`${fixture.worker.email} mentioned you`) }).click();
  await page.waitForURL(new RegExp(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}#comment-`));
  await expect(discussion(page).getByText("Before tomorrow.")).toBeVisible();
});

test("archived records keep discussion readable but remove the composer", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("record_comments").insert({
    workspace_id: fixture.workspaceId,
    entity_type_id: fixture.entityTypeId,
    entity_record_id: fixture.archivedRecordId,
    body: "Comment before archive",
    author_user_id: fixture.worker.id,
    author_label: fixture.worker.email,
  });
  expect(error).toBeNull();

  await signIn(page, fixture.worker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.archivedRecordId}`);

  await expect(discussion(page).getByText("Comment before archive")).toBeVisible();
  await expect(discussion(page).getByLabel("Add a comment")).toHaveCount(0);
  await expect(discussion(page).getByText("Archived records are read-only. Existing discussion remains available.")).toBeVisible();

  await discussion(page).getByRole("button", { name: "Remove" }).click();
  await expect(discussion(page).getByText("Comment removed")).toBeVisible();
});

test("records.operate and administrator boundaries are enforced from record detail", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const { data: inserted, error } = await admin
    .from("record_comments")
    .insert({
      workspace_id: fixture.workspaceId,
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      body: "Administrator tombstone target",
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  // Scoped by the comment's own stable anchor id, not its body text -- once
  // tombstoned, "Administrator tombstone target" no longer appears in the
  // DOM at all (replaced by "Comment removed"), so a text-based filter
  // would stop matching the very element being asserted on.
  const targetComment = page.locator(`#comment-${inserted!.id}`);

  await signIn(page, fixture.readOnly);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await discussion(page).getByLabel("Add a comment").fill("Read-only attempt");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByRole("alert")).toContainText("records.operate");

  await signIn(page, fixture.secondWorker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await targetComment.getByRole("button", { name: "Remove" }).click();
  await expect(targetComment.getByRole("alert")).toContainText("only remove your own comments");

  await signIn(page, fixture.administrator);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await targetComment.getByRole("button", { name: "Remove" }).click();
  await expect(targetComment.getByText("Comment removed")).toBeVisible();
  await expect(discussion(page).getByText("Administrator tombstone target")).toHaveCount(0);
});

test("impersonated comments show effective author and real actor attribution", async ({ page }) => {
  await signIn(page, fixture.administrator);

  await page.goto("/settings");
  const memberRow = page.getByLabel(`Role for ${fixture.worker.email}`).locator("../../..");
  await memberRow.getByRole("button", { name: "Log in as" }).click();
  await page.waitForURL("/");
  await expect(page.getByText("Exit impersonation")).toBeVisible();

  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await discussion(page).getByLabel("Add a comment").fill("Impersonated UI comment");
  await discussion(page).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(page).getByText("Impersonated UI comment")).toBeVisible();
  await expect(discussion(page).getByText(`${fixture.worker.email} via ${fixture.administrator.email}`)).toBeVisible();

  await page.getByRole("button", { name: "Exit impersonation" }).click();
  await expect(page.getByText("Exit impersonation")).toHaveCount(0);
});

test("Request input creates one discussion item, deep-links recipient response, and keeps ordinary comments inert", async ({
  browser,
}) => {
  const requesterContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const requesterPage = await requesterContext.newPage();
  await signIn(requesterPage, fixture.worker);
  await requesterPage.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);

  await expect(discussion(requesterPage).getByText("Request input")).toBeVisible();
  await discussion(requesterPage).getByText("Request input").click();
  const recipientSelect = discussion(requesterPage).getByLabel("Recipient");
  await expect(recipientSelect.locator("option", { hasText: fixture.secondWorker.email })).toHaveCount(1);
  await expect(recipientSelect.locator("option", { hasText: fixture.administrator.email })).toHaveCount(1);
  await expect(recipientSelect.locator("option", { hasText: fixture.readOnly.email })).toHaveCount(0);

  const requestBody = `Need explicit input ${randomUUID()}`;
  await recipientSelect.selectOption(fixture.secondWorker.id);
  await discussion(requesterPage).getByLabel("Request body").fill(requestBody);
  await discussion(requesterPage).getByRole("button", { name: "Send request" }).click();
  await expect(discussion(requesterPage).getByText("Input requested.")).toBeVisible();
  await expect(discussion(requesterPage).getByText(requestBody)).toHaveCount(1);
  const requestItem = discussion(requesterPage).locator("li").filter({ hasText: requestBody });
  await expect(requestItem.getByText(`Input requested from ${fixture.secondWorker.email}`)).toBeVisible();
  await expect(requestItem.getByText("Open")).toBeVisible();
  await expect(requestItem.getByRole("button", { name: "Cancel request" })).toBeVisible();

  const requestTreatmentId = await requestItem.locator("[id^='input-request-']").getAttribute("id");
  expect(requestTreatmentId).toBeTruthy();
  const requestId = requestTreatmentId!.replace("input-request-", "");

  const recipientContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const recipientPage = await recipientContext.newPage();
  await signIn(recipientPage, fixture.secondWorker);
  await recipientPage.goto("/notifications");
  await expect(recipientPage.getByText(/\d+ unread/)).toBeVisible();
  await recipientPage.getByRole("link", { name: new RegExp(`${fixture.worker.email} requested your input`) }).click();
  await recipientPage.waitForURL(`**/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${requestId}`);
  await expect(discussion(recipientPage).locator(`#input-request-${requestId}`)).toBeVisible();
  await expect(discussion(recipientPage).locator(`#input-request-${requestId}`).getByRole("button", { name: "Respond" })).toBeVisible();

  await discussion(recipientPage).getByLabel("Add a comment").fill("Ordinary comment should not close request");
  await discussion(recipientPage).getByRole("button", { name: "Add comment" }).click();
  await expect(discussion(recipientPage).getByText("Ordinary comment should not close request")).toBeVisible();
  await expect(discussion(recipientPage).locator(`#input-request-${requestId}`).getByText("Open")).toBeVisible();

  await discussion(recipientPage).locator(`#input-request-${requestId}`).getByLabel("Response").fill("Explicit response from recipient");
  await discussion(recipientPage).locator(`#input-request-${requestId}`).getByRole("button", { name: "Respond" }).click();
  await expect(discussion(recipientPage).getByText("Explicit response from recipient")).toBeVisible();
  await expect(discussion(recipientPage).locator(`#input-request-${requestId}`).getByText("Responded")).toBeVisible();
  await expect(discussion(recipientPage).locator(`#input-request-${requestId}`).getByRole("button", { name: "Respond" })).toHaveCount(0);
  await expect(discussion(recipientPage).getByText("Response to input request")).toBeVisible();

  await requesterPage.goto("/notifications");
  await expect(requesterPage.getByRole("link", { name: new RegExp(`${fixture.secondWorker.email} responded to your request`) })).toBeVisible();

  await requesterContext.close();
  await recipientContext.close();
});

test("Request input cancellation and archived open-request UI expose only valid actions", async ({ page }) => {
  const admin = createSupabaseTestClient();
  await signIn(page, fixture.worker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await discussion(page).getByText("Request input").click();
  await discussion(page).getByLabel("Recipient").selectOption(fixture.secondWorker.id);
  await discussion(page).getByLabel("Request body").fill("Open request for cancellation UI");
  await discussion(page).getByRole("button", { name: "Send request" }).click();
  const requestItem = discussion(page).locator("li").filter({ hasText: "Open request for cancellation UI" });
  const requestTreatmentId = await requestItem.locator("[id^='input-request-']").getAttribute("id");
  expect(requestTreatmentId).toBeTruthy();
  const requestId = requestTreatmentId!.replace("input-request-", "");

  await signIn(page, fixture.secondWorker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${requestId}`);
  await expect(discussion(page).locator(`#input-request-${requestId}`).getByRole("button", { name: "Respond" })).toBeVisible();
  await expect(discussion(page).locator(`#input-request-${requestId}`).getByRole("button", { name: "Cancel request" })).toHaveCount(0);

  await signIn(page, fixture.readOnly);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${requestId}`);
  await expect(discussion(page).locator(`#input-request-${requestId}`).getByRole("button", { name: "Respond" })).toHaveCount(0);
  await expect(discussion(page).locator(`#input-request-${requestId}`).getByRole("button", { name: "Cancel request" })).toHaveCount(0);

  await signIn(page, fixture.administrator);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${requestId}`);
  await discussion(page).locator(`#input-request-${requestId}`).getByRole("button", { name: "Cancel request" }).click();
  await expect(discussion(page).locator(`#input-request-${requestId}`).getByText("Cancelled")).toBeVisible();
  await expect(discussion(page).locator(`#input-request-${requestId}`).getByRole("button", { name: "Cancel request" })).toHaveCount(0);

  await signIn(page, fixture.worker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}`);
  await discussion(page).getByText("Request input").click();
  await discussion(page).getByLabel("Recipient").selectOption(fixture.secondWorker.id);
  await discussion(page).getByLabel("Request body").fill("Archive request stays historical");
  await discussion(page).getByRole("button", { name: "Send request" }).click();
  const archivedRequestItem = discussion(page).locator("li").filter({ hasText: "Archive request stays historical" });
  const archivedRequestTreatmentId = await archivedRequestItem.locator("[id^='input-request-']").getAttribute("id");
  expect(archivedRequestTreatmentId).toBeTruthy();
  const archivedRequestId = archivedRequestTreatmentId!.replace("input-request-", "");
  const archive = await admin.rpc("set_entity_records_archived_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_entity_type_id: fixture.entityTypeId,
    p_record_ids: [fixture.recordId],
    p_archived: true,
  });
  expect(archive.error).toBeNull();

  await signIn(page, fixture.secondWorker);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${archivedRequestId}`);
  await expect(discussion(page).locator(`#input-request-${archivedRequestId}`).getByText("Open")).toBeVisible();
  await expect(discussion(page).locator(`#input-request-${archivedRequestId}`).getByRole("button", { name: "Respond" })).toHaveCount(0);
  await expect(discussion(page).locator(`#input-request-${archivedRequestId}`).getByText("Archived records can no longer receive responses.")).toBeVisible();

  await signIn(page, fixture.administrator);
  await page.goto(`/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${archivedRequestId}`);
  await discussion(page).locator(`#input-request-${archivedRequestId}`).getByRole("button", { name: "Cancel request" }).click();
  await expect(discussion(page).locator(`#input-request-${archivedRequestId}`).getByText("Cancelled")).toBeVisible();
});
