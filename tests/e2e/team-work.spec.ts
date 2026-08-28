import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient, deleteE2eUsers } from "./helpers/supabase-test-data";

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial" });

const allCapabilities = [
  "workspace.manage_members",
  "workspace.manage_roles",
  "workspace.manage_organization",
  "workspace.manage_settings",
  "schema.manage",
  "automation.manage",
  "records.operate",
  "processes.operate",
  "operations.view",
];

type TestUser = { id: string; email: string; password: string };
type ManagedScopeRow = {
  user_id: string;
  is_direct_report: boolean;
  team_sources: Array<{ teamId: string; teamName: string }>;
};
type StepRunFixtureRow = {
  id: string;
  workspace_id: string;
  process_run_id: string;
  step_index: number;
  node_type: "human_task" | "approval";
  name: string;
  config: Record<string, never>;
  status: "active" | "pending";
  started_at: string | null;
  assignee_user_id: string;
  assignee_label: string;
  due_at: string | null;
};
type TeamWorkFixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  roles: Record<string, string>;
  users: Record<string, TestUser>;
  teamIds: { alpha: string; beta: string; archived: string };
  recordIds: Record<string, string>;
  runIds: Record<string, string>;
};

let fixture: TeamWorkFixture;

function email(label: string) {
  return `e2e-team-work-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<TestUser> {
  const admin = createSupabaseTestClient();
  const password = `TeamWork-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: email(label), password, email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create Team Work user.");
  return { id: data.user.id, email: data.user.email, password };
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length) {
    const { error } = await admin.from("workspace_role_capabilities").insert(
      capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })),
    );
    if (error) throw new Error(error.message);
  }
  return id;
}

async function authenticatedClient(user: TestUser): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

async function signIn(page: Page, user: TestUser) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

async function createFixture(): Promise<TeamWorkFixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const labels = ["manager", "scope-only", "no-scope", "report", "team", "overlap", "unrelated", "outsider"];
  const users = Object.fromEntries(await Promise.all(labels.map(async (label) => [label, await createUser(label)]))) as Record<string, TestUser>;
  const { error: workspaceError } = await admin.from("workspaces").insert([
    { id: workspaceId, name: `E2E Team Work ${workspaceId.slice(0, 8)}` },
    { id: otherWorkspaceId, name: `E2E Team Work Other ${otherWorkspaceId.slice(0, 8)}` },
  ]);
  if (workspaceError) throw new Error(workspaceError.message);

  const roles = {
    administrator: await createRole(workspaceId, "Administrator", allCapabilities),
    operations: await createRole(workspaceId, "Operations viewer", ["operations.view"]),
    scopeOnly: await createRole(workspaceId, "Scope only", []),
    member: await createRole(workspaceId, "Member", []),
    other: await createRole(otherWorkspaceId, "Other administrator", allCapabilities),
  };
  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: users.manager.id, role_id: roles.operations },
    { workspace_id: workspaceId, user_id: users["scope-only"].id, role_id: roles.scopeOnly },
    { workspace_id: workspaceId, user_id: users["no-scope"].id, role_id: roles.operations },
    { workspace_id: workspaceId, user_id: users.report.id, role_id: roles.member },
    { workspace_id: workspaceId, user_id: users.team.id, role_id: roles.member },
    { workspace_id: workspaceId, user_id: users.overlap.id, role_id: roles.member },
    { workspace_id: workspaceId, user_id: users.unrelated.id, role_id: roles.member },
    { workspace_id: otherWorkspaceId, user_id: users.outsider.id, role_id: roles.other },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const teamIds = { alpha: randomUUID(), beta: randomUUID(), archived: randomUUID() };
  const { error: teamError } = await admin.from("workspace_teams").insert([
    { id: teamIds.alpha, workspace_id: workspaceId, name: "Alpha Team" },
    { id: teamIds.beta, workspace_id: workspaceId, name: "Beta Team" },
    { id: teamIds.archived, workspace_id: workspaceId, name: "Archived Team", archived_at: new Date().toISOString() },
  ]);
  if (teamError) throw new Error(teamError.message);
  const { error: teamMembershipError } = await admin.from("workspace_team_memberships").insert([
    { workspace_id: workspaceId, team_id: teamIds.alpha, user_id: users.manager.id },
    { workspace_id: workspaceId, team_id: teamIds.alpha, user_id: users.team.id },
    { workspace_id: workspaceId, team_id: teamIds.alpha, user_id: users.overlap.id },
    { workspace_id: workspaceId, team_id: teamIds.beta, user_id: users.manager.id },
    { workspace_id: workspaceId, team_id: teamIds.beta, user_id: users.overlap.id },
    { workspace_id: workspaceId, team_id: teamIds.archived, user_id: users.unrelated.id },
  ]);
  if (teamMembershipError) throw new Error(teamMembershipError.message);
  const { error: leadError } = await admin.from("workspace_team_leads").insert([
    { workspace_id: workspaceId, team_id: teamIds.alpha, user_id: users.manager.id },
    { workspace_id: workspaceId, team_id: teamIds.beta, user_id: users.manager.id },
  ]);
  if (leadError) throw new Error(leadError.message);
  const { error: relationshipError } = await admin.from("workspace_reporting_relationships").insert([
    { workspace_id: workspaceId, manager_user_id: users.manager.id, report_user_id: users.report.id, relationship_kind: "primary_manager" },
    { workspace_id: workspaceId, manager_user_id: users.manager.id, report_user_id: users.overlap.id, relationship_kind: "primary_manager" },
    { workspace_id: workspaceId, manager_user_id: users["scope-only"].id, report_user_id: users.team.id, relationship_kind: "primary_manager" },
  ]);
  if (relationshipError) throw new Error(relationshipError.message);

  const entityId = randomUUID();
  const fieldId = randomUUID();
  const templateId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityId, workspace_id: workspaceId, name: "E2E Team Work Record", slug: `e2e-team-work-${workspaceId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);
  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: fieldId, workspace_id: workspaceId, entity_type_id: entityId, key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId, workspace_id: workspaceId, name: "E2E Team Work Process", applies_to_entity_type_id: entityId,
  });
  if (templateError) throw new Error(templateError.message);

  const subjectUsers = ["manager", "report", "team", "overlap", "unrelated"] as const;
  const recordIds = Object.fromEntries(subjectUsers.map((label) => [label, randomUUID()])) as Record<string, string>;
  const runIds = Object.fromEntries(subjectUsers.map((label) => [label, randomUUID()])) as Record<string, string>;
  const now = Date.now();
  const { error: recordError } = await admin.from("entity_records").insert(
    subjectUsers.map((label) => ({
      id: recordIds[label], workspace_id: workspaceId, entity_type_id: entityId, values: { name: `${label} record` },
    })),
  );
  if (recordError) throw new Error(recordError.message);
  const { error: runError } = await admin.from("process_runs").insert(
    subjectUsers.map((label) => ({
      id: runIds[label], workspace_id: workspaceId, process_template_id: templateId,
      process_template_name: "E2E Team Work Process", origin_entity_type_id: entityId,
      origin_record_id: recordIds[label], status: "active", started_at: new Date(now - 60_000).toISOString(),
    })),
  );
  if (runError) throw new Error(runError.message);
  const activeStepRows: StepRunFixtureRow[] = subjectUsers.map((label, index) => ({
    id: randomUUID(), workspace_id: workspaceId, process_run_id: runIds[label], step_index: 1,
    node_type: label === "team" ? "approval" : "human_task", name: `${label} active work`, config: {}, status: "active",
    started_at: new Date(now - 30_000).toISOString(), assignee_user_id: users[label].id, assignee_label: users[label].email,
    due_at: label === "report" ? new Date(now - 60_000).toISOString() : new Date(now + (index + 1) * 60 * 60_000).toISOString(),
  }));
  const upcomingStepId = randomUUID();
  activeStepRows.push({
    id: upcomingStepId, workspace_id: workspaceId, process_run_id: runIds.report, step_index: 2,
    node_type: "human_task", name: "report upcoming work", config: {}, status: "pending", started_at: null,
    assignee_user_id: users.report.id, assignee_label: users.report.email, due_at: null,
  });
  const { error: stepError } = await admin.from("process_step_runs").insert(activeStepRows);
  if (stepError) throw new Error(stepError.message);
  const reportActiveStep = activeStepRows.find((step) => step.process_run_id === runIds.report && step.step_index === 1)!;
  const { error: routeError } = await admin.from("process_step_run_routes").insert({
    workspace_id: workspaceId, process_run_id: runIds.report, source_step_run_id: reportActiveStep.id,
    target_step_run_id: upcomingStepId, priority: 1, condition_config: null, is_default: true, is_parallel: false,
  });
  if (routeError) throw new Error(routeError.message);

  return { workspaceId, otherWorkspaceId, roles, users, teamIds, recordIds, runIds };
}

async function cleanupFixture(current: TeamWorkFixture) {
  const admin = createSupabaseTestClient();
  const { error: workspaceError } = await admin.from("workspaces").delete().in("id", [current.workspaceId, current.otherWorkspaceId]);
  if (workspaceError) throw new Error(workspaceError.message);
  await deleteE2eUsers(
    Object.values(current.users).map((user) => user.id),
    admin,
  );
}

async function cleanupStaleFixtures() {
  const admin = createSupabaseTestClient();
  const { data: workspaces, error } = await admin.from("workspaces").select("id").ilike("name", "E2E Team Work%");
  if (error) throw new Error(error.message);
  if (workspaces?.length) await admin.from("workspaces").delete().in("id", workspaces.map((workspace) => workspace.id));
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  await Promise.all((data?.users ?? [])
    .filter((user) => user.email?.startsWith("e2e-team-work-"))
    .map((user) => admin.auth.admin.deleteUser(user.id)));
}

test.beforeAll(async () => {
  await cleanupStaleFixtures();
  fixture = await createFixture();
});
test.afterAll(async () => { if (fixture) await cleanupFixture(fixture); });

test("enforces operations.view and derives a deduplicated current management scope", async () => {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const anonymous = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const manager = await authenticatedClient(fixture.users.manager);
  const scopeOnly = await authenticatedClient(fixture.users["scope-only"]);
  const noScope = await authenticatedClient(fixture.users["no-scope"]);

  const denied = await scopeOnly.rpc("list_managed_people_context_authorized", { p_workspace_id: fixture.workspaceId });
  expect(denied.error?.message).toContain("operations.view");
  const anonymousCall = await anonymous.rpc("list_managed_people_context_authorized", { p_workspace_id: fixture.workspaceId });
  expect(anonymousCall.error).not.toBeNull();
  const noScopeResult = await noScope.rpc("list_managed_people_context_authorized", { p_workspace_id: fixture.workspaceId });
  expect(noScopeResult.error).toBeNull();
  expect(noScopeResult.data).toEqual([]);
  const scope = await manager.rpc("list_managed_people_context_authorized", { p_workspace_id: fixture.workspaceId });
  expect(scope.error).toBeNull();
  const scopedPeople = (scope.data ?? []) as ManagedScopeRow[];
  expect(scopedPeople.map((person) => person.user_id).sort()).toEqual([
    fixture.users.overlap.id,
    fixture.users.report.id,
    fixture.users.team.id,
  ].sort());
  const overlap = scopedPeople.find((person) => person.user_id === fixture.users.overlap.id);
  expect(overlap).toMatchObject({ is_direct_report: true });
  expect(overlap?.team_sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ teamId: fixture.teamIds.alpha, teamName: "Alpha Team" }),
    expect.objectContaining({ teamId: fixture.teamIds.beta, teamName: "Beta Team" }),
  ]));
  expect(scopedPeople.some((person) => person.user_id === fixture.users.manager.id)).toBe(false);
  expect(scopedPeople.some((person) => person.user_id === fixture.users.unrelated.id)).toBe(false);
  const crossWorkspace = await manager.rpc("list_managed_people_context_authorized", { p_workspace_id: fixture.otherWorkspaceId });
  expect(crossWorkspace.error?.message).toContain("Workspace access denied");
});

test("renders Team Work through existing process and record drill-ins without action controls", async ({ page }) => {
  await signIn(page, fixture.users.manager);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  const teamWorkNavigation = page.getByRole("link", { name: "Team Work", exact: true });
  await expect(teamWorkNavigation).toBeVisible();
  await teamWorkNavigation.click();
  await expect(page.getByRole("heading", { name: "Team Work" })).toBeVisible();
  const workTables = page.locator("tbody");
  await expect(workTables.getByText(fixture.users.report.email).first()).toBeVisible();
  await expect(workTables.getByText(fixture.users.team.email).first()).toBeVisible();
  await expect(workTables.getByText(fixture.users.overlap.email).first()).toBeVisible();
  await expect(workTables.getByText(fixture.users.unrelated.email)).toHaveCount(0);
  await expect(page.getByText("report active work")).toBeVisible();
  await expect(page.getByText("report upcoming work")).toBeVisible();
  await expect(page.getByText("Approval")).toBeVisible();
  await expect(page.getByRole("button", { name: /complete|approve|reject/i })).toHaveCount(0);
  await page.getByRole("link", { name: "View process" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/process-runs/${fixture.runIds.report}|/process-runs/`));
  await page.goto(`/team-work?scope=team&id=${fixture.teamIds.beta}`);
  await expect(page.locator("tbody").getByText(fixture.users.overlap.email)).toBeVisible();
  await expect(page.locator("tbody").getByText(fixture.users.report.email)).toHaveCount(0);
  await page.goto(`/team-work?scope=team&id=${randomUUID()}`);
  await expect(page).toHaveURL(/\/team-work$/);
  await expect(page.locator("tbody").getByText(fixture.users.unrelated.email)).toHaveCount(0);
  await expect(page.locator("tbody").getByText(fixture.users.report.email).first()).toBeVisible();
  await page.goto(`/team-work?person=${fixture.users.team.id}`);
  await expect(page.locator("tbody").getByText(fixture.users.team.email)).toBeVisible();
  await expect(page.locator("tbody").getByText(fixture.users.report.email)).toHaveCount(0);
});

test("applies organization and role changes immediately without changing My Work", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const manager = await authenticatedClient(fixture.users.manager);
  const myWorkBefore = await manager.from("process_step_runs").select("id").eq("workspace_id", fixture.workspaceId).eq("assignee_user_id", fixture.users.manager.id);
  expect(myWorkBefore.error).toBeNull();

  const { error: clearRelationshipError } = await admin.from("workspace_reporting_relationships")
    .delete().eq("workspace_id", fixture.workspaceId).eq("manager_user_id", fixture.users.manager.id).eq("report_user_id", fixture.users.report.id);
  expect(clearRelationshipError).toBeNull();
  const afterOrgEdit = await manager.rpc("list_managed_people_context_authorized", { p_workspace_id: fixture.workspaceId });
  expect(((afterOrgEdit.data ?? []) as ManagedScopeRow[]).some(
    (person) => person.user_id === fixture.users.report.id,
  )).toBe(false);
  const { error: restoreRelationshipError } = await admin.from("workspace_reporting_relationships").insert({
    workspace_id: fixture.workspaceId, manager_user_id: fixture.users.manager.id, report_user_id: fixture.users.report.id, relationship_kind: "primary_manager",
  });
  expect(restoreRelationshipError).toBeNull();

  const { error: removeCapabilityError } = await admin.from("workspace_role_capabilities")
    .delete().eq("workspace_id", fixture.workspaceId).eq("role_id", fixture.roles.operations).eq("capability", "operations.view");
  expect(removeCapabilityError).toBeNull();
  const afterRoleEdit = await manager.rpc("list_managed_people_context_authorized", { p_workspace_id: fixture.workspaceId });
  expect(afterRoleEdit.error?.message).toContain("operations.view");
  const { error: restoreCapabilityError } = await admin.from("workspace_role_capabilities").insert({
    workspace_id: fixture.workspaceId, role_id: fixture.roles.operations, capability: "operations.view",
  });
  expect(restoreCapabilityError).toBeNull();

  await signIn(page, fixture.users["no-scope"]);
  await expect(page.getByRole("link", { name: "Team Work", exact: true })).toHaveCount(0);
  await page.goto("/team-work");
  await expect(page).toHaveURL(/\/$/);
  const myWorkAfter = await manager.from("process_step_runs").select("id").eq("workspace_id", fixture.workspaceId).eq("assignee_user_id", fixture.users.manager.id);
  expect(myWorkAfter.data).toEqual(myWorkBefore.data);
});
