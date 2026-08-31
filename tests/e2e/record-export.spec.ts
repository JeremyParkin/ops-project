import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { expect, test, type Page } from "@playwright/test";
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
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
  }
});

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);
  return run;
}

async function downloadExportCsv(page: Page, entity: TestEntity): Promise<string> {
  await page.goto(`/entities/${entity.id}`);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export CSV" }).click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("Export download produced no file path.");
  return readFileSync(path, "utf8");
}

test.describe("export permission boundary", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

test("a worker without records.operate can still export CSV, and archived records/fields are excluded", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  workspaceIds.push(workspaceId);
  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId, name: `Export Permission ${workspaceId.slice(0, 8)}`,
  });
  expect(workspaceError).toBeNull();

  const entityTypeId = randomUUID();
  const nameFieldId = randomUUID();
  const archivedFieldId = randomUUID();
  const { error: entityTypeError } = await admin.from("entity_types").insert({
    id: entityTypeId, workspace_id: workspaceId, name: "Export Permission Target",
    slug: `export-permission-target-${workspaceId.slice(0, 8)}`,
  });
  expect(entityTypeError).toBeNull();
  const { error: fieldsError } = await admin.from("field_definitions").insert([
    { id: nameFieldId, workspace_id: workspaceId, entity_type_id: entityTypeId, key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1 },
    { id: archivedFieldId, workspace_id: workspaceId, entity_type_id: entityTypeId, key: "notes", name: "Notes", slug: "notes", type: "text", required: false, position: 2, archived_at: new Date().toISOString() },
  ]);
  expect(fieldsError).toBeNull();

  const activeRecordId = randomUUID();
  const archivedRecordId = randomUUID();
  const { error: recordsError } = await admin.from("entity_records").insert([
    { id: activeRecordId, workspace_id: workspaceId, entity_type_id: entityTypeId, values: { name: "Visible Record", notes: "hidden field value" } },
    { id: archivedRecordId, workspace_id: workspaceId, entity_type_id: entityTypeId, values: { name: "Archived Record" }, archived_at: new Date().toISOString() },
  ]);
  expect(recordsError).toBeNull();

  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: "Export Permission Viewer" });
  expect(roleError).toBeNull();
  const { error: capabilityError } = await admin.from("workspace_role_capabilities").insert([
    { workspace_id: workspaceId, role_id: roleId, capability: "operations.view" },
  ]);
  expect(capabilityError).toBeNull();

  const password = `E2E-export-permission-${randomUUID()}!`;
  const email = `e2e-export-permission-${randomUUID()}@example.test`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError || !userData.user) throw new Error(userError?.message ?? "Unable to create user.");
  userIds.push(userData.user.id);
  const { error: membershipError } = await admin.from("workspace_memberships").insert({
    workspace_id: workspaceId, user_id: userData.user.id, role_id: roleId,
  });
  expect(membershipError).toBeNull();

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");

  const csv = await downloadExportCsv(page, {
    id: entityTypeId,
    name: "Export Permission Target",
    slug: `export-permission-target-${workspaceId.slice(0, 8)}`,
    fields: {},
  });

  const rows = parse(csv) as string[][];
  // Only the active field (Name) is a column -- the archived Notes field
  // must not appear as a header, let alone leak its value.
  expect(rows[0]).toEqual(["Name"]);
  expect(rows).toHaveLength(2); // header + one active record
  expect(rows[1]).toEqual(["Visible Record"]);
  expect(csv).not.toContain("Archived Record");
  expect(csv).not.toContain("hidden field value");

  // Cross-workspace isolation, reusing this same signed-in session: this
  // user is a member of workspaceId only. A business object that genuinely
  // exists, just in a different workspace (DEMO_WORKSPACE_ID), must 404 --
  // not leak data and not be distinguishable from a nonexistent id.
  const foreignEntityTypeId = randomUUID();
  const { error: foreignEntityError } = await admin.from("entity_types").insert({
    id: foreignEntityTypeId, workspace_id: DEMO_WORKSPACE_ID, name: "Export Isolation Foreign",
    slug: `export-isolation-foreign-${foreignEntityTypeId.slice(0, 8)}`,
  });
  expect(foreignEntityError).toBeNull();

  const foreignResponse = await page.request.get(`/entities/${foreignEntityTypeId}/export`);
  expect(foreignResponse.status()).toBe(404);

  await admin.from("entity_types").delete().eq("id", foreignEntityTypeId);
});
});

test("export then re-import round-trips primitive values and an active relation via unique label match", async ({ page }) => {
  const run = createScenarioRun();
  const admin = createSupabaseTestClient();
  const target = await createEntity(admin, run, "Export Relation Target", [
    { slug: "name", name: "Name", type: "text", required: true },
  ]);
  const targetRecordId = await createEntityRecord({ entity: target, valuesBySlug: { name: `${run.label} Acme` } });

  const source = await createEntity(admin, run, "Export Roundtrip Source", [
    { slug: "name", name: "Name", type: "text", required: true },
    { slug: "amount", name: "Amount", type: "number" },
    { slug: "active", name: "Active", type: "boolean" },
    { slug: "started", name: "Started", type: "date" },
    { slug: "client", name: "Client", type: "relation", relatedEntityTypeId: target.id },
  ]);
  await createEntityRecord({
    entity: source,
    valuesBySlug: { name: `${run.label} Source Row`, amount: 4200, active: true, started: "2026-03-04" },
    relationsBySlug: { client: targetRecordId },
  });

  const csv = await downloadExportCsv(page, source);
  const rows = parse(csv) as string[][];
  expect(rows[0]).toEqual(["Name", "Amount", "Active", "Started", "Client"]);
  expect(rows[1]).toEqual([`${run.label} Source Row`, "4200", "true", "2026-03-04", `${run.label} Acme`]);

  // Re-import the exported CSV back into the same object -- proves every
  // value csv-stringify produced is independently valid input to the
  // unmodified, existing import parser/relation resolver, not just an
  // assertion about what export happens to write.
  await page.goto(`/entities/${source.id}/import`);
  await page.waitForLoadState("networkidle");
  await page.setInputFiles("#import-csv-file", { name: "roundtrip.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  await expect(page.getByText(/1 rows? total/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Import" })).toBeEnabled();
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText(new RegExp(`1 rows? imported into ${source.name}\\.`))).toBeVisible();
});
