import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireE2eEnv } from "./helpers/env";
import { createSupabaseTestClient } from "./helpers/supabase-test-data";

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

type StepRow = {
  id: string;
  workspace_id: string;
  process_run_id: string;
  source_node_id?: string;
  step_index: number;
  node_type: "human_task" | "approval" | "wait" | "condition_wait" | "action";
  name: string;
  config: Record<string, unknown>;
  status: "active" | "completed";
  started_at: string;
  completed_at: string | null;
  due_at: string | null;
  assignee_user_id: string | null;
  assignee_label: string | null;
  action_result: Record<string, unknown> | null;
  resume_at?: string;
};

type AnalyticsFixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  roles: Record<string, string>;
  users: Record<string, TestUser>;
  teamIds: { alpha: string; beta: string };
  templateId: string;
  recordId: string;
  entityId: string;
};

let fixture: AnalyticsFixture;

function email(label: string) {
  return `e2e-analytics-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<TestUser> {
  const admin = createSupabaseTestClient();
  const password = `Analytics-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: email(label),
    password,
    email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create analytics user.");
  return { id: data.user.id, email: data.user.email, password };
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
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

function secondsAgo(seconds: number) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function daysAgo(days: number) {
  return secondsAgo(days * 86400);
}

async function insertRun({
  id,
  workspaceId,
  templateId,
  recordId,
  entityId,
  status,
  startedAt,
  completedAt,
}: {
  id: string;
  workspaceId: string;
  templateId: string;
  recordId: string;
  entityId: string;
  status: "active" | "completed";
  startedAt: string;
  completedAt: string | null;
}) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("process_runs").insert({
    id,
    workspace_id: workspaceId,
    process_template_id: templateId,
    process_template_name: "E2E Analytics Process",
    origin_entity_type_id: entityId,
    origin_record_id: recordId,
    status,
    started_at: startedAt,
    completed_at: completedAt,
  });
  if (error) throw new Error(error.message);
}

async function createFixture(): Promise<AnalyticsFixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const labels = ["manager", "no-capability", "no-scope", "reportOnly", "overlap", "teamAOnly", "teamBOnly", "outsider"];
  const users = Object.fromEntries(
    await Promise.all(labels.map(async (label) => [label, await createUser(label)])),
  ) as Record<string, TestUser>;

  const { error: workspaceError } = await admin.from("workspaces").insert([
    { id: workspaceId, name: `E2E Analytics ${workspaceId.slice(0, 8)}` },
    { id: otherWorkspaceId, name: `E2E Analytics Other ${otherWorkspaceId.slice(0, 8)}` },
  ]);
  if (workspaceError) throw new Error(workspaceError.message);

  const roles = {
    operations: await createRole(workspaceId, "Operations viewer", ["operations.view"]),
    noCapability: await createRole(workspaceId, "No capability", []),
    member: await createRole(workspaceId, "Member", []),
    other: await createRole(otherWorkspaceId, "Other administrator", allCapabilities),
  };
  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: users.manager.id, role_id: roles.operations },
    { workspace_id: workspaceId, user_id: users["no-capability"].id, role_id: roles.noCapability },
    { workspace_id: workspaceId, user_id: users["no-scope"].id, role_id: roles.operations },
    { workspace_id: workspaceId, user_id: users.reportOnly.id, role_id: roles.member },
    { workspace_id: workspaceId, user_id: users.overlap.id, role_id: roles.member },
    { workspace_id: workspaceId, user_id: users.teamAOnly.id, role_id: roles.member },
    { workspace_id: workspaceId, user_id: users.teamBOnly.id, role_id: roles.member },
    { workspace_id: otherWorkspaceId, user_id: users.outsider.id, role_id: roles.other },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const teamIds = { alpha: randomUUID(), beta: randomUUID() };
  const { error: teamError } = await admin.from("workspace_teams").insert([
    { id: teamIds.alpha, workspace_id: workspaceId, name: "Analytics Alpha Team" },
    { id: teamIds.beta, workspace_id: workspaceId, name: "Analytics Beta Team" },
  ]);
  if (teamError) throw new Error(teamError.message);
  const { error: teamMembershipError } = await admin.from("workspace_team_memberships").insert([
    { workspace_id: workspaceId, team_id: teamIds.alpha, user_id: users.manager.id },
    { workspace_id: workspaceId, team_id: teamIds.alpha, user_id: users.overlap.id },
    { workspace_id: workspaceId, team_id: teamIds.alpha, user_id: users.teamAOnly.id },
    { workspace_id: workspaceId, team_id: teamIds.beta, user_id: users.manager.id },
    { workspace_id: workspaceId, team_id: teamIds.beta, user_id: users.overlap.id },
    { workspace_id: workspaceId, team_id: teamIds.beta, user_id: users.teamBOnly.id },
  ]);
  if (teamMembershipError) throw new Error(teamMembershipError.message);
  const { error: leadError } = await admin.from("workspace_team_leads").insert([
    { workspace_id: workspaceId, team_id: teamIds.alpha, user_id: users.manager.id },
    { workspace_id: workspaceId, team_id: teamIds.beta, user_id: users.manager.id },
  ]);
  if (leadError) throw new Error(leadError.message);
  const { error: relationshipError } = await admin.from("workspace_reporting_relationships").insert({
    workspace_id: workspaceId,
    manager_user_id: users.manager.id,
    report_user_id: users.reportOnly.id,
    relationship_kind: "primary_manager",
  });
  if (relationshipError) throw new Error(relationshipError.message);

  const entityId = randomUUID();
  const fieldId = randomUUID();
  const templateId = randomUUID();
  const recordId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityId,
    workspace_id: workspaceId,
    name: "E2E Analytics Record",
    slug: `e2e-analytics-${workspaceId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);
  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: fieldId,
    workspace_id: workspaceId,
    entity_type_id: entityId,
    key: "name",
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);
  const { error: templateError } = await admin.from("process_templates").insert({
    id: templateId,
    workspace_id: workspaceId,
    name: "E2E Analytics Process",
    applies_to_entity_type_id: entityId,
  });
  if (templateError) throw new Error(templateError.message);
  const { error: recordError } = await admin.from("entity_records").insert({
    id: recordId,
    workspace_id: workspaceId,
    entity_type_id: entityId,
    values: { name: "Analytics fixture record" },
  });
  if (recordError) throw new Error(recordError.message);

  return { workspaceId, otherWorkspaceId, roles, users, teamIds, templateId, recordId, entityId };
}

async function cleanupFixture(current: AnalyticsFixture) {
  const admin = createSupabaseTestClient();
  const { error: workspaceError } = await admin
    .from("workspaces")
    .delete()
    .in("id", [current.workspaceId, current.otherWorkspaceId]);
  if (workspaceError) throw new Error(workspaceError.message);
  for (const user of Object.values(current.users)) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(error.message);
  }
}

async function cleanupStaleFixtures() {
  const admin = createSupabaseTestClient();
  const { data: workspaces, error } = await admin.from("workspaces").select("id").ilike("name", "E2E Analytics%");
  if (error) throw new Error(error.message);
  if (workspaces?.length) await admin.from("workspaces").delete().in("id", workspaces.map((workspace) => workspace.id));
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  await Promise.all(
    (data?.users ?? [])
      .filter((user) => user.email?.startsWith("e2e-analytics-"))
      .map((user) => admin.auth.admin.deleteUser(user.id)),
  );
}

test.beforeAll(async () => {
  await cleanupStaleFixtures();
  fixture = await createFixture();

  const admin = createSupabaseTestClient();
  const runIds = {
    median: randomUUID(),
    system: randomUUID(),
    timeliness: randomUUID(),
    active: randomUUID(),
    cycleA: randomUUID(),
    cycleB: randomUUID(),
  };
  // process_runs enforces at most one *active* run per (template, origin
  // record) at the database level (process_runs_one_active_per_origin_idx),
  // so each active run below needs its own origin record. The two
  // completed runs are fine sharing fixture.recordId with each other.
  const activeRunRecordIds = {
    median: randomUUID(),
    system: randomUUID(),
    timeliness: randomUUID(),
    active: randomUUID(),
  };
  const { error: extraRecordError } = await admin.from("entity_records").insert(
    Object.values(activeRunRecordIds).map((id) => ({
      id, workspace_id: fixture.workspaceId, entity_type_id: fixture.entityId, values: { name: "Analytics fixture record" },
    })),
  );
  if (extraRecordError) throw new Error(extraRecordError.message);

  await Promise.all([
    insertRun({
      id: runIds.median, workspaceId: fixture.workspaceId, templateId: fixture.templateId,
      recordId: activeRunRecordIds.median, entityId: fixture.entityId, status: "active", startedAt: daysAgo(10), completedAt: null,
    }),
    insertRun({
      id: runIds.system, workspaceId: fixture.workspaceId, templateId: fixture.templateId,
      recordId: activeRunRecordIds.system, entityId: fixture.entityId, status: "active", startedAt: daysAgo(10), completedAt: null,
    }),
    insertRun({
      id: runIds.timeliness, workspaceId: fixture.workspaceId, templateId: fixture.templateId,
      recordId: activeRunRecordIds.timeliness, entityId: fixture.entityId, status: "active", startedAt: daysAgo(10), completedAt: null,
    }),
    insertRun({
      id: runIds.active, workspaceId: fixture.workspaceId, templateId: fixture.templateId,
      recordId: activeRunRecordIds.active, entityId: fixture.entityId, status: "active", startedAt: daysAgo(10), completedAt: null,
    }),
    insertRun({
      id: runIds.cycleA, workspaceId: fixture.workspaceId, templateId: fixture.templateId,
      recordId: fixture.recordId, entityId: fixture.entityId, status: "completed",
      startedAt: secondsAgo(5 * 86400 + 2000), completedAt: daysAgo(5),
    }),
    insertRun({
      id: runIds.cycleB, workspaceId: fixture.workspaceId, templateId: fixture.templateId,
      recordId: fixture.recordId, entityId: fixture.entityId, status: "completed",
      startedAt: secondsAgo(5 * 86400 + 4000), completedAt: daysAgo(5),
    }),
  ]);

  const rows: StepRow[] = [
    // Three completed human_task steps with clean durations: median = 200s.
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.median, step_index: 1,
      node_type: "human_task", name: "Median step 1", config: {}, status: "completed",
      started_at: secondsAgo(5 * 86400 + 100), completed_at: daysAgo(5), due_at: null,
      assignee_user_id: fixture.users.reportOnly.id, assignee_label: fixture.users.reportOnly.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.median, step_index: 2,
      node_type: "human_task", name: "Median step 2", config: {}, status: "completed",
      started_at: secondsAgo(6 * 86400 + 200), completed_at: daysAgo(6), due_at: null,
      assignee_user_id: fixture.users.overlap.id, assignee_label: fixture.users.overlap.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.median, step_index: 3,
      node_type: "human_task", name: "Median step 3", config: {}, status: "completed",
      started_at: secondsAgo(7 * 86400 + 300), completed_at: daysAgo(7), due_at: null,
      assignee_user_id: fixture.users.teamAOnly.id, assignee_label: fixture.users.teamAOnly.email, action_result: null,
    },
    // Outside the 30-day window but inside 90 days -- period-boundary check.
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.median, step_index: 4,
      node_type: "human_task", name: "Boundary step", config: {}, status: "completed",
      started_at: secondsAgo(60 * 86400 + 50), completed_at: daysAgo(60), due_at: null,
      assignee_user_id: fixture.users.teamBOnly.id, assignee_label: fixture.users.teamBOnly.email, action_result: null,
    },
    // Two completed approvals: median turnaround = 500s.
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.median, step_index: 5,
      node_type: "approval", name: "Approval 1", config: {}, status: "completed",
      started_at: secondsAgo(5 * 86400 + 400), completed_at: daysAgo(5), due_at: null,
      assignee_user_id: fixture.users.overlap.id, assignee_label: fixture.users.overlap.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.median, step_index: 6,
      node_type: "approval", name: "Approval 2", config: {}, status: "completed",
      started_at: secondsAgo(6 * 86400 + 600), completed_at: daysAgo(6), due_at: null,
      assignee_user_id: fixture.users.teamAOnly.id, assignee_label: fixture.users.teamAOnly.email, action_result: null,
    },
    // Required so the "median" run is in the manager's scope via a scoped assignee.
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.median, step_index: 7,
      node_type: "human_task", name: "Scope anchor", config: {}, status: "active",
      started_at: daysAgo(10), completed_at: null, due_at: null,
      assignee_user_id: fixture.users.reportOnly.id, assignee_label: fixture.users.reportOnly.email, action_result: null,
    },
    // System-type steps: wait/condition_wait dwell time should surface in
    // bottleneck; action should not appear in bottleneck or throughput at
    // all. Wait/condition_wait/action steps structurally have no assignee.
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.system, step_index: 1,
      source_node_id: "11111111-1111-4111-8111-111111111111",
      node_type: "wait", name: "Wait for confirmation", config: {}, status: "completed",
      started_at: secondsAgo(5 * 86400 + 1000), completed_at: daysAgo(5), due_at: null,
      assignee_user_id: null, assignee_label: null, action_result: null, resume_at: daysAgo(5),
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.system, step_index: 2,
      source_node_id: "22222222-2222-4222-8222-222222222222",
      node_type: "condition_wait", name: "Wait for condition", config: {}, status: "completed",
      started_at: secondsAgo(5 * 86400 + 1500), completed_at: daysAgo(5), due_at: null,
      assignee_user_id: null, assignee_label: null, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.system, step_index: 3,
      source_node_id: "33333333-3333-4333-8333-333333333333",
      node_type: "action", name: "Automated action", config: { actionConfig: null }, status: "completed",
      started_at: secondsAgo(5 * 86400 + 5), completed_at: daysAgo(5), due_at: null,
      assignee_user_id: null, assignee_label: null, action_result: { status: "succeeded" },
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.system, step_index: 4,
      node_type: "human_task", name: "System run scope anchor", config: {}, status: "active",
      started_at: daysAgo(10), completed_at: null, due_at: null,
      assignee_user_id: fixture.users.reportOnly.id, assignee_label: fixture.users.reportOnly.email, action_result: null,
    },
    // Timeliness: one on-time, one late, one undated (excluded from the
    // on-time/late split but still counted in throughput).
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.timeliness, step_index: 1,
      node_type: "human_task", name: "On-time completion", config: {}, status: "completed",
      started_at: secondsAgo(86400 + 200), completed_at: daysAgo(1), due_at: secondsAgo(86400 - 100),
      assignee_user_id: fixture.users.teamAOnly.id, assignee_label: fixture.users.teamAOnly.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.timeliness, step_index: 2,
      node_type: "human_task", name: "Late completion", config: {}, status: "completed",
      started_at: secondsAgo(86400 + 200), completed_at: daysAgo(1), due_at: secondsAgo(86400 + 100),
      assignee_user_id: fixture.users.teamBOnly.id, assignee_label: fixture.users.teamBOnly.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.timeliness, step_index: 3,
      node_type: "human_task", name: "Undated completion", config: {}, status: "completed",
      started_at: secondsAgo(86400 + 200), completed_at: daysAgo(1), due_at: null,
      assignee_user_id: fixture.users.overlap.id, assignee_label: fixture.users.overlap.email, action_result: null,
    },
    // Active work: overdue-rate denominator excludes the undated step.
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.active, step_index: 1,
      node_type: "human_task", name: "Overdue active task", config: {}, status: "active",
      started_at: daysAgo(1), completed_at: null, due_at: secondsAgo(3600),
      assignee_user_id: fixture.users.reportOnly.id, assignee_label: fixture.users.reportOnly.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.active, step_index: 2,
      node_type: "human_task", name: "On-track active task", config: {}, status: "active",
      started_at: daysAgo(1), completed_at: null, due_at: new Date(Date.now() + 3600_000).toISOString(),
      assignee_user_id: fixture.users.overlap.id, assignee_label: fixture.users.overlap.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.active, step_index: 3,
      node_type: "human_task", name: "Undated active task", config: {}, status: "active",
      started_at: daysAgo(1), completed_at: null, due_at: null,
      assignee_user_id: fixture.users.teamAOnly.id, assignee_label: fixture.users.teamAOnly.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.active, step_index: 4,
      node_type: "approval", name: "Overdue active approval", config: {}, status: "active",
      started_at: daysAgo(1), completed_at: null, due_at: secondsAgo(7200),
      assignee_user_id: fixture.users.teamBOnly.id, assignee_label: fixture.users.teamBOnly.email, action_result: null,
    },
    // Scope-anchoring steps for the two cycle-time runs (wait type, so they
    // don't pollute the human_task/approval median dataset).
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.cycleA, step_index: 1,
      node_type: "wait", name: "Cycle A anchor", config: {}, status: "completed",
      started_at: secondsAgo(5 * 86400 + 2000), completed_at: daysAgo(5), due_at: null,
      assignee_user_id: null, assignee_label: null, action_result: null, resume_at: daysAgo(5),
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.cycleB, step_index: 1,
      node_type: "wait", name: "Cycle B anchor", config: {}, status: "completed",
      started_at: secondsAgo(5 * 86400 + 4000), completed_at: daysAgo(5), due_at: null,
      assignee_user_id: null, assignee_label: null, action_result: null, resume_at: daysAgo(5),
    },
  ];
  // The scope-anchor and cycle-anchor "wait" steps are not truly assigned
  // to anyone, but they must still belong to a run a scoped person touches.
  // Give each wait/condition_wait/action row's run a scoped human_task too
  // (already true for system run's step 4); cycleA/cycleB need one as well.
  const cycleAnchors: StepRow[] = [
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.cycleA, step_index: 2,
      node_type: "human_task", name: "Cycle A scope anchor", config: {}, status: "active",
      started_at: daysAgo(10), completed_at: null, due_at: null,
      assignee_user_id: fixture.users.reportOnly.id, assignee_label: fixture.users.reportOnly.email, action_result: null,
    },
    {
      id: randomUUID(), workspace_id: fixture.workspaceId, process_run_id: runIds.cycleB, step_index: 2,
      node_type: "human_task", name: "Cycle B scope anchor", config: {}, status: "active",
      started_at: daysAgo(10), completed_at: null, due_at: null,
      assignee_user_id: fixture.users.reportOnly.id, assignee_label: fixture.users.reportOnly.email, action_result: null,
    },
  ];

  const { error: stepError } = await admin.from("process_step_runs").insert([...rows, ...cycleAnchors]);
  if (stepError) throw new Error(stepError.message);
});

test.afterAll(async () => {
  if (fixture) await cleanupFixture(fixture);
});

test("requires operations.view and non-empty scope; scope matches Team Work exactly; rejects cross-workspace", async () => {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const anonymous = createClient(supabaseUrl, supabasePublishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const manager = await authenticatedClient(fixture.users.manager);
  const noCapability = await authenticatedClient(fixture.users["no-capability"]);
  const noScope = await authenticatedClient(fixture.users["no-scope"]);

  for (const rpc of [
    "get_operational_summary_authorized",
    "get_throughput_trend_authorized",
    "get_bottleneck_metrics_authorized",
    "get_workload_by_person_authorized",
    "get_workload_by_team_authorized",
  ]) {
    const denied = await noCapability.rpc(rpc, { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
    expect(denied.error?.message).toContain("operations.view");
    const anonymousCall = await anonymous.rpc(rpc, { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
    expect(anonymousCall.error).not.toBeNull();
    const crossWorkspace = await manager.rpc(rpc, { p_workspace_id: fixture.otherWorkspaceId, p_period_days: 30 });
    expect(crossWorkspace.error?.message).toContain("Workspace access denied");
  }

  const noScopeSummary = await noScope.rpc("get_operational_summary_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
  expect(noScopeSummary.error).toBeNull();
  expect(noScopeSummary.data[0]).toMatchObject({ active_human_tasks: 0, active_approvals: 0, completed_human_work_steps: 0 });

  const teamWorkScope = await manager.rpc("list_managed_people_context_authorized", { p_workspace_id: fixture.workspaceId });
  const analyticsScope = await manager.rpc("get_workload_by_person_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
  expect(teamWorkScope.error).toBeNull();
  expect(analyticsScope.error).toBeNull();
  const teamWorkIds = (teamWorkScope.data as Array<{ user_id: string }>).map((row) => row.user_id).sort();
  const analyticsIds = (analyticsScope.data as Array<{ user_id: string }>).map((row) => row.user_id).sort();
  expect(analyticsIds).toEqual(teamWorkIds);
  expect(analyticsIds).toEqual([
    fixture.users.overlap.id,
    fixture.users.reportOnly.id,
    fixture.users.teamAOnly.id,
    fixture.users.teamBOnly.id,
  ].sort());
});

test("throughput counts only completed human_task/approval steps; runs are reported separately; system/action nodes never inflate it", async () => {
  const manager = await authenticatedClient(fixture.users.manager);
  const summary = await manager.rpc("get_operational_summary_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
  expect(summary.error).toBeNull();
  const row = summary.data[0];
  // 6 completed human_task rows (3 median + on-time + late + undated) plus
  // 2 completed approval rows, all within 30 days -- the throughput
  // definition counts human_task and approval together, nothing else.
  expect(row.completed_human_work_steps).toBe(6 + 2);
  expect(row.completed_runs).toBe(2);
  // Full 30-day duration set: [100,200,300,400,600,200,200,200] -> median 200.
  expect(row.median_step_duration_seconds).toBeCloseTo(200, 0);
  expect(row.median_approval_turnaround_seconds).toBeCloseTo(500, 0);
  expect(row.median_cycle_time_seconds).toBeCloseTo(3000, 0);
});

test("bottleneck dwell analysis includes wait/condition_wait but excludes action and non-human system routing", async () => {
  const manager = await authenticatedClient(fixture.users.manager);
  const bottlenecks = await manager.rpc("get_bottleneck_metrics_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
  expect(bottlenecks.error).toBeNull();
  const rows = bottlenecks.data as Array<{ node_type: string; node_name: string; median_duration_seconds: number }>;
  const wait = rows.find((entry) => entry.node_name === "Wait for confirmation");
  const conditionWait = rows.find((entry) => entry.node_name === "Wait for condition");
  expect(wait).toBeTruthy();
  expect(wait?.node_type).toBe("wait");
  expect(wait?.median_duration_seconds).toBeCloseTo(1000, 0);
  expect(conditionWait).toBeTruthy();
  expect(conditionWait?.median_duration_seconds).toBeCloseTo(1500, 0);
  expect(rows.some((entry) => entry.node_name === "Automated action")).toBe(false);
  expect(rows.some((entry) => entry.node_type === "action")).toBe(false);
});

test("overdue and overdue-rate exclude undated work from the denominator", async () => {
  const manager = await authenticatedClient(fixture.users.manager);
  const summary = await manager.rpc("get_operational_summary_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
  expect(summary.error).toBeNull();
  const row = summary.data[0];
  // Active human_task/approval: overdue task, on-track task, undated task,
  // overdue approval, plus the 4 "scope anchor" active human_task rows
  // (median/system/cycleA/cycleB runs, all undated). Overdue = 2 (task +
  // approval). Dated = 3 (excludes the 4 undated anchors + 1 undated active
  // task). Rate = 2/3.
  expect(row.active_human_tasks).toBe(4 + 3);
  expect(row.active_approvals).toBe(1);
  expect(row.overdue_count).toBe(2);
  expect(row.overdue_rate).toBeCloseTo(2 / 3, 3);
});

test("completed-in-period respects the rolling 7/30/90-day window", async () => {
  const manager = await authenticatedClient(fixture.users.manager);
  const period30 = await manager.rpc("get_operational_summary_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
  const period90 = await manager.rpc("get_operational_summary_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 90 });
  expect(period30.data[0].completed_human_work_steps).toBe(8);
  expect(period90.data[0].completed_human_work_steps).toBe(9);
  // The full completed human_task/approval duration set for 30 days is
  // [100,200,300,400,600,200,200,200] -> median 200. Adding the 90-day-only
  // boundary step (50s) gives [50,100,200,200,200,200,300,400,600] -> the
  // median (5th of 9) is still 200 -- the count changes (8 -> 9) even
  // though this particular dataset's median doesn't.
  expect(period30.data[0].median_step_duration_seconds).toBeCloseTo(200, 0);
  expect(period90.data[0].median_step_duration_seconds).toBeCloseTo(200, 0);
  const rejected = await manager.rpc("get_operational_summary_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 14 });
  expect(rejected.error?.message).toContain("Unsupported analytics period");
});

test("timeliness trend reports on-time vs late completions, not a reconstructed overdue history", async () => {
  const manager = await authenticatedClient(fixture.users.manager);
  const trend = await manager.rpc("get_throughput_trend_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 7 });
  expect(trend.error).toBeNull();
  const points = trend.data as Array<{ on_time_completions: number; late_completions: number; completed_human_work_steps: number }>;
  const totals = points.reduce(
    (acc, point) => ({
      onTime: acc.onTime + point.on_time_completions,
      late: acc.late + point.late_completions,
      completed: acc.completed + point.completed_human_work_steps,
    }),
    { onTime: 0, late: 0, completed: 0 },
  );
  expect(totals.onTime).toBe(1);
  expect(totals.late).toBe(1);
  // The undated completion is not on-time or late, but still counts toward
  // throughput.
  expect(totals.completed).toBeGreaterThanOrEqual(3);
});

test("team workload rows may overlap and are never summed into the portfolio total", async () => {
  const manager = await authenticatedClient(fixture.users.manager);
  const byPerson = await manager.rpc("get_workload_by_person_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
  const byTeam = await manager.rpc("get_workload_by_team_authorized", { p_workspace_id: fixture.workspaceId, p_period_days: 30 });
  expect(byPerson.error).toBeNull();
  expect(byTeam.error).toBeNull();

  type PersonRow = { user_id: string; active_human_tasks: number; active_approvals: number };
  type TeamRow = { team_name: string; active_human_tasks: number; active_approvals: number };
  const people = byPerson.data as PersonRow[];
  const teams = byTeam.data as TeamRow[];

  // fixture.reportOnly is a direct report but on no team, so comparing
  // *all* person rows to *all* team rows would just show reportOnly's
  // work is absent from any team row -- not the overlap signal this test
  // wants. Isolate it: sum only the person rows for people who belong to
  // at least one led team (overlap, teamAOnly, teamBOnly), each counted
  // once, against the team-row sum, where fixture.users.overlap is
  // counted once per team (twice total).
  const teamMemberIds = new Set([fixture.users.overlap.id, fixture.users.teamAOnly.id, fixture.users.teamBOnly.id]);
  const personTotalForTeamMembers = people
    .filter((row) => teamMemberIds.has(row.user_id))
    .reduce((sum, row) => sum + row.active_human_tasks + row.active_approvals, 0);
  const teamTotal = teams.reduce((sum, row) => sum + row.active_human_tasks + row.active_approvals, 0);
  expect(personTotalForTeamMembers).toBe(3); // overlap (1) + teamAOnly (1) + teamBOnly (1), each counted once
  expect(teamTotal).toBe(4); // alpha (overlap 1 + teamAOnly 1) + beta (overlap 1 + teamBOnly 1) -- overlap counted twice
  expect(teamTotal).toBeGreaterThan(personTotalForTeamMembers);
  expect(teams.map((row) => row.team_name).sort()).toEqual(["Analytics Alpha Team", "Analytics Beta Team"]);
});

test("renders through existing Team Work drill-ins, with the disclaimer visible and no ranking or performance language", async ({ page }) => {
  await signIn(page, fixture.users.manager);
  const analyticsNav = page.getByRole("link", { name: "Analytics", exact: true });
  await expect(analyticsNav).toBeVisible();
  await analyticsNav.click();
  await expect(page.getByRole("heading", { name: "Operational Analytics" })).toBeVisible();
  await expect(page.getByText(/current reporting structure/i)).toBeVisible();
  await expect(page.getByText(/not a performance or efficiency score/i)).toBeVisible();

  // The disclaimer intentionally names "performance or efficiency score" in
  // negation ("not a ... score") -- a plain substring scan can't tell that
  // apart from an endorsement, so those two phrases are excluded here and
  // covered instead by the disclaimer assertion above. The remainder are
  // phrases with no legitimate positive or negated use on this page.
  const bodyText = (await page.locator("body").innerText()).toLowerCase();
  for (const banned of ["productivity score", "top performer", "leaderboard", "ranking", "efficient", "inefficient", "underperform"]) {
    expect(bodyText).not.toContain(banned);
  }

  await expect(page.getByRole("link", { name: fixture.users.reportOnly.email })).toHaveAttribute(
    "href",
    `/team-work?person=${fixture.users.reportOnly.id}`,
  );
  const teamLink = page.getByRole("link", { name: "Analytics Alpha Team" });
  await expect(teamLink).toHaveAttribute("href", `/team-work?scope=team&id=${fixture.teamIds.alpha}`);
  await expect(page.getByRole("link", { name: "E2E Analytics Process" }).first()).toHaveAttribute(
    "href",
    `/processes/${fixture.templateId}/edit`,
  );

  // Still signed in as the manager (valid scope) for this check, so an
  // invalid period param exercises period validation itself, not the
  // separate empty-scope redirect.
  await page.goto("/analytics?period=14");
  await expect(page).toHaveURL(/\/analytics$/);

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("/sign-in");
  await signIn(page, fixture.users["no-scope"]);
  await expect(page.getByRole("link", { name: "Analytics", exact: true })).toHaveCount(0);
  await page.goto("/analytics");
  await expect(page).toHaveURL(/\/$/);
});
