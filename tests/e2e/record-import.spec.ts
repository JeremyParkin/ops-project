import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
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
    const { error } = await admin
      .from("workspaces")
      .delete()
      .in("id", workspaceIds);
    if (error) throw new Error(error.message);
  }
  for (const userId of userIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

function csvFrom(headers: string[], rows: string[][]) {
  const lines = [headers, ...rows].map((line) =>
    line.map((cell) => (cell.includes(",") ? `"${cell}"` : cell)).join(","),
  );
  return lines.join("\n");
}

async function uploadCsv(
  page: Page,
  csvContent: string,
  fileName = "import.csv",
) {
  await page.setInputFiles("#import-csv-file", {
    name: fileName,
    mimeType: "text/csv",
    buffer: Buffer.from(csvContent, "utf8"),
  });
}

async function createImportEntity(run: TestRun, suffix: string) {
  const supabase = createSupabaseTestClient();
  return createEntity(supabase, run, suffix, [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "start_date", name: "Start Date", type: "date" },
  ]);
}

async function gotoImport(page: Page, entity: TestEntity) {
  await page.goto(`/entities/${entity.id}/import`);
  await page.waitForLoadState("networkidle");
}

test.describe("import permission boundary", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a worker without records.operate is redirected away from the import page", async ({
    page,
  }) => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    const { error: workspaceError } = await admin
      .from("workspaces")
      .insert({
        id: workspaceId,
        name: `Import Permission ${workspaceId.slice(0, 8)}`,
      });
    expect(workspaceError).toBeNull();

    const entityTypeId = randomUUID();
    const { error: entityTypeError } = await admin.from("entity_types").insert({
      id: entityTypeId,
      workspace_id: workspaceId,
      name: "Import Permission Target",
      slug: `import-permission-target-${workspaceId.slice(0, 8)}`,
    });
    expect(entityTypeError).toBeNull();
    const { error: fieldError } = await admin.from("field_definitions").insert({
      id: randomUUID(),
      workspace_id: workspaceId,
      entity_type_id: entityTypeId,
      key: `fld_perm_${workspaceId.slice(0, 8)}`,
      name: "Name",
      slug: "name",
      type: "text",
      required: true,
      position: 1,
    });
    expect(fieldError).toBeNull();

    // A role deliberately missing records.operate -- the one capability the
    // import surface requires.
    const roleId = randomUUID();
    const { error: roleError } = await admin
      .from("workspace_roles")
      .insert({
        id: roleId,
        workspace_id: workspaceId,
        name: "Import Permission Viewer",
      });
    expect(roleError).toBeNull();
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert([
        {
          workspace_id: workspaceId,
          role_id: roleId,
          capability: "operations.view",
        },
      ]);
    expect(capabilityError).toBeNull();

    const password = `E2E-import-permission-${randomUUID()}!`;
    const email = `e2e-import-permission-${randomUUID()}@example.test`;
    const { data: userData, error: userError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
    if (userError || !userData.user)
      throw new Error(userError?.message ?? "Unable to create user.");
    userIds.push(userData.user.id);
    const { error: membershipError } = await admin
      .from("workspace_memberships")
      .insert({
        workspace_id: workspaceId,
        user_id: userData.user.id,
        role_id: roleId,
      });
    expect(membershipError).toBeNull();

    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("/");

    await page.goto(`/entities/${entityTypeId}/import`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(new RegExp(`/entities/${entityTypeId}$`));
    await expect(page.getByRole("heading", { name: "Import CSV" })).toHaveCount(
      0,
    );
  });
});

test("a clean CSV import creates records that appear in the object list, global search, and a saved view", async ({
  page,
}) => {
  const run = createScenarioRun();
  const entity = await createImportEntity(run, "Import Clean");
  const supabase = createSupabaseTestClient();
  const { error: viewError } = await supabase.from("entity_views").insert({
    workspace_id: DEMO_WORKSPACE_ID,
    entity_type_id: entity.id,
    name: `${run.label} All Rows`,
    position: 2,
    is_default: false,
    filters: [],
    sorts: [],
    column_field_definition_ids: [
      entity.fields.name.id,
      entity.fields.start_date.id,
    ],
  });
  expect(viewError).toBeNull();

  const csv = csvFrom(
    ["Name", "Start Date"],
    [
      [`${run.label} Acme`, "2026-03-04"],
      [`${run.label} Globex`, "2026-05-01"],
    ],
  );

  await gotoImport(page, entity);
  await uploadCsv(page, csv);
  await expect(page.getByText("2 rows total")).toBeVisible();
  await page.getByRole("button", { name: "Import" }).click();
  await expect(
    page.getByText(`2 rows imported into ${entity.name}.`),
  ).toBeVisible();

  await page.getByRole("link", { name: `View ${entity.name}` }).click();
  await expect(
    page.getByRole("heading", { name: entity.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: `${run.label} Acme` }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: `${run.label} Globex` }),
  ).toBeVisible();

  await page.getByRole("link", { name: `${run.label} All Rows` }).click();
  await expect(
    page.getByRole("row").filter({ hasText: `${run.label} Acme` }),
  ).toBeVisible();

  await page
    .getByRole("searchbox", { name: "Search", exact: true })
    .fill(`${run.label} Globex`);
  await page
    .getByRole("button", { name: "Search", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.getByRole("link", { name: `${run.label} Globex` })).toBeVisible();
});

test("a CSV with a mix of valid and invalid rows blocks commit until fixed", async ({
  page,
}) => {
  const run = createScenarioRun();
  const entity = await createImportEntity(run, "Import Mixed");

  const csv = csvFrom(
    ["Name", "Start Date"],
    [
      [`${run.label} Valid Row`, "2026-03-04"],
      [`${run.label} Bad Date Row`, "03/04/2026"],
    ],
  );

  await gotoImport(page, entity);
  await uploadCsv(page, csv);
  await expect(page.getByText("Start Date must use YYYY-MM-DD.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import" })).toBeDisabled();

  // Remap the offending column to Ignore -- both rows become ready and the
  // commit path unblocks.
  await selectReactOption(page.getByLabel("Field for column Start Date"), {
    label: "Ignore",
  });
  await expect(page.getByText("2 rows total")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import" })).toBeEnabled();
  await page.getByRole("button", { name: "Import" }).click();
  await expect(
    page.getByText(`2 rows imported into ${entity.name}.`),
  ).toBeVisible();
});

test("a 500-row CSV import completes synchronously", async ({ page }) => {
  test.setTimeout(120_000);
  const run = createScenarioRun();
  const entity = await createImportEntity(run, "Import Scale");

  const rows = Array.from({ length: 500 }, (_, index) => [
    `${run.label} Row ${index + 1}`,
    "",
  ]);
  const csv = csvFrom(["Name", "Start Date"], rows);

  await gotoImport(page, entity);
  await uploadCsv(page, csv);
  await expect(page.getByText("500 rows total")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Import" })).toBeEnabled();

  const start = Date.now();
  await page.getByRole("button", { name: "Import" }).click();
  await expect(
    page.getByText(`500 rows imported into ${entity.name}.`),
  ).toBeVisible({
    timeout: 60_000,
  });
  const elapsedMs = Date.now() - start;
  console.log(`[record-import] 500-row commit took ${elapsedMs}ms`);

  const supabase = createSupabaseTestClient();
  const { count, error } = await supabase
    .from("entity_records")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("entity_type_id", entity.id);
  expect(error).toBeNull();
  expect(count).toBe(500);
});
