import { randomUUID } from "node:crypto";
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
import { rowForText } from "./helpers/ui";

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

function createScenarioRun() {
  const run = createTestRun();
  runs.push(run);

  return run;
}

async function createView({
  entity,
  name,
  position,
  isDefault = false,
  filters = [],
}: {
  entity: TestEntity;
  name: string;
  position: number;
  isDefault?: boolean;
  filters?: unknown[];
}) {
  const supabase = createSupabaseTestClient();
  const result = await supabase
    .from("entity_views")
    .insert({
      workspace_id: DEMO_WORKSPACE_ID,
      entity_type_id: entity.id,
      name,
      position,
      is_default: isDefault,
      filters,
      sorts: [],
      column_field_definition_ids: Object.values(entity.fields).map((field) => field.id),
    })
    .select("id")
    .single<{ id: string }>();

  expect(result.error).toBeNull();
  return String(result.data?.id);
}

function entityCard(page: Page, entity: TestEntity) {
  return page.getByRole("heading", { name: entity.name, exact: true }).locator("..").locator("..");
}

test("home provides shared navigation and keeps the entity card on its default view", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Workspace Work", [
    { slug: "title", name: "Title", type: "text", required: true },
    { slug: "status", name: "Status", type: "text" },
  ]);
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Ready`, status: "Ready" },
  });
  await createEntityRecord({
    entity,
    valuesBySlug: { title: `${run.label} Draft`, status: "Draft" },
  });
  await createView({
    entity,
    name: `${run.label} Ready Only`,
    position: 1,
    isDefault: true,
    filters: [
      {
        fieldDefinitionId: entity.fields.status.id,
        operator: "equals",
        value: "Ready",
      },
    ],
  });
  await createView({ entity, name: `${run.label} First`, position: 2 });
  await createView({ entity, name: `${run.label} Second`, position: 3 });
  await createView({ entity, name: `${run.label} Hidden`, position: 4 });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Automations", exact: true })).toHaveCount(0);
  await page.getByText("Configure", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Automations", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Data model", exact: true })).toBeVisible();

  // Home's business-object cards are deliberately decluttered (8A): only
  // Open + Add, no per-card view shortcuts -- view switching lives on the
  // entity page itself, covered by views.spec.ts. Opening from Home still
  // respects the entity's default view.
  const card = entityCard(page, entity);
  await expect(card.getByRole("link", { name: "Open" })).toBeVisible();
  await expect(card.getByRole("link", { name: `Add ${entity.name}` })).toBeVisible();
  await expect(card.getByRole("link", { name: "All Records" })).toHaveCount(0);
  await expect(card.getByRole("link", { name: `${run.label} Ready Only · Default` })).toHaveCount(0);

  await card.getByRole("link", { name: "Open" }).click();
  await expect(rowForText(page, `${run.label} Ready`)).toBeVisible();
  await expect(rowForText(page, `${run.label} Draft`)).toHaveCount(0);

  await page.getByRole("link", { name: "All Records", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/entities/${entity.id}\\?view=all$`));
  await expect(rowForText(page, `${run.label} Draft`)).toBeVisible();

  await page.getByText("Configure", { exact: true }).click();
  await page.getByRole("link", { name: "Automations", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  await page.getByRole("link", { name: "Data model", exact: true }).click();
  await expect(page).toHaveURL(/\/entities\/new$/);
});

test("archived entities stay out of normal home navigation but remain available through management mode", async ({
  page,
}) => {
  const run = createScenarioRun();
  const supabase = createSupabaseTestClient();
  const entity = await createEntity(supabase, run, "Archived Workspace Entity", [
    { slug: "name", name: "Name", type: "text" },
  ]);
  const archiveResult = await supabase
    .from("entity_types")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", DEMO_WORKSPACE_ID)
    .eq("id", entity.id);
  expect(archiveResult.error).toBeNull();

  await page.goto("/");
  await expect(page.getByRole("link", { name: entity.name, exact: true })).toHaveCount(0);
  await page.getByText("Configure", { exact: true }).click();
  await page.getByRole("link", { name: "Archived entities" }).click();
  await expect(page).toHaveURL(/showArchivedEntities=true/);
  await expect(page.getByRole("heading", { name: entity.name, exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Entity navigation" })
      .getByRole("link")
      .filter({ hasText: entity.name }),
  ).toHaveCount(1);
  await expect(page.getByText("Archived", { exact: true }).last()).toBeVisible();
});

type TestUser = { id: string; email: string; password: string };

function email(label: string) {
  return `e2e-nav-${label}-${randomUUID()}@example.test`;
}

async function createNavUser(label: string): Promise<TestUser> {
  const admin = createSupabaseTestClient();
  const password = `Nav-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: email(label),
    password,
    email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create nav test user.");
  return { id: data.user.id, email: data.user.email, password };
}

async function createNavRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length) {
    const { error } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (error) throw new Error(error.message);
  }
  return id;
}

async function signInNavUser(page: Page, user: TestUser) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

test.describe("capability-gated Configure navigation", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a pure worker sees no Configure section; schema.manage and automation.manage each see only their own links", async ({
    page,
  }) => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    const { error: workspaceError } = await admin
      .from("workspaces")
      .insert({ id: workspaceId, name: `E2E Nav ${workspaceId.slice(0, 8)}` });
    expect(workspaceError).toBeNull();

    const workerRole = await createNavRole(workspaceId, "Worker", ["records.operate", "processes.operate"]);
    const schemaRole = await createNavRole(workspaceId, "Schema manager", ["schema.manage"]);
    const automationRole = await createNavRole(workspaceId, "Automation manager", ["automation.manage"]);

    const worker = await createNavUser("worker");
    const schemaManager = await createNavUser("schema");
    const automationManager = await createNavUser("automation");

    const { error: membershipError } = await admin.from("workspace_memberships").insert([
      { workspace_id: workspaceId, user_id: worker.id, role_id: workerRole },
      { workspace_id: workspaceId, user_id: schemaManager.id, role_id: schemaRole },
      { workspace_id: workspaceId, user_id: automationManager.id, role_id: automationRole },
    ]);
    expect(membershipError).toBeNull();

    try {
      await signInNavUser(page, worker);
      await expect(page.getByText("Configure", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Automations", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Data model", exact: true })).toHaveCount(0);

      await page.context().clearCookies();
      await signInNavUser(page, schemaManager);
      await page.getByText("Configure", { exact: true }).click();
      await expect(page.getByRole("link", { name: "Data model", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Archived entities", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Automations", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Processes", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Workspace settings", exact: true })).toHaveCount(0);

      await page.context().clearCookies();
      await signInNavUser(page, automationManager);
      await page.getByText("Configure", { exact: true }).click();
      await expect(page.getByRole("link", { name: "Automations", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Processes", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Data model", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Archived entities", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Workspace settings", exact: true })).toHaveCount(0);
    } finally {
      const { error: cleanupError } = await admin.from("workspaces").delete().eq("id", workspaceId);
      expect(cleanupError).toBeNull();
      for (const user of [worker, schemaManager, automationManager]) {
        await admin.auth.admin.deleteUser(user.id);
      }
    }
  });

  test("?manage=true is canonicalized away for a caller without schema.manage, and unaffected for one with it", async ({
    page,
  }) => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    const { error: workspaceError } = await admin
      .from("workspaces")
      .insert({ id: workspaceId, name: `E2E Nav Manage ${workspaceId.slice(0, 8)}` });
    expect(workspaceError).toBeNull();

    const workerRole = await createNavRole(workspaceId, "Worker", ["records.operate", "processes.operate"]);
    const schemaRole = await createNavRole(workspaceId, "Schema manager", ["schema.manage", "records.operate"]);
    const worker = await createNavUser("worker-manage");
    const schemaManager = await createNavUser("schema-manage");

    const { error: membershipError } = await admin.from("workspace_memberships").insert([
      { workspace_id: workspaceId, user_id: worker.id, role_id: workerRole },
      { workspace_id: workspaceId, user_id: schemaManager.id, role_id: schemaRole },
    ]);
    expect(membershipError).toBeNull();

    const entityId = randomUUID();
    const fieldId = randomUUID();
    const { error: entityError } = await admin.from("entity_types").insert({
      id: entityId, workspace_id: workspaceId, name: "E2E Manage Boundary", slug: `e2e-manage-boundary-${workspaceId.slice(0, 8)}`,
    });
    expect(entityError).toBeNull();
    const { error: fieldError } = await admin.from("field_definitions").insert({
      id: fieldId, workspace_id: workspaceId, entity_type_id: entityId, key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1,
    });
    expect(fieldError).toBeNull();

    try {
      // 1. Pure worker manually requesting ?manage=true: redirected to the
      // canonical (no-manage) URL, never sees schema-management UI, and the
      // normal business-object page still renders correctly.
      await signInNavUser(page, worker);
      await page.goto(`/entities/${entityId}?manage=true`);
      await expect(page).toHaveURL(new RegExp(`/entities/${entityId}$`));
      await expect(page.getByRole("heading", { name: "Entity Settings" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Add Field", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "E2E Manage Boundary", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Manage", exact: true })).toHaveCount(0);

      // 3. The plain (no manage param) entity page is unaffected for the
      // worker: normal read/records view, still no Manage entry point.
      await page.goto(`/entities/${entityId}`);
      await expect(page.getByRole("heading", { name: "E2E Manage Boundary", exact: true })).toBeVisible();
      await expect(page.getByText("Business object", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Manage", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Entity Settings" })).toHaveCount(0);

      // 2. A schema.manage user requesting ?manage=true keeps it and sees
      // the full schema-management surface normally.
      await page.context().clearCookies();
      await signInNavUser(page, schemaManager);
      await page.goto(`/entities/${entityId}?manage=true`);
      await expect(page).toHaveURL(new RegExp(`/entities/${entityId}\\?manage=true$`));
      await expect(page.getByRole("heading", { name: "Entity Settings" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Return to records", exact: true })).toBeVisible();

      // 3. The plain entity page is unaffected for the authorized user too:
      // normal records view, with Manage available to reach the surface
      // above.
      await page.goto(`/entities/${entityId}`);
      await expect(page.getByRole("heading", { name: "E2E Manage Boundary", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Manage", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Entity Settings" })).toHaveCount(0);
    } finally {
      const { error: cleanupError } = await admin.from("workspaces").delete().eq("id", workspaceId);
      expect(cleanupError).toBeNull();
      for (const user of [worker, schemaManager]) {
        await admin.auth.admin.deleteUser(user.id);
      }
    }
  });
});
