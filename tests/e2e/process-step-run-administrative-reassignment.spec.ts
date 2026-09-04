import { randomUUID } from "node:crypto";
import { expect, type Browser, type Locator, type Page, test } from "@playwright/test";
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

// Phase 11.3 Administrative Reassignment Authority: focused E2E coverage
// over the real UI -- administrative control visibility (authorized
// administrator only; not a plain processes.operate holder; not a manager
// with operations.view/managed_user_ids visibility alone), required
// reason, the resulting displayed owner, My Work movement old -> new,
// Activity attribution to the administrator (not the outgoing worker), and
// the control staying hidden while impersonating. RPC-level coverage
// (every rejection path, generation increments, notification dedup,
// impersonation session semantics) lives in
// lib/domain/process-step-run-administrative-reassignment-commit.test.ts;
// this spec only proves the UI wires up to that RPC correctly.

test.describe.configure({ mode: "serial" });

const runs: TestRun[] = [];
const secondMemberUserIds: string[] = [];
const createdRoleIds: string[] = [];

async function createRole(name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin
    .from("workspace_roles")
    .insert({ id: roleId, workspace_id: DEMO_WORKSPACE_ID, name: `${name} ${roleId.slice(0, 8)}` });
  if (roleError) throw new Error(`Unable to create role: ${roleError.message}`);
  createdRoleIds.push(roleId);
  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: DEMO_WORKSPACE_ID, role_id: roleId, capability })));
    if (capabilityError) throw new Error(`Unable to grant capabilities: ${capabilityError.message}`);
  }
  return roleId;
}

async function createMember(label: string, roleId: string) {
  const admin = createSupabaseTestClient();
  const email = `e2e-admin-reassign-${label}-${randomUUID()}@ops-project.test`;
  const password = "E2E-admin-reassign-second-password-2026";

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`Unable to create test member: ${error?.message}`);
  secondMemberUserIds.push(data.user.id);

  const { error: membershipError } = await admin
    .from("workspace_memberships")
    .insert({ workspace_id: DEMO_WORKSPACE_ID, user_id: data.user.id, role_id: roleId });
  if (membershipError) throw new Error(`Unable to add member: ${membershipError.message}`);

  return { userId: data.user.id, email, password };
}

async function createAdministrator(label: string) {
  const admin = createSupabaseTestClient();
  const roleId = await getE2eWorkspaceAdministratorRoleId(admin, DEMO_WORKSPACE_ID);
  return createMember(label, roleId);
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
  if (createdRoleIds.length > 0) {
    const admin = createSupabaseTestClient();
    const { error } = await admin.from("workspace_roles").delete().in("id", createdRoleIds);
    if (error) failures.push(`workspace_roles: ${error.message}`);
  }
  if (failures.length > 0) {
    throw new Error(`process-step-run-administrative-reassignment afterAll cleanup failed:\n${failures.join("\n")}`);
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

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

// browser.newContext() inherits this project's `use` config as its
// defaults -- including storageState, which points at the already-
// authenticated E2E runner session. Both must be overridden explicitly for
// a genuine second-user sign-in: storageState to a truly empty session, and
// baseURL (not inherited either) so a relative goto() resolves at all. See
// the Phase 11.2 test-harness lesson in docs/PROJECT_CONTEXT.md.
async function newAnonymousContext(browser: Browser) {
  return browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    storageState: { cookies: [], origins: [] },
  });
}

test.describe("administrative process step run reassignment", () => {
  test("visible only to an authorized administrator; a plain operator and a manager with visibility-only access do not see it; a reason is required; a successful reassignment updates the owner, moves My Work, and Activity attributes it to the administrator", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const operatorRoleId = await createRole("Operator only", ["processes.operate"]);
    const managerRoleId = await createRole("Manager visibility only", ["operations.view"]);

    const administrator = await createAdministrator("admin");
    const assignee = await createMember("assignee", operatorRoleId);
    const plainOperator = await createMember("operator", operatorRoleId);
    const manager = await createMember("manager", managerRoleId);
    const newAssignee = await createAdministrator("new-assignee");

    const adminClient = createSupabaseTestClient();
    const { error: reportingError } = await adminClient.from("workspace_reporting_relationships").insert({
      workspace_id: DEMO_WORKSPACE_ID,
      manager_user_id: manager.userId,
      report_user_id: assignee.userId,
    });
    if (reportingError) throw new Error(`Unable to set up manager fixture: ${reportingError.message}`);

    const { entity, template } = await createScenario(
      ["Admin Handoff Task"],
      "Administrative Reassign Playbook",
      [assignee.userId],
    );
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Administrative Reassign Record" } });

    const administratorContext = await newAnonymousContext(browser);
    const administratorPage = await administratorContext.newPage();
    const operatorContext = await newAnonymousContext(browser);
    const operatorPage = await operatorContext.newPage();
    const managerContext = await newAnonymousContext(browser);
    const managerPage = await managerContext.newPage();
    const assigneeContext = await newAnonymousContext(browser);
    const assigneePage = await assigneeContext.newPage();

    try {
      await signIn(administratorPage, administrator);
      await startProcess(administratorPage, entity, recordId, template.name);
      const runUrl = administratorPage.url();

      // A plain processes.operate holder and a manager with visibility over
      // the assignee (via managed_user_ids) both see the step but not the
      // administrative control.
      await signIn(operatorPage, plainOperator);
      await operatorPage.goto(runUrl);
      await expect(stepRow(operatorPage, "Admin Handoff Task")).toBeVisible();
      await expect(stepRow(operatorPage, "Admin Handoff Task").getByRole("button", { name: "Reassign on their behalf" })).toHaveCount(0);

      await signIn(managerPage, manager);
      await managerPage.goto(runUrl);
      await expect(stepRow(managerPage, "Admin Handoff Task")).toBeVisible();
      await expect(stepRow(managerPage, "Admin Handoff Task").getByRole("button", { name: "Reassign on their behalf" })).toHaveCount(0);

      // The current assignee still has ordinary self-service Reassign, and
      // no administrative control on their own step.
      await signIn(assigneePage, assignee);
      await assigneePage.goto(runUrl);
      await expect(stepRow(assigneePage, "Admin Handoff Task").getByRole("button", { name: "Reassign" })).toBeVisible();
      await expect(stepRow(assigneePage, "Admin Handoff Task").getByRole("button", { name: "Reassign on their behalf" })).toHaveCount(0);

      // The administrator sees the administrative control.
      const adminReassignButton = stepRow(administratorPage, "Admin Handoff Task").getByRole("button", {
        name: "Reassign on their behalf",
      });
      await expect(adminReassignButton).toBeVisible();
      await adminReassignButton.click();

      const reasonField = stepRow(administratorPage, "Admin Handoff Task").getByLabel("Reason (required)");
      await expect(reasonField).toHaveAttribute("required", "");

      await stepRow(administratorPage, "Admin Handoff Task")
        .getByLabel("Reassign to")
        .selectOption({ label: newAssignee.email });

      // Native required-field validation blocks an empty submit -- the RPC
      // is never reached, so the step stays assigned to the original
      // assignee.
      await stepRow(administratorPage, "Admin Handoff Task")
        .getByRole("button", { name: "Confirm administrative reassignment" })
        .click();
      await expect(stepRow(administratorPage, "Admin Handoff Task")).toContainText(`Assigned to ${assignee.email}`);

      await reasonField.fill("Assignee is unexpectedly unavailable.");
      await stepRow(administratorPage, "Admin Handoff Task")
        .getByRole("button", { name: "Confirm administrative reassignment" })
        .click();

      await expect(stepRow(administratorPage, "Admin Handoff Task")).toContainText(`Assigned to ${newAssignee.email}`);

      // My Work: gone for the outgoing assignee, present for the new one.
      await assigneePage.goto("/my-work");
      await expect(assigneePage.getByText(template.name)).toHaveCount(0);

      const newAssigneeContext = await newAnonymousContext(browser);
      const newAssigneePage = await newAssigneeContext.newPage();
      try {
        await signIn(newAssigneePage, newAssignee);
        await newAssigneePage.goto("/my-work");
        await expect(newAssigneePage.getByText(template.name)).toBeVisible();
      } finally {
        await newAssigneeContext.close();
      }

      // Activity attributes the handoff to the administrator, not the
      // outgoing worker -- and never implies the administrator completed
      // the work.
      await administratorPage.goto(`/entities/${entity.id}/records/${recordId}`);
      await expect(
        administratorPage.getByText(
          new RegExp(
            `Admin Handoff Task reassigned from ${assignee.email} to ${newAssignee.email} by ${administrator.email}`,
          ),
        ),
      ).toBeVisible();
      await expect(administratorPage.getByText(/completed|approved|decided/i)).toHaveCount(0);
    } finally {
      await administratorContext.close();
      await operatorContext.close();
      await managerContext.close();
      await assigneeContext.close();
    }
  });

  test("the administrative control is hidden while the administrator is impersonating another member", async ({
    browser,
  }) => {
    const operatorRoleId = await createRole("Operator only for impersonation check", ["processes.operate"]);
    const administrator = await createAdministrator("impersonating-admin");
    const assignee = await createMember("impersonation-assignee", operatorRoleId);
    const target = await createMember("impersonation-target", operatorRoleId);

    const { entity, template } = await createScenario(
      ["Impersonation Handoff Task"],
      "Administrative Reassign Impersonation Playbook",
      [assignee.userId],
    );
    const recordId = await createEntityRecord({ entity, valuesBySlug: { name: "Impersonation Reassign Record" } });

    const administratorContext = await newAnonymousContext(browser);
    const administratorPage = await administratorContext.newPage();
    try {
      await signIn(administratorPage, administrator);
      await startProcess(administratorPage, entity, recordId, template.name);
      const runUrl = administratorPage.url();

      await expect(
        stepRow(administratorPage, "Impersonation Handoff Task").getByRole("button", {
          name: "Reassign on their behalf",
        }),
      ).toBeVisible();

      await administratorPage.goto("/settings");
      const memberRow = administratorPage.getByLabel(`Role for ${target.email}`).locator("../../..");
      await memberRow.getByRole("button", { name: "Log in as" }).click();
      await administratorPage.waitForURL("/");

      await administratorPage.goto(runUrl);
      await expect(
        stepRow(administratorPage, "Impersonation Handoff Task").getByRole("button", {
          name: "Reassign on their behalf",
        }),
      ).toHaveCount(0);

      await administratorPage.goto("/settings");
      await administratorPage.getByRole("button", { name: "Exit impersonation" }).click();
      await administratorPage.waitForURL("/");

      await administratorPage.goto(runUrl);
      await expect(
        stepRow(administratorPage, "Impersonation Handoff Task").getByRole("button", {
          name: "Reassign on their behalf",
        }),
      ).toBeVisible();
    } finally {
      await administratorContext.close();
    }
  });
});
