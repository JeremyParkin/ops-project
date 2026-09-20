import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  cleanupE2eRun,
  cleanupStaleE2eData,
  createSupabaseTestClient,
  createTestRun,
  DEMO_WORKSPACE_ID,
  type TestRun,
} from "./helpers/supabase-test-data";

test.describe.configure({ mode: "serial" });

let run: TestRun;
let alternateUserId = "";
let alternateEmail = "";
let secondUserId = "";
let secondEmail = "";

test.beforeAll(async () => {
  run = createTestRun();
  await cleanupStaleE2eData();

  const admin = createSupabaseTestClient();
  const { data: role, error: roleError } = await admin
    .from("workspace_roles")
    .select("id")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("is_builtin", true)
    .limit(1)
    .single<{ id: string }>();
  if (roleError || !role) throw new Error(roleError?.message ?? "Unable to load E2E role.");
  const roleId = role.id;

  async function createMember(label: string) {
    const password = `WorkspaceMember-${randomUUID()}!`;
    const email = `e2e-workspace-member-${label}-${randomUUID()}@example.test`;
    const { data: user, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (userError || !user.user) throw new Error(userError?.message ?? "Unable to create member.");

    const { error: membershipError } = await admin
      .from("workspace_memberships")
      .insert({ workspace_id: DEMO_WORKSPACE_ID, user_id: user.user.id, role_id: roleId });
    if (membershipError) throw new Error(membershipError.message);

    return { id: user.user.id, email };
  }

  const alternate = await createMember("alternate");
  alternateUserId = alternate.id;
  alternateEmail = alternate.email;
  const second = await createMember("second");
  secondUserId = second.id;
  secondEmail = second.email;
});

test.afterAll(async () => {
  await cleanupE2eRun(run);

  const admin = createSupabaseTestClient();
  if (alternateUserId) {
    await admin
      .from("workspace_memberships")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("user_id", alternateUserId);
    await admin.auth.admin.deleteUser(alternateUserId);
  }
  if (secondUserId) {
    await admin
      .from("workspace_memberships")
      .delete()
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("user_id", secondUserId);
    await admin.auth.admin.deleteUser(secondUserId);
  }
});

test("Workspace Member fields work through create, edit, display, filters, and import rejection", async ({
  page,
}) => {
  test.setTimeout(90_000);

  const entityName = `${run.label} Member Board`;

  await page.goto("/entities/new");
  await page.locator("#entityName").fill(entityName);
  await page.locator("#fieldName\\:field-1").fill("Title");
  await page.getByRole("button", { name: "Add Field" }).click();
  await page.locator('input[name^="fieldName:"]').last().fill("Owner");
  await page.locator('select[name^="fieldType:"]').last().selectOption("workspace_member");
  await page.getByRole("button", { name: "Create object" }).click();
  await page.waitForURL(/\/entities\/[0-9a-f-]{36}$/);

  const entityTypeId = page.url().match(/entities\/([0-9a-f-]{36})/)?.[1];
  expect(entityTypeId).toBeTruthy();

  await page.goto(`/entities/${entityTypeId}?manage=true`);
  await page.getByText("Add field", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByText("Add field", { exact: true }).click();
  await page.locator("#fieldName").fill("Reviewer");
  await page.locator("#fieldType").selectOption("workspace_member");
  await page.getByRole("button", { name: "Add Field" }).click();

  const admin = createSupabaseTestClient();
  const { data: fields, error: fieldError } = await admin
    .from("field_definitions")
    .select("id, key, name, type")
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entityTypeId)
    .in("name", ["Title", "Owner", "Reviewer"]);
  expect(fieldError).toBeNull();
  const ownerField = fields?.find((field) => field.name === "Owner");
  const titleField = fields?.find((field) => field.name === "Title");
  expect(ownerField?.type).toBe("workspace_member");
  expect(titleField?.key).toBeTruthy();

  await page.goto(`/entities/${entityTypeId}`);
  const addSection = page.locator("details#add-record");
  await addSection.locator("summary").click();
  await addSection.locator(`[name="${titleField!.key}"]`).fill(`${run.label} First task`);
  await addSection.locator(`[name="${ownerField!.key}"]`).selectOption(alternateUserId);
  await page.getByRole("button", { name: `Add ${entityName}` }).click();
  await expect(page.getByRole("row").filter({ hasText: `${run.label} First task` })).toContainText(alternateEmail);

  const rowLink = page.getByRole("link", { name: `${run.label} First task`, exact: true });
  const detailHref = await rowLink.getAttribute("href");
  expect(detailHref).toBeTruthy();
  await page.goto(detailHref!);
  await expect(page.getByRole("button", { name: "Edit Owner" })).toContainText(alternateEmail);

  await page.goto(`${detailHref}/edit`);
  await page.locator(`[name="${ownerField!.key}"]`).selectOption(secondUserId);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForURL(`/entities/${entityTypeId}`);
  await page.goto(detailHref!);
  await expect(page.getByRole("button", { name: "Edit Owner" })).toContainText(secondEmail);

  const { error: deactivateError } = await admin
    .from("workspace_memberships")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("user_id", secondUserId);
  expect(deactivateError).toBeNull();

  await page.goto(detailHref!);
  await expect(page.getByRole("button", { name: "Edit Owner" })).toContainText(`${secondEmail} (Deactivated)`);

  await page.goto(`/entities/${entityTypeId}`);
  await addSection.locator("summary").click();
  await expect(addSection.locator(`[name="${ownerField!.key}"]`)).not.toContainText(secondEmail);

  await page.goto(`${detailHref}/edit`);
  await page.locator(`[name="${ownerField!.key}"]`).selectOption("");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.waitForURL(`/entities/${entityTypeId}`);
  await expect(page.getByRole("row").filter({ hasText: `${run.label} First task` })).toContainText("—");

  await page.goto(`/entities/${entityTypeId}`);
  await page.getByText("Manage views", { exact: true }).click();
  await expect(async () => {
    await page.getByRole("button", { name: "Add Filter", exact: true }).click();
    await expect(page.locator('select[name="filterField:0"]')).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.locator('select[name="filterField:0"]').selectOption(ownerField!.id);
  await page.locator('select[name="filterOperator:0"]').selectOption("is_not_set");
  await page.getByLabel("View Name").fill(`${run.label} Unassigned`);
  await page.getByRole("button", { name: "Create View" }).click();
  await expect(page.getByText(`${run.label} Unassigned`)).toBeVisible();

  await page.goto(`/entities/${entityTypeId}/import`);
  await page
    .locator('input[type="file"]')
    .setInputFiles({
      name: "workspace-member-import.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`Title,Owner\nImported Task,${alternateEmail}\n`),
    });
  await expect(page.getByText(/CSV import does not support Workspace Member fields yet/i)).toBeVisible();
});
