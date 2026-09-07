// DB/RPC-level verification for Phase 12.1 People Identity Foundation
// (workspaces.person_entity_type_id, entity_record_person_links,
// set_person_entity_type_authorized, set_person_link_authorized,
// remove_person_link_authorized, migrations 0097/0098). Covers: Person-type
// designation (authorization, archived/nonexistent/cross-workspace
// rejection, no-op-on-same-value, block-while-linked, safe-delete
// interaction), identity linking (authorization, impersonation boundary,
// eligibility guards, structural cross-workspace impossibility, explicit
// non-upsert rejection, explicit unlink/relink sequencing, deactivation/
// archival survival, concurrent-link race), durable person_linked/
// person_unlinked history, and safe-delete interaction for both Person
// records and the designated EntityType.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient, deleteE2eUsers } from "../../tests/e2e/helpers/supabase-test-data";
import { listUnlinkedWorkspaceMemberIdentities } from "./person-link-repository";

type User = { id: string; email: string; password: string };

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  personEntityTypeId: string;
  otherEntityTypeId: string;
  otherWorkspaceEntityTypeId: string;
  linkableRoleId: string;
  schemaManager: User;
  memberManager: User;
  administrator: User;
  operatorOnly: User;
  workerA: User;
  workerB: User;
  workerC: User;
  deactivated: User;
  otherWorkspaceMember: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
const clientCache = new Map<string, Promise<SupabaseClient>>();

function uniqueEmail(label: string) {
  return `e2e-person-link-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `PersonLink-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({
    email: uniqueEmail(label),
    password,
    email_confirm: true,
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email: data.user.email, password };
}

async function authenticatedClient(user: User): Promise<SupabaseClient> {
  let cached = clientCache.get(user.id);
  if (!cached) {
    cached = (async () => {
      const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
      const client = createClient(supabaseUrl, supabasePublishableKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
      if (error) throw new Error(error.message);
      return client;
    })();
    clientCache.set(user.id, cached);
  }
  return cached;
}

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: `${name} ${workspaceId.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin
    .from("workspace_roles")
    .insert({ id: roleId, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return roleId;
}

async function addMembership(workspaceId: string, userId: string, roleId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({
    workspace_id: workspaceId,
    user_id: userId,
    role_id: roleId,
  });
  if (error) throw new Error(error.message);
}

async function createEntityType(workspaceId: string, name: string) {
  const admin = createSupabaseTestClient();
  const entityTypeId = randomUUID();
  const { error } = await admin.from("entity_types").insert({
    id: entityTypeId,
    workspace_id: workspaceId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${entityTypeId.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);
  return entityTypeId;
}

async function createRecord(workspaceId: string, entityTypeId: string, name: string) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin.from("entity_records").insert({
    id: recordId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    values: { name },
  });
  if (error) throw new Error(error.message);
  return recordId;
}

async function archiveRecord(workspaceId: string, recordId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", recordId);
  if (error) throw new Error(error.message);
}

async function deactivateMember(workspaceId: string, userId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin
    .from("workspace_memberships")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// Every test that performs a *successful* link must target a member unique
// to that test, never a shared fixture worker -- unique(workspace_id,
// user_id) means a leftover link from one test (e.g. an unchecked cleanup
// call) would otherwise silently break every later test targeting the same
// shared member. fixture.workerA/B/C exist only for rejection-path tests
// (deactivated/foreign/etc.) and as stable "known unlinked" comparison
// points, never as a real link target.
async function createLinkableMember(label: string): Promise<User> {
  const user = await createUser(label);
  await addMembership(fixture.workspaceId, user.id, fixture.linkableRoleId);
  return user;
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function setPersonEntityType(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string | null,
) {
  return client.rpc("set_person_entity_type_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
  });
}

async function setPersonLink(
  client: SupabaseClient,
  workspaceId: string,
  entityRecordId: string,
  userId: string,
) {
  return client.rpc("set_person_link_authorized", {
    p_workspace_id: workspaceId,
    p_entity_record_id: entityRecordId,
    p_user_id: userId,
  });
}

async function removePersonLink(client: SupabaseClient, workspaceId: string, entityRecordId: string) {
  return client.rpc("remove_person_link_authorized", {
    p_workspace_id: workspaceId,
    p_entity_record_id: entityRecordId,
  });
}

async function createFixture(): Promise<Fixture> {
  const workspaceId = await createWorkspace("E2E Person Link");
  const otherWorkspaceId = await createWorkspace("E2E Person Link Other");

  const schemaManagerRoleId = await createRole(workspaceId, "Schema manager", ["schema.manage"]);
  const memberManagerRoleId = await createRole(workspaceId, "Member manager", [
    "workspace.manage_members",
    "records.operate",
  ]);
  const administratorRoleId = await createRole(workspaceId, "Administrator", [
    "schema.manage",
    "workspace.manage_members",
    "workspace.impersonate_users",
  ]);
  const operatorOnlyRoleId = await createRole(workspaceId, "Operator only", ["processes.operate"]);
  const otherWorkspaceRoleId = await createRole(otherWorkspaceId, "Other operator", ["processes.operate"]);
  const linkableRoleId = await createRole(workspaceId, "Linkable member", ["processes.operate"]);

  const schemaManager = await createUser("schema-manager");
  const memberManager = await createUser("member-manager");
  const administrator = await createUser("administrator");
  const operatorOnly = await createUser("operator-only");
  const workerA = await createUser("worker-a");
  const workerB = await createUser("worker-b");
  const workerC = await createUser("worker-c");
  const deactivated = await createUser("deactivated");
  const otherWorkspaceMember = await createUser("other-workspace-member");

  await addMembership(workspaceId, schemaManager.id, schemaManagerRoleId);
  await addMembership(workspaceId, memberManager.id, memberManagerRoleId);
  await addMembership(workspaceId, administrator.id, administratorRoleId);
  await addMembership(workspaceId, operatorOnly.id, operatorOnlyRoleId);
  await addMembership(workspaceId, workerA.id, operatorOnlyRoleId);
  await addMembership(workspaceId, workerB.id, operatorOnlyRoleId);
  await addMembership(workspaceId, workerC.id, operatorOnlyRoleId);
  await addMembership(workspaceId, deactivated.id, operatorOnlyRoleId);
  await addMembership(otherWorkspaceId, otherWorkspaceMember.id, otherWorkspaceRoleId);
  await deactivateMember(workspaceId, deactivated.id);

  const personEntityTypeId = await createEntityType(workspaceId, `Person ${workspaceId.slice(0, 6)}`);
  const otherEntityTypeId = await createEntityType(workspaceId, `Deliverable ${workspaceId.slice(0, 6)}`);
  const otherWorkspaceEntityTypeId = await createEntityType(
    otherWorkspaceId,
    `Other Person ${otherWorkspaceId.slice(0, 6)}`,
  );

  const adminClient = await authenticatedClient(schemaManager);
  const designateResult = await setPersonEntityType(adminClient, workspaceId, personEntityTypeId);
  if (designateResult.error) throw new Error(`Unable to designate Person type: ${designateResult.error.message}`);

  return {
    workspaceId,
    otherWorkspaceId,
    personEntityTypeId,
    otherEntityTypeId,
    otherWorkspaceEntityTypeId,
    linkableRoleId,
    schemaManager,
    memberManager,
    administrator,
    operatorOnly,
    workerA,
    workerB,
    workerC,
    deactivated,
    otherWorkspaceMember,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
}, 45_000);

afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];

  if (createdWorkspaceIds.length > 0) {
    // Clear the designation before teardown so entity_types deletion never
    // has to contend with workspaces_person_entity_type_fk's RESTRICT.
    await admin
      .from("workspaces")
      .update({ person_entity_type_id: null })
      .in("id", createdWorkspaceIds);

    for (const table of [
      "workspace_events",
      "entity_record_person_links",
      "entity_records",
      "field_definitions",
      "entity_types",
      "workspaces",
    ]) {
      const { error } = await admin
        .from(table)
        .delete()
        .in(table === "workspaces" ? "id" : "workspace_id", createdWorkspaceIds);
      if (error) failures.push(`${table}: ${error.message}`);
    }
  }

  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) {
    throw new Error(`person-link-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 45_000);

describe("set_person_entity_type_authorized", () => {
  it("a schema.manage holder can designate an active EntityType as the Person type", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.schemaManager);
    const scratchTypeId = await createEntityType(fixture.workspaceId, "Scratch Designation Target");

    const result = await setPersonEntityType(client, fixture.workspaceId, scratchTypeId);
    expect(result.error).toBeNull();

    const workspaceRow = await admin
      .from("workspaces")
      .select("person_entity_type_id")
      .eq("id", fixture.workspaceId)
      .single();
    expect(workspaceRow.data?.person_entity_type_id).toBe(scratchTypeId);

    const designationEvent = await admin
      .from("governance_audit_events")
      .select("event_type, subject_kind, subject_id, parent_entity_type_id, parent_field_id, changes")
      .eq("workspace_id", fixture.workspaceId)
      .eq("event_type", "person_entity_type_changed")
      .eq("subject_id", fixture.workspaceId)
      .contains("changes", { new_person_entity_type: { id: scratchTypeId } })
      .single();
    expect(designationEvent.error).toBeNull();
    expect(designationEvent.data).toEqual(expect.objectContaining({
      event_type: "person_entity_type_changed",
      subject_kind: "workspace",
      subject_id: fixture.workspaceId,
      parent_entity_type_id: null,
      parent_field_id: null,
    }));
    expect(designationEvent.data?.changes).toEqual(expect.objectContaining({
      operation: "replace",
      old_person_entity_type: expect.objectContaining({ id: fixture.personEntityTypeId }),
      new_person_entity_type: expect.objectContaining({ id: scratchTypeId }),
    }));

    // Restore the fixture's designation for subsequent tests.
    const restore = await setPersonEntityType(client, fixture.workspaceId, fixture.personEntityTypeId);
    expect(restore.error).toBeNull();
    await admin.from("entity_types").delete().eq("id", scratchTypeId);
  });

  it("rejects a caller without schema.manage", async () => {
    const client = await authenticatedClient(fixture.operatorOnly);
    const result = await setPersonEntityType(client, fixture.workspaceId, fixture.otherEntityTypeId);
    expect(result.error).not.toBeNull();
  });

  it.each([
    ["an archived entity type", true],
    ["a nonexistent entity type", false],
  ])("rejects %s", async (_label, useArchivedType) => {
    const client = await authenticatedClient(fixture.schemaManager);
    let targetId: string;
    if (useArchivedType) {
      targetId = await createEntityType(fixture.workspaceId, "Archived Designation Target");
      const admin = createSupabaseTestClient();
      await admin
        .from("entity_types")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", targetId);
    } else {
      targetId = randomUUID();
    }

    const result = await setPersonEntityType(client, fixture.workspaceId, targetId);
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not found or archived/i);
  });

  it("rejects a cross-workspace entity type", async () => {
    const client = await authenticatedClient(fixture.schemaManager);
    const result = await setPersonEntityType(client, fixture.workspaceId, fixture.otherWorkspaceEntityTypeId);
    expect(result.error).not.toBeNull();
  });

  it("setting the same designation again is a clean no-op", async () => {
    const client = await authenticatedClient(fixture.schemaManager);
    const result = await setPersonEntityType(client, fixture.workspaceId, fixture.personEntityTypeId);
    expect(result.error).toBeNull();

    const admin = createSupabaseTestClient();
    const workspaceRow = await admin
      .from("workspaces")
      .select("person_entity_type_id")
      .eq("id", fixture.workspaceId)
      .single();
    expect(workspaceRow.data?.person_entity_type_id).toBe(fixture.personEntityTypeId);
  });

  it("clearing/changing the designation succeeds when zero links exist, and is rejected once a link exists", async () => {
    const scratchWorkspaceId = await createWorkspace("E2E Person Link Designation Lifecycle");
    const scratchRoleId = await createRole(scratchWorkspaceId, "Schema manager", ["schema.manage", "workspace.manage_members"]);
    const scratchUser = await createUser("designation-lifecycle-worker");
    const scratchManager = await createUser("designation-lifecycle-manager");
    await addMembership(scratchWorkspaceId, scratchUser.id, scratchRoleId);
    await addMembership(scratchWorkspaceId, scratchManager.id, scratchRoleId);
    const scratchManagerClient = await authenticatedClient(scratchManager);

    const typeA = await createEntityType(scratchWorkspaceId, "Lifecycle Person A");
    const typeB = await createEntityType(scratchWorkspaceId, "Lifecycle Person B");

    const designateA = await setPersonEntityType(scratchManagerClient, scratchWorkspaceId, typeA);
    expect(designateA.error).toBeNull();

    // Zero links -> changing designation succeeds.
    const changeToB = await setPersonEntityType(scratchManagerClient, scratchWorkspaceId, typeB);
    expect(changeToB.error).toBeNull();

    const recordId = await createRecord(scratchWorkspaceId, typeB, "Lifecycle Person Record");
    const linkResult = await setPersonLink(scratchManagerClient, scratchWorkspaceId, recordId, scratchUser.id);
    expect(linkResult.error).toBeNull();

    // A link now exists -> changing or clearing must be rejected.
    const blockedChange = await setPersonEntityType(scratchManagerClient, scratchWorkspaceId, typeA);
    expect(blockedChange.error).not.toBeNull();
    expect(blockedChange.error?.message ?? "").toMatch(/identity links exist/i);
    const blockedClear = await setPersonEntityType(scratchManagerClient, scratchWorkspaceId, null);
    expect(blockedClear.error).not.toBeNull();

    // Explicitly unlink, then the designation can change again.
    const unlinkResult = await removePersonLink(scratchManagerClient, scratchWorkspaceId, recordId);
    expect(unlinkResult.error).toBeNull();
    const changeAfterUnlink = await setPersonEntityType(scratchManagerClient, scratchWorkspaceId, typeA);
    expect(changeAfterUnlink.error).toBeNull();

    // Workspace/type/record/link cleanup for this scratch workspace, and
    // the two scratch users, are both handled once by the shared afterAll
    // below (which already clears every tracked workspace's designation
    // before deleting) -- deleting users here too would make afterAll's
    // own deleteE2eUsers call fail on an already-deleted id.
    await removePersonLink(scratchManagerClient, scratchWorkspaceId, recordId).catch(() => {});
  });
});

describe("delete_entity_type_if_safe_authorized: Person-type designation interaction", () => {
  it("blocks hard deletion of the designated Person type with an explicit designation count, and allows it once cleared", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.schemaManager);
    const scratchTypeId = await createEntityType(fixture.workspaceId, "Deletable Once Undesignated");

    const designate = await setPersonEntityType(client, fixture.workspaceId, scratchTypeId);
    expect(designate.error).toBeNull();

    const blockedDelete = await client.rpc("delete_entity_type_if_safe_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: scratchTypeId,
    });
    expect(blockedDelete.error).toBeNull();
    const blockedRow = (blockedDelete.data as Array<{ deleted: boolean; person_type_designation_count: number }>)[0];
    expect(blockedRow).toMatchObject({ deleted: false, person_type_designation_count: 1 });

    const typeStillExists = await admin.from("entity_types").select("id").eq("id", scratchTypeId).maybeSingle();
    expect(typeStillExists.data).not.toBeNull();

    const clearDesignation = await setPersonEntityType(client, fixture.workspaceId, fixture.personEntityTypeId);
    expect(clearDesignation.error).toBeNull();

    const allowedDelete = await client.rpc("delete_entity_type_if_safe_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: scratchTypeId,
    });
    expect(allowedDelete.error).toBeNull();
    const allowedRow = (allowedDelete.data as Array<{ deleted: boolean }>)[0];
    expect(allowedRow?.deleted).toBe(true);
  });

  it("non-designated entity types retain unchanged safe-delete behavior", async () => {
    const client = await authenticatedClient(fixture.schemaManager);
    const scratchTypeId = await createEntityType(fixture.workspaceId, "Ordinary Deletable Type");

    const result = await client.rpc("delete_entity_type_if_safe_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: scratchTypeId,
    });
    expect(result.error).toBeNull();
    const row = (result.data as Array<{ deleted: boolean; person_type_designation_count: number }>)[0];
    expect(row).toMatchObject({ deleted: true, person_type_designation_count: 0 });
  });
});

describe("set_person_link_authorized: authorization and eligibility", () => {
  it("a workspace.manage_members holder can link an eligible Person record to a current workspace member", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("link-success");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Linkable Person");

    const result = await setPersonLink(client, fixture.workspaceId, recordId, target.id);
    expect(result.error).toBeNull();

    const linkRow = await admin
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .single();
    expect(linkRow.data?.user_id).toBe(target.id);

    const cleanup = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });

  it("rejects a caller without workspace.manage_members", async () => {
    const client = await authenticatedClient(fixture.operatorOnly);
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "No Capability Target");
    const result = await setPersonLink(client, fixture.workspaceId, recordId, fixture.workerA.id);
    expect(result.error).not.toBeNull();
  });

  it("rejects linking while the caller is impersonating another member", async () => {
    const adminClient = await authenticatedClient(fixture.administrator);
    const target = await createLinkableMember("impersonation-link-target");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Impersonation Target");

    const start = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.workerB.id,
    });
    expect(start.error).toBeNull();

    try {
      const result = await setPersonLink(adminClient, fixture.workspaceId, recordId, target.id);
      expect(result.error).not.toBeNull();
    } finally {
      await endAnyActiveSession(adminClient);
    }

    // Confirm the real actor succeeds immediately once impersonation ends.
    const afterEnding = await setPersonLink(adminClient, fixture.workspaceId, recordId, target.id);
    expect(afterEnding.error).toBeNull();
    const cleanup = await removePersonLink(adminClient, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });

  it("rejects a non-Person-type record", async () => {
    const client = await authenticatedClient(fixture.memberManager);
    const recordId = await createRecord(fixture.workspaceId, fixture.otherEntityTypeId, "Not A Person");
    const result = await setPersonLink(client, fixture.workspaceId, recordId, fixture.workerA.id);
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a person record/i);
  });

  it("rejects an archived Person record", async () => {
    const client = await authenticatedClient(fixture.memberManager);
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Archived Person");
    await archiveRecord(fixture.workspaceId, recordId);
    const result = await setPersonLink(client, fixture.workspaceId, recordId, fixture.workerA.id);
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/archived/i);
  });

  it("rejects a deactivated member", async () => {
    const client = await authenticatedClient(fixture.memberManager);
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Deactivated Target");
    const result = await setPersonLink(client, fixture.workspaceId, recordId, fixture.deactivated.id);
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a current member/i);
  });

  it.each([
    ["a nonexistent user id", () => randomUUID()],
    ["a foreign-workspace member", () => fixture.otherWorkspaceMember.id],
  ])("rejects %s", async (_label, getUserId) => {
    const client = await authenticatedClient(fixture.memberManager);
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Invalid Target");
    const result = await setPersonLink(client, fixture.workspaceId, recordId, getUserId());
    expect(result.error).not.toBeNull();
    expect(result.error?.message ?? "").toMatch(/not a current member/i);
  });

  it("cross-workspace record/member combinations are structurally impossible, even bypassing the RPC", async () => {
    const admin = createSupabaseTestClient();
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Structural Guard");

    const rawInsert = await admin.from("entity_record_person_links").insert({
      workspace_id: fixture.otherWorkspaceId,
      entity_type_id: fixture.personEntityTypeId,
      entity_record_id: recordId,
      user_id: fixture.workerA.id,
    });
    expect(rawInsert.error).not.toBeNull();
    expect(rawInsert.error?.code).toBe("23503");
  });
});

describe("set_person_link_authorized: non-upsert semantics and explicit reassignment", () => {
  it("rejects linking a record that already has a link, without silently replacing it", async () => {
    const client = await authenticatedClient(fixture.memberManager);
    const linked = await createLinkableMember("already-linked-record-a");
    const other = await createLinkableMember("already-linked-record-b");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Already Linked Record");
    const first = await setPersonLink(client, fixture.workspaceId, recordId, linked.id);
    expect(first.error).toBeNull();

    const second = await setPersonLink(client, fixture.workspaceId, recordId, other.id);
    expect(second.error).not.toBeNull();
    expect(second.error?.message ?? "").toMatch(/already linked to a workspace member/i);

    const admin = createSupabaseTestClient();
    const linkRow = await admin
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .single();
    expect(linkRow.data?.user_id).toBe(linked.id);

    const cleanup = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });

  it("rejects linking a member who is already linked elsewhere, without silently replacing it", async () => {
    const client = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("elsewhere-linked-target");
    const recordOne = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Elsewhere Linked One");
    const recordTwo = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Elsewhere Linked Two");
    const first = await setPersonLink(client, fixture.workspaceId, recordOne, target.id);
    expect(first.error).toBeNull();

    const second = await setPersonLink(client, fixture.workspaceId, recordTwo, target.id);
    expect(second.error).not.toBeNull();
    expect(second.error?.message ?? "").toMatch(/already linked to a record/i);

    const cleanup = await removePersonLink(client, fixture.workspaceId, recordOne);
    expect(cleanup.error).toBeNull();
  });

  it("explicit unlink succeeds, and unlinking an already-unlinked record is consistently rejected", async () => {
    const client = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("explicit-unlink-target");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Explicit Unlink Target");
    const link = await setPersonLink(client, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();

    const unlink = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(unlink.error).toBeNull();

    const admin = createSupabaseTestClient();
    const linkRow = await admin
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .maybeSingle();
    expect(linkRow.data).toBeNull();

    const secondUnlink = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(secondUnlink.error).not.toBeNull();
    expect(secondUnlink.error?.message ?? "").toMatch(/not currently linked/i);
  });

  it("unlink then link to a different member works as the explicit reassignment sequence", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.memberManager);
    const targetA = await createLinkableMember("reassignment-sequence-a");
    const targetB = await createLinkableMember("reassignment-sequence-b");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Reassignment Sequence");

    const linkA = await setPersonLink(client, fixture.workspaceId, recordId, targetA.id);
    expect(linkA.error).toBeNull();
    const unlink = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(unlink.error).toBeNull();
    const linkB = await setPersonLink(client, fixture.workspaceId, recordId, targetB.id);
    expect(linkB.error).toBeNull();

    const linkRow = await admin
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .single();
    expect(linkRow.data?.user_id).toBe(targetB.id);

    const cleanup = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });
});

describe("link survival across lifecycle transitions", () => {
  it("member deactivation after linking preserves the link row", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.memberManager);
    const target = await createUser("deactivate-after-link");
    const roleId = await createRole(fixture.workspaceId, "Deactivate After Link Role", ["processes.operate"]);
    await addMembership(fixture.workspaceId, target.id, roleId);
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Deactivate After Link");

    const link = await setPersonLink(client, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();

    await deactivateMember(fixture.workspaceId, target.id);

    const linkRow = await admin
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .maybeSingle();
    expect(linkRow.data?.user_id).toBe(target.id);

    // A deactivated member's link is not automatically removed by product
    // design -- unlink explicitly so this test leaves no lingering link for
    // later tests in this shared-fixture workspace.
    const cleanup = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });

  it("Person-record archival after linking preserves the link row", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("archive-after-link");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Archive After Link");
    const link = await setPersonLink(client, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();

    await archiveRecord(fixture.workspaceId, recordId);

    const linkRow = await admin
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .maybeSingle();
    expect(linkRow.data?.user_id).toBe(target.id);

    const cleanup = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });

  it("1:1 uniqueness holds under two concurrent linking attempts for the same member", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.memberManager);
    const recordOne = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Race Target One");
    const recordTwo = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Race Target Two");
    const target = await createUser("race-target-member");
    const roleId = await createRole(fixture.workspaceId, "Race Target Role", ["processes.operate"]);
    await addMembership(fixture.workspaceId, target.id, roleId);

    const [resultOne, resultTwo] = await Promise.all([
      setPersonLink(client, fixture.workspaceId, recordOne, target.id),
      setPersonLink(client, fixture.workspaceId, recordTwo, target.id),
    ]);
    const successes = [resultOne, resultTwo].filter((result) => result.error === null);
    const failures = [resultOne, resultTwo].filter((result) => result.error !== null);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const links = await admin
      .from("entity_record_person_links")
      .select("entity_record_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("user_id", target.id);
    expect(links.data).toHaveLength(1);

    const cleanup = await removePersonLink(client, fixture.workspaceId, links.data![0].entity_record_id);
    expect(cleanup.error).toBeNull();
  });
});

describe("person_linked / person_unlinked history", () => {
  it("records a person_linked event with correct record, user id, email snapshot, and actor attribution", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("history-link-target");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "History Link Target");

    const link = await setPersonLink(client, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();

    const event = await admin
      .from("workspace_events")
      .select("actor_user_id, real_actor_user_id, entity_type_id, entity_record_id, metadata")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .eq("event_type", "person_linked")
      .single();
    expect(event.error).toBeNull();
    expect(event.data?.actor_user_id).toBe(fixture.memberManager.id);
    expect(event.data?.real_actor_user_id).toBeNull();
    expect(event.data?.entity_type_id).toBe(fixture.personEntityTypeId);
    expect(event.data?.metadata).toMatchObject({
      linked_user_id: target.id,
      linked_email: target.email,
      person_record_id: recordId,
      person_label_snapshot: `${recordId.slice(0, 8)}...`,
      person_entity_type_id: fixture.personEntityTypeId,
      person_entity_type_name_snapshot: expect.any(String),
    });

    const cleanup = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });

  it("records a person_unlinked event with the prior linked identity and correct actor attribution, never rewriting the person_linked row", async () => {
    const admin = createSupabaseTestClient();
    const client = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("history-unlink-target");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "History Unlink Target");

    const link = await setPersonLink(client, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();
    const linkEventBefore = await admin
      .from("workspace_events")
      .select("id, metadata")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .eq("event_type", "person_linked")
      .single();

    const unlink = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(unlink.error).toBeNull();

    const unlinkEvent = await admin
      .from("workspace_events")
      .select("actor_user_id, real_actor_user_id, entity_type_id, entity_record_id, metadata")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .eq("event_type", "person_unlinked")
      .single();
    expect(unlinkEvent.error).toBeNull();
    expect(unlinkEvent.data?.actor_user_id).toBe(fixture.memberManager.id);
    expect(unlinkEvent.data?.real_actor_user_id).toBeNull();
    expect(unlinkEvent.data?.metadata).toMatchObject({
      unlinked_user_id: target.id,
      unlinked_email: target.email,
      person_record_id: recordId,
      person_label_snapshot: `${recordId.slice(0, 8)}...`,
      person_entity_type_id: fixture.personEntityTypeId,
      person_entity_type_name_snapshot: expect.any(String),
    });

    // The earlier person_linked event row is untouched.
    const linkEventAfter = await admin
      .from("workspace_events")
      .select("id, metadata")
      .eq("id", linkEventBefore.data!.id)
      .single();
    expect(linkEventAfter.data).toEqual(linkEventBefore.data);
  });
});

describe("impersonation boundary: set_person_entity_type_authorized and remove_person_link_authorized", () => {
  it("set_person_entity_type_authorized rejects while impersonating, and a since-ended session does not block it", async () => {
    const adminClient = await authenticatedClient(fixture.administrator);
    const scratchTypeId = await createEntityType(fixture.workspaceId, "Impersonation Designation Target");

    const start = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.workerB.id,
    });
    expect(start.error).toBeNull();

    try {
      const result = await setPersonEntityType(adminClient, fixture.workspaceId, scratchTypeId);
      expect(result.error).not.toBeNull();
      expect(result.error?.message ?? "").toMatch(/not available while impersonating/i);
    } finally {
      await endAnyActiveSession(adminClient);
    }

    // The designation is unchanged by the rejected attempt.
    const admin = createSupabaseTestClient();
    const workspaceRow = await admin
      .from("workspaces")
      .select("person_entity_type_id")
      .eq("id", fixture.workspaceId)
      .single();
    expect(workspaceRow.data?.person_entity_type_id).toBe(fixture.personEntityTypeId);

    // The same real actor succeeds immediately once the session has ended
    // -- restore and re-clear to leave the fixture's designation as found.
    const afterEnding = await setPersonEntityType(adminClient, fixture.workspaceId, scratchTypeId);
    expect(afterEnding.error).toBeNull();
    const restore = await setPersonEntityType(adminClient, fixture.workspaceId, fixture.personEntityTypeId);
    expect(restore.error).toBeNull();
    await admin.from("entity_types").delete().eq("id", scratchTypeId);
  });

  it("remove_person_link_authorized rejects while impersonating, and a since-ended session does not block it", async () => {
    const adminClient = await authenticatedClient(fixture.administrator);
    const memberClient = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("impersonation-unlink-target");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Impersonation Unlink Target");
    const link = await setPersonLink(memberClient, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();

    const start = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.workerB.id,
    });
    expect(start.error).toBeNull();

    try {
      const result = await removePersonLink(adminClient, fixture.workspaceId, recordId);
      expect(result.error).not.toBeNull();
      expect(result.error?.message ?? "").toMatch(/not available while impersonating/i);
    } finally {
      await endAnyActiveSession(adminClient);
    }

    // The link is unchanged by the rejected attempt.
    const admin = createSupabaseTestClient();
    const linkRow = await admin
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .maybeSingle();
    expect(linkRow.data?.user_id).toBe(target.id);

    // The same real actor succeeds immediately once the session has ended.
    const afterEnding = await removePersonLink(adminClient, fixture.workspaceId, recordId);
    expect(afterEnding.error).toBeNull();
  });
});

describe("delete_entity_record_if_unreferenced_authorized: person-link interaction", () => {
  it("blocks hard deletion of a linked Person record until explicitly unlinked, then allows it", async () => {
    const client = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("deletable-once-unlinked");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Deletable Once Unlinked");
    const link = await setPersonLink(client, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();

    const blockedDelete = await client.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.personEntityTypeId,
      p_record_id: recordId,
    });
    expect(blockedDelete.error).toBeNull();
    const blockedRow = (blockedDelete.data as Array<{ deleted: boolean; person_link_count: number }>)[0];
    expect(blockedRow).toMatchObject({ deleted: false, person_link_count: 1 });

    const unlink = await removePersonLink(client, fixture.workspaceId, recordId);
    expect(unlink.error).toBeNull();

    const allowedDelete = await client.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.personEntityTypeId,
      p_record_id: recordId,
    });
    expect(allowedDelete.error).toBeNull();
    const allowedRow = (allowedDelete.data as Array<{ deleted: boolean }>)[0];
    expect(allowedRow?.deleted).toBe(true);
  });

  it("non-Person records retain unchanged safe-delete behavior (no person_link_count false positive)", async () => {
    const client = await authenticatedClient(fixture.memberManager);
    const recordId = await createRecord(fixture.workspaceId, fixture.otherEntityTypeId, "Ordinary Deletable Record");

    const result = await client.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.otherEntityTypeId,
      p_record_id: recordId,
    });
    expect(result.error).toBeNull();
    const row = (result.data as Array<{ deleted: boolean; person_link_count: number }>)[0];
    expect(row).toMatchObject({ deleted: true, person_link_count: 0 });
  });
});

describe("reads: identity visibility and candidate exclusion", () => {
  it("an ordinary workspace member (no special capability) can read the current link identity", async () => {
    const managerClient = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("readable-by-anyone");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Readable By Anyone");
    const link = await setPersonLink(managerClient, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();

    const plainClient = await authenticatedClient(fixture.operatorOnly);
    const readAttempt = await plainClient
      .from("entity_record_person_links")
      .select("user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", recordId)
      .single();
    expect(readAttempt.error).toBeNull();
    expect(readAttempt.data?.user_id).toBe(target.id);

    const cleanup = await removePersonLink(managerClient, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });

  it("an ordinary workspace member cannot write to the raw link table directly", async () => {
    const plainClient = await authenticatedClient(fixture.operatorOnly);
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "No Direct Write");
    const rawInsert = await plainClient.from("entity_record_person_links").insert({
      workspace_id: fixture.workspaceId,
      entity_type_id: fixture.personEntityTypeId,
      entity_record_id: recordId,
      user_id: fixture.workerA.id,
    });
    expect(rawInsert.error).not.toBeNull();
  });

  it("member candidate listing excludes members already linked elsewhere", async () => {
    // list_workspace_member_identities_authorized checks
    // private.is_workspace_member(...) against auth.uid() with no
    // service-role bypass (unlike the capability-gated governance RPCs
    // elsewhere in this suite) -- it must be called as a real authenticated
    // member, not the service-role admin client.
    const managerClient = await authenticatedClient(fixture.memberManager);
    const target = await createLinkableMember("candidate-exclusion-anchor");
    const recordId = await createRecord(fixture.workspaceId, fixture.personEntityTypeId, "Candidate Exclusion Anchor");
    const link = await setPersonLink(managerClient, fixture.workspaceId, recordId, target.id);
    expect(link.error).toBeNull();

    const candidates = await listUnlinkedWorkspaceMemberIdentities({
      workspaceId: fixture.workspaceId,
      supabase: managerClient,
    });
    expect(candidates.some((candidate) => candidate.userId === target.id)).toBe(false);
    expect(candidates.some((candidate) => candidate.userId === fixture.workerB.id)).toBe(true);

    const cleanup = await removePersonLink(managerClient, fixture.workspaceId, recordId);
    expect(cleanup.error).toBeNull();
  });
});
