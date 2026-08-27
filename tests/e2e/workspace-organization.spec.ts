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

type TestUser = {
  id: string;
  email: string;
  password: string;
};

type OrganizationFixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  roles: { administrator: string; organizationManager: string; member: string; other: string };
  users: { administrator: TestUser; organizationManager: TestUser; memberA: TestUser; memberB: TestUser; memberC: TestUser; outsider: TestUser };
  entityId: string;
  recordId: string;
};

let fixture: OrganizationFixture;

function email(label: string) {
  return `e2e-organization-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<TestUser> {
  const admin = createSupabaseTestClient();
  const password = `Organization-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: email(label),
    password,
    email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create organization test user.");
  return { id: data.user.id, email: data.user.email, password };
}

async function createRole({
  workspaceId,
  name,
  capabilities,
}: {
  workspaceId: string;
  name: string;
  capabilities: string[];
}) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({
    id: roleId,
    workspace_id: workspaceId,
    name,
  });
  if (roleError) throw new Error(roleError.message);

  if (capabilities.length) {
    const { error: capabilityError } = await admin.from("workspace_role_capabilities").insert(
      capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })),
    );
    if (capabilityError) throw new Error(capabilityError.message);
  }

  return roleId;
}

async function createFixture(): Promise<OrganizationFixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const [administrator, organizationManager, memberA, memberB, memberC, outsider] = await Promise.all([
    createUser("administrator"),
    createUser("organization-manager"),
    createUser("member-a"),
    createUser("member-b"),
    createUser("member-c"),
    createUser("outsider"),
  ]);

  const { error: workspaceError } = await admin.from("workspaces").insert([
    { id: workspaceId, name: `E2E Organization ${workspaceId.slice(0, 8)}` },
    { id: otherWorkspaceId, name: `E2E Organization Other ${otherWorkspaceId.slice(0, 8)}` },
  ]);
  if (workspaceError) throw new Error(workspaceError.message);

  const [administratorRole, organizationManagerRole, memberRole, otherRole] = await Promise.all([
    createRole({ workspaceId, name: "Organization administrator", capabilities: allCapabilities }),
    createRole({ workspaceId, name: "Organization manager", capabilities: ["workspace.manage_organization"] }),
    createRole({ workspaceId, name: "Organization member", capabilities: [] }),
    createRole({ workspaceId: otherWorkspaceId, name: "Other administrator", capabilities: allCapabilities }),
  ]);

  const { error: membershipError } = await admin.from("workspace_memberships").insert([
    { workspace_id: workspaceId, user_id: administrator.id, role_id: administratorRole },
    { workspace_id: workspaceId, user_id: organizationManager.id, role_id: organizationManagerRole },
    { workspace_id: workspaceId, user_id: memberA.id, role_id: memberRole },
    { workspace_id: workspaceId, user_id: memberB.id, role_id: memberRole },
    { workspace_id: workspaceId, user_id: memberC.id, role_id: memberRole },
    { workspace_id: otherWorkspaceId, user_id: outsider.id, role_id: otherRole },
  ]);
  if (membershipError) throw new Error(membershipError.message);

  const entityId = randomUUID();
  const fieldId = randomUUID();
  const recordId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityId,
    workspace_id: workspaceId,
    name: "E2E Organization Record",
    slug: `e2e-organization-${workspaceId.slice(0, 8)}`,
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
  const { error: recordError } = await admin.from("entity_records").insert({
    id: recordId,
    workspace_id: workspaceId,
    entity_type_id: entityId,
    values: { name: "Organization record" },
  });
  if (recordError) throw new Error(recordError.message);

  return {
    workspaceId,
    otherWorkspaceId,
    roles: { administrator: administratorRole, organizationManager: organizationManagerRole, member: memberRole, other: otherRole },
    users: { administrator, organizationManager, memberA, memberB, memberC, outsider },
    entityId,
    recordId,
  };
}

async function cleanupFixture(current: OrganizationFixture) {
  const admin = createSupabaseTestClient();
  const { error: workspaceError } = await admin.from("workspaces").delete().in("id", [current.workspaceId, current.otherWorkspaceId]);
  if (workspaceError) throw new Error(workspaceError.message);

  for (const user of Object.values(current.users)) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(error.message);
  }
}

async function cleanupStaleFixtures() {
  const admin = createSupabaseTestClient();
  const { data: workspaces, error: workspaceError } = await admin
    .from("workspaces")
    .select("id")
    .ilike("name", "E2E Organization%");
  if (workspaceError) throw new Error(workspaceError.message);
  if (workspaces?.length) {
    const { error } = await admin.from("workspaces").delete().in("id", workspaces.map((workspace) => workspace.id));
    if (error) throw new Error(error.message);
  }

  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(error.message);
  for (const user of data.users.filter((candidate) => candidate.email?.startsWith("e2e-organization-"))) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) throw new Error(deleteError.message);
  }
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
  await expect(page).toHaveURL(/\/$/);
}

test.beforeAll(async () => {
  await cleanupStaleFixtures();
  fixture = await createFixture();
});

test.afterAll(async () => {
  if (fixture) await cleanupFixture(fixture);
});

test("enforces organization capability, supports multi-team leadership, and preserves roles", async () => {
  const admin = createSupabaseTestClient();
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const anonymous = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const organizationManager = await authenticatedClient(fixture.users.organizationManager);
  const ordinaryMember = await authenticatedClient(fixture.users.memberA);

  const beforeCapabilities = await admin
    .from("workspace_role_capabilities")
    .select("role_id, capability")
    .eq("workspace_id", fixture.workspaceId)
    .order("role_id")
    .order("capability");
  expect(beforeCapabilities.error).toBeNull();

  const deniedCreate = await ordinaryMember.rpc("create_workspace_team_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_name: "Denied team",
    p_description: null,
  });
  expect(deniedCreate.error?.message).toContain("workspace.manage_organization");
  const anonCreate = await anonymous.rpc("create_workspace_team_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_name: "Anonymous team",
    p_description: null,
  });
  expect(anonCreate.error).not.toBeNull();

  const createTeam = await organizationManager.rpc("create_workspace_team_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_name: "Operations",
    p_description: "Keeps delivery moving.",
  });
  expect(createTeam.error).toBeNull();
  const { data: operationsTeam, error: operationsError } = await admin
    .from("workspace_teams")
    .select("id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("name", "Operations")
    .single();
  expect(operationsError).toBeNull();

  const createSecondTeam = await organizationManager.rpc("create_workspace_team_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_name: "Client success",
    p_description: null,
  });
  expect(createSecondTeam.error).toBeNull();
  const { data: clientSuccessTeam, error: clientSuccessError } = await admin
    .from("workspace_teams")
    .select("id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("name", "Client success")
    .single();
  expect(clientSuccessError).toBeNull();

  const createEmptyTeam = await organizationManager.rpc("create_workspace_team_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_name: "Empty team",
    p_description: null,
  });
  expect(createEmptyTeam.error).toBeNull();
  const { data: emptyTeam, error: emptyTeamError } = await admin
    .from("workspace_teams")
    .select("id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("name", "Empty team")
    .single();
  expect(emptyTeamError).toBeNull();
  const deleteEmptyTeam = await organizationManager.rpc("delete_workspace_team_if_empty_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: emptyTeam!.id,
  });
  expect(deleteEmptyTeam.error).toBeNull();

  for (const userId of [fixture.users.memberA.id, fixture.users.memberB.id]) {
    const membership = await organizationManager.rpc("set_workspace_team_membership_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_team_id: operationsTeam!.id,
      p_user_id: userId,
      p_is_member: true,
    });
    expect(membership.error).toBeNull();
  }
  const secondMembership = await organizationManager.rpc("set_workspace_team_membership_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: clientSuccessTeam!.id,
    p_user_id: fixture.users.memberA.id,
    p_is_member: true,
  });
  expect(secondMembership.error).toBeNull();

  for (const userId of [fixture.users.memberA.id, fixture.users.memberB.id]) {
    const lead = await organizationManager.rpc("set_workspace_team_lead_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_team_id: operationsTeam!.id,
      p_user_id: userId,
      p_is_lead: true,
    });
    expect(lead.error).toBeNull();
  }

  const leadCannotManage = await ordinaryMember.rpc("create_workspace_team_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_name: "Lead cannot manage",
    p_description: null,
  });
  expect(leadCannotManage.error?.message).toContain("workspace.manage_organization");

  const organizations = await organizationManager.rpc("list_workspace_teams_authorized", {
    p_workspace_id: fixture.workspaceId,
  });
  expect(organizations.error).toBeNull();
  expect(
    (organizations.data as { team_id: string; member_count: number; lead_count: number }[] | null)?.find(
      (team) => team.team_id === operationsTeam!.id,
    ),
  ).toMatchObject({ member_count: 2, lead_count: 2 });
  const afterCapabilities = await admin
    .from("workspace_role_capabilities")
    .select("role_id, capability")
    .eq("workspace_id", fixture.workspaceId)
    .order("role_id")
    .order("capability");
  expect(afterCapabilities.data).toEqual(beforeCapabilities.data);
});

test("protects manager graph and team lifecycle while cleaning current org rows on membership removal", async () => {
  const admin = createSupabaseTestClient();
  const organizationManager = await authenticatedClient(fixture.users.organizationManager);

  const { data: team, error: teamError } = await admin
    .from("workspace_teams")
    .select("id")
    .eq("workspace_id", fixture.workspaceId)
    .eq("name", "Operations")
    .single();
  expect(teamError).toBeNull();

  const selfManager = await organizationManager.rpc("set_workspace_primary_manager_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_report_user_id: fixture.users.memberA.id,
    p_manager_user_id: fixture.users.memberA.id,
  });
  expect(selfManager.error?.message).toContain("cannot be their own manager");

  const directManager = await organizationManager.rpc("set_workspace_primary_manager_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_report_user_id: fixture.users.memberB.id,
    p_manager_user_id: fixture.users.memberA.id,
  });
  expect(directManager.error).toBeNull();
  const cycle = await organizationManager.rpc("set_workspace_primary_manager_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_report_user_id: fixture.users.memberA.id,
    p_manager_user_id: fixture.users.memberB.id,
  });
  expect(cycle.error?.message).toContain("reporting cycle");

  const clearManager = await organizationManager.rpc("set_workspace_primary_manager_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_report_user_id: fixture.users.memberB.id,
    p_manager_user_id: null,
  });
  expect(clearManager.error).toBeNull();
  const concurrentManagers = await Promise.all([
    organizationManager.rpc("set_workspace_primary_manager_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_report_user_id: fixture.users.memberA.id,
      p_manager_user_id: fixture.users.memberB.id,
    }),
    organizationManager.rpc("set_workspace_primary_manager_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_report_user_id: fixture.users.memberB.id,
      p_manager_user_id: fixture.users.memberA.id,
    }),
  ]);
  expect(concurrentManagers.filter((result) => result.error === null)).toHaveLength(1);
  expect(concurrentManagers.filter((result) => result.error !== null)).toHaveLength(1);

  const archive = await organizationManager.rpc("set_workspace_team_archived_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: team!.id,
    p_archived: true,
  });
  expect(archive.error).toBeNull();
  const addToArchived = await organizationManager.rpc("set_workspace_team_membership_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: team!.id,
    p_user_id: fixture.users.memberC.id,
    p_is_member: true,
  });
  expect(addToArchived.error?.message).toContain("Archived teams cannot accept new members");
  const addArchivedLead = await organizationManager.rpc("set_workspace_team_lead_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: team!.id,
    p_user_id: fixture.users.memberA.id,
    p_is_lead: true,
  });
  expect(addArchivedLead.error?.message).toContain("Archived teams cannot accept new leads");
  const deleteNonempty = await organizationManager.rpc("delete_workspace_team_if_empty_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: team!.id,
  });
  expect(deleteNonempty.error?.message).toContain("Remove team members");

  const restore = await organizationManager.rpc("set_workspace_team_archived_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: team!.id,
    p_archived: false,
  });
  expect(restore.error).toBeNull();
  const addMemberC = await organizationManager.rpc("set_workspace_team_membership_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: team!.id,
    p_user_id: fixture.users.memberC.id,
    p_is_member: true,
  });
  expect(addMemberC.error).toBeNull();
  const addLeadC = await organizationManager.rpc("set_workspace_team_lead_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: team!.id,
    p_user_id: fixture.users.memberC.id,
    p_is_lead: true,
  });
  expect(addLeadC.error).toBeNull();
  const managerC = await organizationManager.rpc("set_workspace_primary_manager_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_report_user_id: fixture.users.memberC.id,
    p_manager_user_id: fixture.users.memberA.id,
  });
  expect(managerC.error).toBeNull();

  const removeMembership = await admin
    .from("workspace_memberships")
    .delete()
    .eq("workspace_id", fixture.workspaceId)
    .eq("user_id", fixture.users.memberC.id);
  expect(removeMembership.error).toBeNull();
  const [teamMemberships, teamLeads, reports] = await Promise.all([
    admin.from("workspace_team_memberships").select("user_id").eq("workspace_id", fixture.workspaceId).eq("user_id", fixture.users.memberC.id),
    admin.from("workspace_team_leads").select("user_id").eq("workspace_id", fixture.workspaceId).eq("user_id", fixture.users.memberC.id),
    admin.from("workspace_reporting_relationships").select("id").eq("workspace_id", fixture.workspaceId).or(`manager_user_id.eq.${fixture.users.memberC.id},report_user_id.eq.${fixture.users.memberC.id}`),
  ]);
  expect(teamMemberships.data).toHaveLength(0);
  expect(teamLeads.data).toHaveLength(0);
  expect(reports.data).toHaveLength(0);
});

test("keeps organization reads scoped and exposes the teams and reporting controls in settings", async ({ page }) => {
  const admin = createSupabaseTestClient();
  const organizationManager = await authenticatedClient(fixture.users.organizationManager);
  const ordinaryMember = await authenticatedClient(fixture.users.memberA);

  const managementRead = await ordinaryMember.rpc("list_workspace_teams_authorized", {
    p_workspace_id: fixture.workspaceId,
  });
  expect(managementRead.error?.message).toContain("workspace.manage_organization");
  const ownTeams = await ordinaryMember.rpc("list_my_workspace_teams_authorized", {
    p_workspace_id: fixture.workspaceId,
  });
  expect(ownTeams.error).toBeNull();
  const scopedTeams = ownTeams.data as { team_id: string; name: string }[] | null;
  expect(scopedTeams?.map((team) => team.name)).toContain("Operations");
  const ownManager = await ordinaryMember.rpc("get_my_workspace_manager_authorized", {
    p_workspace_id: fixture.workspaceId,
  });
  expect(ownManager.error).toBeNull();
  const ownTeamMembers = await ordinaryMember.rpc("list_my_team_members_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: scopedTeams?.[0]?.team_id,
  });
  expect(ownTeamMembers.error).toBeNull();
  const rawMemberships = await ordinaryMember
    .from("workspace_memberships")
    .select("user_id")
    .eq("workspace_id", fixture.workspaceId);
  expect(rawMemberships.data).toEqual([{ user_id: fixture.users.memberA.id }]);
  const rawTeams = await ordinaryMember.from("workspace_teams").select("id");
  expect(rawTeams.error).not.toBeNull();

  const foreignTeamId = randomUUID();
  const { error: foreignTeamError } = await admin.from("workspace_teams").insert({
    id: foreignTeamId,
    workspace_id: fixture.otherWorkspaceId,
    name: "Foreign team",
  });
  expect(foreignTeamError).toBeNull();
  const foreignTeam = await organizationManager.rpc("set_workspace_team_membership_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_team_id: foreignTeamId,
    p_user_id: fixture.users.memberA.id,
    p_is_member: true,
  });
  expect(foreignTeam.error?.message).toContain("Team not found");
  const foreignManager = await organizationManager.rpc("set_workspace_primary_manager_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_report_user_id: fixture.users.memberA.id,
    p_manager_user_id: fixture.users.outsider.id,
  });
  expect(foreignManager.error?.message).toContain("Manager must be a workspace member");

  await signIn(page, fixture.users.organizationManager);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reporting relationships" })).toBeVisible();
  await page.getByLabel("Team name").last().fill("UI team");
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByRole("status")).toContainText("Team created.");
});
