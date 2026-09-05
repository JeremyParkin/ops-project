// DB/RPC-level verification for Phase 12.2 People-Sensitive Read Access
// (migrations 0100-0103). Covers: entity_types sensitive-access metadata and
// the people_data.view_all capability; private.can_view_people_sensitive_record
// semantics (non-sensitive pass-through, override/impersonation boundary,
// subject/manager/author resolution, fail-closed no-subject behavior,
// archived-Person subject retention); entity_records/entity_record_relation_values
// RLS composition; set_entity_type_people_sensitive_access_authorized
// configuration guards (Person-type requirement, field validity,
// Process/Workflow conflict, existing-record subject validation,
// archived-Person acceptance); the extended set_person_entity_type_authorized
// redesignation guard; SECURITY DEFINER RPC enforcement in
// create/update/delete/bulk-create/archive-restore; search, comment, and
// input-request visibility folding; public API refusal; and the app-level
// reference-count leak fix.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import {
  createSupabaseTestClient,
  deleteE2eUsers,
  DEMO_WORKSPACE_ID,
  getE2eWorkspaceAdministratorRoleId,
} from "../../tests/e2e/helpers/supabase-test-data";
import { apiKeyPreview, generateApiKey, hashApiKey } from "./api-key-signing";

type User = { id: string; email: string; password: string };

type Fixture = {
  workspaceId: string;
  personEntityTypeId: string;
  personNameFieldKey: string;
  reviewEntityTypeId: string;
  subjectFieldId: string;
  reviewerFieldId: string;
  scoreFieldId: string;
  scoreFieldKey: string;
  ordinaryEntityTypeId: string;
  ordinaryNameFieldId: string;
  ordinaryNameFieldKey: string;
  subjectPersonRecordId: string;
  reviewerPersonRecordId: string;
  coworkerPersonRecordId: string;
  builder: User; // schema.manage + workspace.manage_members/roles + automation.manage + records.operate + impersonate_users + people_data.view_all (the "real admin")
  privileged: User; // records.operate + people_data.view_all, NOT the impersonation admin
  coworker: User; // records.operate only, unrelated
  subjectUser: User; // records.operate only, is the subject
  managerUser: User; // records.operate only, is the primary manager
  otherManagerUser: User; // records.operate only, becomes manager later
  reviewerUser: User; // records.operate only, is the author/reviewer
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
const clientCache = new Map<string, Promise<SupabaseClient>>();

function uniqueEmail(label: string) {
  return `e2e-people-sensitive-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `PeopleSensitive-${randomUUID()}!`;
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
  const { error } = await admin.from("workspaces").insert({ id: workspaceId, name: `${name} ${workspaceId.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length > 0) {
    const { error } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })));
    if (error) throw new Error(error.message);
  }
  return roleId;
}

async function addMembership(workspaceId: string, userId: string, roleId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role_id: roleId });
  if (error) throw new Error(error.message);
}

async function memberWithCapabilities(workspaceId: string, label: string, capabilities: string[]): Promise<User> {
  const user = await createUser(label);
  const roleId = await createRole(workspaceId, `${label}-${randomUUID().slice(0, 6)}`, capabilities);
  await addMembership(workspaceId, user.id, roleId);
  return user;
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

async function createField(
  workspaceId: string,
  entityTypeId: string,
  opts: { key: string; name: string; type: string; position: number; required?: boolean; relatedEntityTypeId?: string },
) {
  const admin = createSupabaseTestClient();
  const fieldId = randomUUID();
  // field_definitions.key is unique per WORKSPACE (0001), not per entity
  // type -- multiple entity types in this fixture reuse the same logical
  // key ("name"), so a random suffix keeps every insert collision-free
  // regardless of call order.
  const uniqueKey = `${opts.key}_${fieldId.slice(0, 8)}`;
  const { error } = await admin.from("field_definitions").insert({
    id: fieldId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    key: uniqueKey,
    name: opts.name,
    slug: opts.key,
    type: opts.type,
    required: opts.required ?? false,
    position: opts.position,
    related_entity_type_id: opts.relatedEntityTypeId ?? null,
  });
  if (error) throw new Error(error.message);
  return { id: fieldId, key: uniqueKey };
}

async function createRecordDirect(workspaceId: string, entityTypeId: string, values: Record<string, unknown> = {}) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin.from("entity_records").insert({ id: recordId, workspace_id: workspaceId, entity_type_id: entityTypeId, values });
  if (error) throw new Error(error.message);
  return recordId;
}

async function setPersonLink(workspaceId: string, personEntityTypeId: string, entityRecordId: string, userId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("entity_record_person_links").insert({ workspace_id: workspaceId, entity_type_id: personEntityTypeId, entity_record_id: entityRecordId, user_id: userId });
  if (error) throw new Error(error.message);
}

async function setPrimaryManager(workspaceId: string, reportUserId: string, managerUserId: string) {
  const admin = createSupabaseTestClient();
  await admin.from("workspace_reporting_relationships").delete().eq("workspace_id", workspaceId).eq("report_user_id", reportUserId);
  const { error } = await admin.from("workspace_reporting_relationships").insert({ workspace_id: workspaceId, manager_user_id: managerUserId, report_user_id: reportUserId });
  if (error) throw new Error(error.message);
}

async function configureSensitive(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  opts: {
    peopleSensitive: boolean;
    subjectFieldId: string | null;
    authorFieldId: string | null;
    subjectCanView: boolean;
    managerCanView: boolean;
    authorCanView: boolean;
  },
) {
  return client.rpc("set_entity_type_people_sensitive_access_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_people_sensitive: opts.peopleSensitive,
    p_subject_person_field_id: opts.subjectFieldId,
    p_author_person_field_id: opts.authorFieldId,
    p_subject_can_view: opts.subjectCanView,
    p_manager_can_view: opts.managerCanView,
    p_author_can_view: opts.authorCanView,
  });
}

async function createReview(client: SupabaseClient, entityTypeId: string, relations: Array<{ field_definition_id: string; target_entity_type_id: string; target_record_id: string }>, values?: Record<string, unknown>) {
  return client.rpc("create_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_entity_type_id: entityTypeId,
    p_values: values ?? { [fixture.scoreFieldKey]: "3" },
    p_relations: relations,
  });
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function impersonate(realActor: SupabaseClient, targetUserId: string) {
  await endAnyActiveSession(realActor);
  const result = await realActor.rpc("start_impersonation_session_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_target_user_id: targetUserId,
  });
  if (result.error) throw new Error(result.error.message);
}

async function createFixture(): Promise<Fixture> {
  const workspaceId = await createWorkspace("E2E People Sensitive");

  const builder = await memberWithCapabilities(workspaceId, "builder", [
    "schema.manage",
    "automation.manage",
    "workspace.manage_members",
    "workspace.manage_roles",
    "workspace.impersonate_users",
    "workspace.manage_integrations",
    "people_data.view_all",
    "records.operate",
  ]);
  const privileged = await memberWithCapabilities(workspaceId, "privileged", ["records.operate", "people_data.view_all"]);
  const coworker = await memberWithCapabilities(workspaceId, "coworker", ["records.operate"]);
  const subjectUser = await memberWithCapabilities(workspaceId, "subject", ["records.operate"]);
  const managerUser = await memberWithCapabilities(workspaceId, "manager", ["records.operate"]);
  const otherManagerUser = await memberWithCapabilities(workspaceId, "other-manager", ["records.operate"]);
  const reviewerUser = await memberWithCapabilities(workspaceId, "reviewer", ["records.operate"]);

  const personEntityTypeId = await createEntityType(workspaceId, `Person ${workspaceId.slice(0, 6)}`);
  const { key: personNameFieldKey } = await createField(workspaceId, personEntityTypeId, { key: "name", name: "Name", type: "text", position: 1 });

  const builderClient = await authenticatedClient(builder);
  const designate = await builderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: personEntityTypeId });
  if (designate.error) throw new Error(`designate person type: ${designate.error.message}`);

  const subjectPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Subject Person" });
  const reviewerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Reviewer Person" });
  const coworkerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Coworker Person" });
  await setPersonLink(workspaceId, personEntityTypeId, subjectPersonRecordId, subjectUser.id);
  await setPersonLink(workspaceId, personEntityTypeId, reviewerPersonRecordId, reviewerUser.id);
  await setPersonLink(workspaceId, personEntityTypeId, coworkerPersonRecordId, coworker.id);
  await setPrimaryManager(workspaceId, subjectUser.id, managerUser.id);

  const reviewEntityTypeId = await createEntityType(workspaceId, `Quality Review ${workspaceId.slice(0, 6)}`);
  const { id: subjectFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    key: "reviewedEmployee", name: "Reviewed Employee", type: "relation", position: 1, relatedEntityTypeId: personEntityTypeId,
  });
  const { id: reviewerFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    key: "reviewer", name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: personEntityTypeId,
  });
  const { id: scoreFieldId, key: scoreFieldKey } = await createField(workspaceId, reviewEntityTypeId, { key: "score", name: "Score", type: "text", position: 3 });

  const enable = await configureSensitive(builderClient, workspaceId, reviewEntityTypeId, {
    peopleSensitive: true,
    subjectFieldId,
    authorFieldId: reviewerFieldId,
    subjectCanView: true,
    managerCanView: true,
    authorCanView: true,
  });
  if (enable.error) throw new Error(`enable sensitivity: ${enable.error.message}`);

  const ordinaryEntityTypeId = await createEntityType(workspaceId, `Ordinary ${workspaceId.slice(0, 6)}`);
  const { id: ordinaryNameFieldId, key: ordinaryNameFieldKey } = await createField(workspaceId, ordinaryEntityTypeId, { key: "name", name: "Name", type: "text", position: 1 });

  return {
    workspaceId, personEntityTypeId, personNameFieldKey, reviewEntityTypeId, subjectFieldId, reviewerFieldId, scoreFieldId, scoreFieldKey,
    ordinaryEntityTypeId, ordinaryNameFieldId, ordinaryNameFieldKey,
    subjectPersonRecordId, reviewerPersonRecordId, coworkerPersonRecordId,
    builder, privileged, coworker, subjectUser, managerUser, otherManagerUser, reviewerUser,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
}, 60_000);

afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];

  if (createdWorkspaceIds.length > 0) {
    await admin.from("workspaces").update({ person_entity_type_id: null }).in("id", createdWorkspaceIds);
    await admin.from("entity_types").update({ subject_person_field_id: null, author_person_field_id: null }).in("workspace_id", createdWorkspaceIds);
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) failures.push(`workspaces: ${error.message}`);
  }

  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) {
    throw new Error(`people-sensitive-access-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// 1. Live schema confirmation
// ---------------------------------------------------------------------------
describe("schema confirmation", () => {
  it("entity_types carries the sensitive-access metadata columns", async () => {
    const admin = createSupabaseTestClient();
    const { data, error } = await admin
      .from("entity_types")
      .select("people_sensitive, subject_person_field_id, author_person_field_id, subject_can_view, manager_can_view, author_can_view")
      .eq("id", fixture.reviewEntityTypeId)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      people_sensitive: true,
      subject_person_field_id: fixture.subjectFieldId,
      author_person_field_id: fixture.reviewerFieldId,
      subject_can_view: true,
      manager_can_view: true,
      author_can_view: true,
    });
  });

  it("people_data.view_all was backfilled to the pre-existing demo workspace's built-in Workspace administrator role", async () => {
    // Newly-created test workspaces never get an automatic built-in role
    // (person-link-commit.test.ts confirms every fixture provisions its own
    // roles explicitly) -- the ONE-TIME migration backfill (0100) only ever
    // touched roles that already existed with is_builtin = true at the
    // moment 0100 ran. The only reliable proof of that backfill is a real,
    // pre-existing workspace whose built-in role predates this migration --
    // the demo workspace referenced throughout this test suite's helpers.
    const admin = createSupabaseTestClient();
    const adminRoleId = await getE2eWorkspaceAdministratorRoleId(admin, DEMO_WORKSPACE_ID);
    const { data: capRow, error: capError } = await admin
      .from("workspace_role_capabilities")
      .select("capability")
      .eq("workspace_id", DEMO_WORKSPACE_ID)
      .eq("role_id", adminRoleId)
      .eq("capability", "people_data.view_all")
      .maybeSingle();
    expect(capError).toBeNull();
    expect(capRow).not.toBeNull();

    // The custom roles created for this fixture (builder/privileged/etc.)
    // were never granted people_data.view_all except where explicitly listed.
    const { data: coworkerCaps, error: coworkerCapsError } = await admin
      .from("workspace_role_capabilities")
      .select("capability")
      .eq("workspace_id", fixture.workspaceId)
      .in(
        "role_id",
        (
          await admin
            .from("workspace_memberships")
            .select("role_id")
            .eq("workspace_id", fixture.workspaceId)
            .eq("user_id", fixture.coworker.id)
        ).data?.map((r) => (r as { role_id: string }).role_id) ?? [],
      );
    expect(coworkerCapsError).toBeNull();
    expect((coworkerCaps ?? []).some((c) => (c as { capability: string }).capability === "people_data.view_all")).toBe(false);
  });

  it("relation_values_operate_write is gone and authenticated cannot mutate entity_record_relation_values directly", async () => {
    const client = await authenticatedClient(fixture.builder);
    const { error } = await client.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId,
      source_entity_type_id: fixture.reviewEntityTypeId,
      source_record_id: randomUUID(),
      field_definition_id: fixture.subjectFieldId,
      target_entity_type_id: fixture.personEntityTypeId,
      target_record_id: fixture.subjectPersonRecordId,
    });
    // Permission-denied at the GRANT layer, not an RLS policy decision --
    // authenticated has never held insert on this table (0022/0023).
    expect(error).not.toBeNull();
    expect(error?.message.toLowerCase()).toMatch(/permission denied|rls|policy/);
  });

  it("no direct INSERT/DELETE is possible on entity_records for authenticated", async () => {
    const client = await authenticatedClient(fixture.builder);
    const { error: insertError } = await client.from("entity_records").insert({
      id: randomUUID(), workspace_id: fixture.workspaceId, entity_type_id: fixture.ordinaryEntityTypeId, values: {},
    });
    expect(insertError).not.toBeNull();

    const anyId = await createRecordDirect(fixture.workspaceId, fixture.ordinaryEntityTypeId, {});
    const { error: deleteError } = await client.from("entity_records").delete().eq("id", anyId);
    expect(deleteError).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. RLS composition
// ---------------------------------------------------------------------------
describe("RLS composition", () => {
  it("an unrelated workspace member cannot SELECT a sensitive record, but ordinary records remain visible", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, { [fixture.scoreFieldKey]: "hidden-from-coworker" });
    const admin = createSupabaseTestClient();
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: reviewId,
      field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId,
    });

    const coworkerClient = await authenticatedClient(fixture.coworker);
    const hidden = await coworkerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(hidden.data).toBeNull();

    const ordinaryId = await createRecordDirect(fixture.workspaceId, fixture.ordinaryEntityTypeId, { [fixture.ordinaryNameFieldKey]: "Visible" });
    const visible = await coworkerClient.from("entity_records").select("id").eq("id", ordinaryId).maybeSingle();
    expect(visible.data?.id).toBe(ordinaryId);
  });

  it("holding records.operate does not create a SELECT bypass for a sensitive record", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const coworkerClient = await authenticatedClient(fixture.coworker); // records.operate holder, unrelated
    const result = await coworkerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(result.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Subject / manager / author matrix
// ---------------------------------------------------------------------------
describe("subject/manager/author visibility", () => {
  it("subject_can_view gates subject access independently", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
    ])).data as string;

    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const visible = await subjectClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(visible.data?.id).toBe(reviewId);

    const disable = await configureSensitive(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      peopleSensitive: true, subjectFieldId: fixture.subjectFieldId, authorFieldId: fixture.reviewerFieldId,
      subjectCanView: false, managerCanView: true, authorCanView: true,
    });
    expect(disable.error).toBeNull();
    const nowHidden = await subjectClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(nowHidden.data).toBeNull();

    // restore
    const restore = await configureSensitive(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      peopleSensitive: true, subjectFieldId: fixture.subjectFieldId, authorFieldId: fixture.reviewerFieldId,
      subjectCanView: true, managerCanView: true, authorCanView: true,
    });
    expect(restore.error).toBeNull();
  });

  it("manager_can_view gates manager access independently, and access moves dynamically with the reporting relationship", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
    ])).data as string;

    const managerClient = await authenticatedClient(fixture.managerUser);
    const visible = await managerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(visible.data?.id).toBe(reviewId);

    // Reassign the subject's primary manager -- old manager loses access,
    // new manager gains it, with no code change, purely from the live table.
    await setPrimaryManager(fixture.workspaceId, fixture.subjectUser.id, fixture.otherManagerUser.id);
    const oldManagerNow = await managerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(oldManagerNow.data).toBeNull();

    const newManagerClient = await authenticatedClient(fixture.otherManagerUser);
    const newManagerNow = await newManagerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(newManagerNow.data?.id).toBe(reviewId);

    // restore for later tests
    await setPrimaryManager(fixture.workspaceId, fixture.subjectUser.id, fixture.managerUser.id);
  });

  it("author_can_view gates reviewer access independently of the manager branch", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
      { field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.reviewerPersonRecordId },
    ])).data as string;

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const visible = await reviewerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(visible.data?.id).toBe(reviewId);

    // Change the subject's manager -- reviewer access is untouched.
    await setPrimaryManager(fixture.workspaceId, fixture.subjectUser.id, fixture.otherManagerUser.id);
    const stillVisible = await reviewerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(stillVisible.data?.id).toBe(reviewId);
    await setPrimaryManager(fixture.workspaceId, fixture.subjectUser.id, fixture.managerUser.id);
  });

  it("author_can_view cannot be enabled without a designated author field (DB-level and RPC-level)", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const result = await configureSensitive(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      peopleSensitive: true, subjectFieldId: fixture.subjectFieldId, authorFieldId: null,
      subjectCanView: true, managerCanView: true, authorCanView: true,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/reviewer|author/i);
  });

  it("a coworker with no team-lead concept in this schema gets no access merely from being a fellow workspace member", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const admin = createSupabaseTestClient();
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: reviewId,
      field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId,
    });
    const coworkerClient = await authenticatedClient(fixture.coworker);
    const result = await coworkerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(result.data).toBeNull();
  });

  it("a malformed sensitive record with no valid subject relation is visible only to people_data.view_all; the author relation does not rescue it", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    // Created with the AUTHOR relation set but deliberately no subject.
    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.reviewerPersonRecordId },
    ])).data as string;

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerSees = await reviewerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(reviewerSees.data).toBeNull();

    const coworkerClient = await authenticatedClient(fixture.coworker);
    const coworkerSees = await coworkerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(coworkerSees.data).toBeNull();

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const privilegedSees = await privilegedClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(privilegedSees.data?.id).toBe(reviewId);
  });
});

// ---------------------------------------------------------------------------
// 4. Privileged access / impersonation
// ---------------------------------------------------------------------------
describe("privileged access and impersonation", () => {
  it("people_data.view_all sees the sensitive record in ordinary (non-impersonating) operation", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const privilegedClient = await authenticatedClient(fixture.privileged);
    const result = await privilegedClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(result.data?.id).toBe(reviewId);
  });

  it("the people_data.view_all override does NOT leak while the real actor is impersonating an unrelated coworker", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const builderClient = await authenticatedClient(fixture.builder); // holds people_data.view_all AND impersonate_users
    await impersonate(builderClient, fixture.coworker.id);
    const result = await builderClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(result.data).toBeNull();
    await endAnyActiveSession(builderClient);
  });

  it("subject/manager/author access follows the effective user while impersonating", async () => {
    const reviewId = (await createReview(await authenticatedClient(fixture.builder), fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
    ])).data as string;

    const builderClient = await authenticatedClient(fixture.builder);
    await impersonate(builderClient, fixture.subjectUser.id);
    const result = await builderClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(result.data?.id).toBe(reviewId);
    await endAnyActiveSession(builderClient);
  });

  it("set_entity_type_people_sensitive_access_authorized rejects while impersonating", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    await impersonate(builderClient, fixture.coworker.id);
    const result = await configureSensitive(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      peopleSensitive: true, subjectFieldId: fixture.subjectFieldId, authorFieldId: fixture.reviewerFieldId,
      subjectCanView: true, managerCanView: true, authorCanView: true,
    });
    expect(result.error?.message).toMatch(/impersonat/i);
    await endAnyActiveSession(builderClient);
  });

  it("post-creation subject/author correction rejects while impersonating, even though the real actor holds people_data.view_all", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
    ])).data as string;

    await impersonate(builderClient, fixture.subjectUser.id); // effective user CAN see the record (subject)
    const attempt = await builderClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.scoreFieldKey]: "3" }, p_relation_field_ids: [fixture.subjectFieldId],
      p_relations: [{ field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.coworkerPersonRecordId }],
    });
    expect(attempt.error).not.toBeNull();
    expect(attempt.error?.message).toMatch(/impersonat|privileg/i);
    await endAnyActiveSession(builderClient);
  });
});

// ---------------------------------------------------------------------------
// 5. Configuration guards
// ---------------------------------------------------------------------------
describe("sensitive-access configuration guards", () => {
  it("cannot enable sensitivity without a designated Person type", async () => {
    const scratchWorkspaceId = await createWorkspace("No Person Type");
    const scratchBuilder = await memberWithCapabilities(scratchWorkspaceId, "scratch-builder", ["schema.manage", "workspace.manage_members", "workspace.manage_roles"]);
    const scratchTypeId = await createEntityType(scratchWorkspaceId, "Scratch");
    const { id: scratchFieldId } = await createField(scratchWorkspaceId, scratchTypeId, { key: "subj", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: scratchTypeId });
    const client = await authenticatedClient(scratchBuilder);
    const result = await client.rpc("set_entity_type_people_sensitive_access_authorized", {
      p_workspace_id: scratchWorkspaceId, p_entity_type_id: scratchTypeId, p_people_sensitive: true,
      p_subject_person_field_id: scratchFieldId, p_author_person_field_id: null,
      p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: false,
    });
    expect(result.error?.message).toMatch(/no person type/i);
  });

  it("cannot use an invalid/non-Person subject field", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const result = await configureSensitive(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      peopleSensitive: true, subjectFieldId: fixture.scoreFieldId, authorFieldId: null,
      subjectCanView: true, managerCanView: true, authorCanView: false,
    });
    expect(result.error?.message).toMatch(/subject field/i);
  });

  it("cannot enable sensitivity when an existing record lacks a valid subject relation", async () => {
    const scratchTypeId = await createEntityType(fixture.workspaceId, "Scratch Missing Subject");
    const { id: scratchSubjectField } = await createField(fixture.workspaceId, scratchTypeId, { key: "subj", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: fixture.personEntityTypeId });
    await createRecordDirect(fixture.workspaceId, scratchTypeId, {}); // no relation at all
    const builderClient = await authenticatedClient(fixture.builder);
    const result = await configureSensitive(builderClient, fixture.workspaceId, scratchTypeId, {
      peopleSensitive: true, subjectFieldId: scratchSubjectField, authorFieldId: null,
      subjectCanView: true, managerCanView: true, authorCanView: false,
    });
    expect(result.error?.message).toMatch(/subject relation/i);
    expect(result.error?.message).toMatch(/1/);
  });

  it("cannot enable sensitivity while a Process Template targets the type, and Process Templates cannot target an already-sensitive type", async () => {
    const scratchTypeId = await createEntityType(fixture.workspaceId, "Scratch Process Conflict");
    const { id: scratchSubjectField } = await createField(fixture.workspaceId, scratchTypeId, { key: "subj", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: fixture.personEntityTypeId });
    const builderClient = await authenticatedClient(fixture.builder);

    const saved = await builderClient.rpc("save_process_template_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_template_id: null, p_name: "Conflict Template",
      p_description: null, p_applies_to_entity_type_id: scratchTypeId,
      p_steps: [
        {
          client_key: "step-1", node_id: "", node_type: "human_task", parallel_group_id: null,
          name: "Step 1", assignee_user_id: "", due_rule: null, wait_rule: null,
          condition_wait_rule: null, action_config: null, routes: [],
        },
      ],
    });
    expect(saved.error).toBeNull();

    const enableResult = await configureSensitive(builderClient, fixture.workspaceId, scratchTypeId, {
      peopleSensitive: true, subjectFieldId: scratchSubjectField, authorFieldId: null,
      subjectCanView: true, managerCanView: true, authorCanView: false,
    });
    expect(enableResult.error?.message).toMatch(/process template/i);

    // Reverse direction: attaching a NEW template to an already-sensitive type.
    const reverseResult = await builderClient.rpc("save_process_template_authorized", {
      p_workspace_id: fixture.workspaceId, p_process_template_id: null, p_name: "Sensitive Target Template",
      p_description: null, p_applies_to_entity_type_id: fixture.reviewEntityTypeId,
      p_steps: [
        {
          client_key: "step-1", node_id: "", node_type: "human_task", parallel_group_id: null,
          name: "Step 1", assignee_user_id: "", due_rule: null, wait_rule: null,
          condition_wait_rule: null, action_config: null, routes: [],
        },
      ],
    });
    expect(reverseResult.error?.message).toMatch(/people-sensitive/i);
  });

  it("cannot enable sensitivity while a Workflow targets the type, and Workflow configuration cannot target an already-sensitive type", async () => {
    const scratchTypeId = await createEntityType(fixture.workspaceId, "Scratch Workflow Conflict");
    const { id: scratchSubjectField } = await createField(fixture.workspaceId, scratchTypeId, { key: "subj", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: fixture.personEntityTypeId });
    const admin = createSupabaseTestClient();
    const { error: workflowError } = await admin.from("workflows").insert({
      workspace_id: fixture.workspaceId, name: "Conflict Workflow", trigger_type: "record_created",
      trigger_entity_type_id: scratchTypeId, actions: [{ actionType: "create_record", actionTargetEntityTypeId: fixture.ordinaryEntityTypeId }],
    });
    expect(workflowError).toBeNull();

    const builderClient = await authenticatedClient(fixture.builder);
    const enableResult = await configureSensitive(builderClient, fixture.workspaceId, scratchTypeId, {
      peopleSensitive: true, subjectFieldId: scratchSubjectField, authorFieldId: null,
      subjectCanView: true, managerCanView: true, authorCanView: false,
    });
    expect(enableResult.error?.message).toMatch(/workflow/i);

    // Reverse direction: a new workflow triggering on an already-sensitive type.
    const { error: reverseError } = await admin.from("workflows").insert({
      workspace_id: fixture.workspaceId, name: "Targets Sensitive", trigger_type: "record_created",
      trigger_entity_type_id: fixture.reviewEntityTypeId, actions: [{ actionType: "create_record", actionTargetEntityTypeId: fixture.ordinaryEntityTypeId }],
    });
    expect(reverseError).not.toBeNull();
    expect(reverseError?.message).toMatch(/people-sensitive/i);
  });

  it("cannot change or clear the workspace Person type while any people_sensitive EntityType exists, even with ZERO entity_record_person_links rows -- and same-value designation remains a clean no-op", async () => {
    // Deliberately a fresh scratch workspace, not the shared fixture: proves
    // the guard fires purely from an active people_sensitive EntityType,
    // independent of Phase 12.1's own "links exist" check -- the shared
    // fixture workspace already has links, which would mask this exact
    // scenario (zero links, live sensitive configuration) the correction
    // was about.
    const scratchWorkspaceId = await createWorkspace("Redesignation Guard");
    const scratchBuilder = await memberWithCapabilities(scratchWorkspaceId, "redesig-builder", [
      "schema.manage", "workspace.manage_members", "workspace.manage_roles",
    ]);
    const scratchPersonTypeId = await createEntityType(scratchWorkspaceId, "Scratch Person");
    const { key: scratchPersonNameKey } = await createField(scratchWorkspaceId, scratchPersonTypeId, { key: "name", name: "Name", type: "text", position: 1 });
    const scratchBuilderClient = await authenticatedClient(scratchBuilder);
    const designate = await scratchBuilderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: scratchWorkspaceId, p_entity_type_id: scratchPersonTypeId });
    expect(designate.error).toBeNull();

    const scratchSensitiveTypeId = await createEntityType(scratchWorkspaceId, "Scratch Sensitive");
    const { id: scratchSubjectFieldId } = await createField(scratchWorkspaceId, scratchSensitiveTypeId, {
      key: "subj", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: scratchPersonTypeId,
    });
    const unlinkedPersonId = await createRecordDirect(scratchWorkspaceId, scratchPersonTypeId, { [scratchPersonNameKey]: "Unlinked Person" });
    const admin = createSupabaseTestClient();
    await admin.from("entity_record_relation_values").insert({
      workspace_id: scratchWorkspaceId, source_entity_type_id: scratchSensitiveTypeId,
      source_record_id: await createRecordDirect(scratchWorkspaceId, scratchSensitiveTypeId, {}),
      field_definition_id: scratchSubjectFieldId, target_entity_type_id: scratchPersonTypeId, target_record_id: unlinkedPersonId,
    });
    const enable = await configureSensitive(scratchBuilderClient, scratchWorkspaceId, scratchSensitiveTypeId, {
      peopleSensitive: true, subjectFieldId: scratchSubjectFieldId, authorFieldId: null,
      subjectCanView: true, managerCanView: true, authorCanView: false,
    });
    expect(enable.error).toBeNull();

    // Confirmed precondition: zero person links exist in this workspace at all.
    const { data: linkRows } = await admin.from("entity_record_person_links").select("entity_record_id").eq("workspace_id", scratchWorkspaceId);
    expect(linkRows ?? []).toHaveLength(0);

    const anotherPersonTypeId = await createEntityType(scratchWorkspaceId, "Alt Person");

    const clearAttempt = await scratchBuilderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: scratchWorkspaceId, p_entity_type_id: null });
    expect(clearAttempt.error?.message).toMatch(/sensitive/i);

    const changeAttempt = await scratchBuilderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: scratchWorkspaceId, p_entity_type_id: anotherPersonTypeId });
    expect(changeAttempt.error?.message).toMatch(/sensitive/i);

    const sameValue = await scratchBuilderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: scratchWorkspaceId, p_entity_type_id: scratchPersonTypeId });
    expect(sameValue.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Archived-Person semantics
// ---------------------------------------------------------------------------
describe("archived-Person semantics", () => {
  it("archiving the subject's Person record preserves subject/manager/author access to existing sensitive history", async () => {
    const admin = createSupabaseTestClient();
    const archivablePersonId = await createRecordDirect(fixture.workspaceId, fixture.personEntityTypeId, { [fixture.personNameFieldKey]: "Archivable Subject" });
    const archivableUser = await memberWithCapabilities(fixture.workspaceId, "archivable-subject", ["records.operate"]);
    await setPersonLink(fixture.workspaceId, fixture.personEntityTypeId, archivablePersonId, archivableUser.id);
    await setPrimaryManager(fixture.workspaceId, archivableUser.id, fixture.managerUser.id);

    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: archivablePersonId },
      { field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.reviewerPersonRecordId },
    ])).data as string;

    await admin.from("entity_records").update({ archived_at: new Date().toISOString() }).eq("id", archivablePersonId);

    const subjectClient = await authenticatedClient(archivableUser);
    const subjectSees = await subjectClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(subjectSees.data?.id).toBe(reviewId);

    const managerClient = await authenticatedClient(fixture.managerUser);
    const managerSees = await managerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(managerSees.data?.id).toBe(reviewId);

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerSees = await reviewerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(reviewerSees.data?.id).toBe(reviewId);

    // A NEW sensitive record cannot target the already-archived Person --
    // the ordinary, unrelated relation-target-integrity rule (0082) still
    // applies; this is a different rule from historical-access retention.
    const newRecordAttempt = await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: archivablePersonId },
    ]);
    expect(newRecordAttempt.error).not.toBeNull();
    expect(newRecordAttempt.error?.message).toMatch(/active record/i);

    // Enabling sensitivity validation must ALSO accept the archived Person
    // as a structurally valid historical subject -- proven by configuring a
    // fresh scratch type whose only existing record's subject is already archived.
    const scratchTypeId = await createEntityType(fixture.workspaceId, "Scratch Archived Subject Enable");
    const { id: scratchSubjectField } = await createField(fixture.workspaceId, scratchTypeId, { key: "subj", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: fixture.personEntityTypeId });
    const scratchRecordId = await createRecordDirect(fixture.workspaceId, scratchTypeId, {});
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: scratchTypeId, source_record_id: scratchRecordId,
      field_definition_id: scratchSubjectField, target_entity_type_id: fixture.personEntityTypeId, target_record_id: archivablePersonId,
    });
    const enableResult = await configureSensitive(builderClient, fixture.workspaceId, scratchTypeId, {
      peopleSensitive: true, subjectFieldId: scratchSubjectField, authorFieldId: null,
      subjectCanView: true, managerCanView: true, authorCanView: false,
    });
    expect(enableResult.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Mutation authority
// ---------------------------------------------------------------------------
describe("mutation authority on existing records", () => {
  it("a records.operate holder cannot update a hidden sensitive record; hidden and nonexistent are indistinguishable", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const admin = createSupabaseTestClient();
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: reviewId,
      field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId,
    });

    const coworkerClient = await authenticatedClient(fixture.coworker);
    const hiddenUpdate = await coworkerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.scoreFieldKey]: "tampered" }, p_relation_field_ids: [], p_relations: [],
    });
    const nonexistentUpdate = await coworkerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: randomUUID(),
      p_values: { [fixture.scoreFieldKey]: "tampered" }, p_relation_field_ids: [], p_relations: [],
    });
    expect(hiddenUpdate.error?.message).toBe(nonexistentUpdate.error?.message);
    expect(hiddenUpdate.error?.message).toMatch(/record not found/i);
  });

  it("a records.operate holder cannot delete a hidden sensitive record", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const coworkerClient = await authenticatedClient(fixture.coworker);
    const result = await coworkerClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(result.error?.message).toMatch(/record not found/i);
  });

  it("single archive/restore cannot target a hidden sensitive record", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const coworkerClient = await authenticatedClient(fixture.coworker);
    const result = await coworkerClient.from("entity_records").update({ archived_at: new Date().toISOString() }).eq("id", reviewId).select("id");
    expect(result.data ?? []).toHaveLength(0);
  });

  it("bulk archive/restore cannot include hidden sensitive ids -- the whole batch is rejected", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const visibleId = await createRecordDirect(fixture.workspaceId, fixture.ordinaryEntityTypeId, {});
    const coworkerClient = await authenticatedClient(fixture.coworker);
    const result = await coworkerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.ordinaryEntityTypeId, p_record_ids: [visibleId], p_archived: true,
    });
    expect(result.error).toBeNull();
    const mixedResult = await coworkerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });
    expect(mixedResult.error?.message).toMatch(/could not be found/i);
  });

  it("ordinary visible sensitive-record fields remain editable under records.operate, and unchanged subject/author relations require no governance authority", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
    ])).data as string;

    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const editResult = await subjectClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.scoreFieldKey]: "5" },
      p_relation_field_ids: [fixture.subjectFieldId],
      p_relations: [{ field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId }],
    });
    expect(editResult.error).toBeNull();
  });

  it("changing the subject post-creation requires people_data.view_all against the real actor and is rejected for an ordinary visible-record editor", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
    ])).data as string;

    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const attempt = await subjectClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: {}, p_relation_field_ids: [fixture.subjectFieldId],
      p_relations: [{ field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.coworkerPersonRecordId }],
    });
    expect(attempt.error).not.toBeNull();
    expect(attempt.error?.message).toMatch(/privileg/i);

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const allowed = await privilegedClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: {}, p_relation_field_ids: [fixture.subjectFieldId],
      p_relations: [{ field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId }],
    });
    expect(allowed.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Creation
// ---------------------------------------------------------------------------
describe("creation authority", () => {
  it("every relation target must be visible to the creator; hidden and nonexistent targets are indistinguishable", async () => {
    const hiddenReviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const admin = createSupabaseTestClient();
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: hiddenReviewId,
      field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId,
    });

    // Give the ordinary entity type a relation field pointing at the sensitive type.
    const { id: linkFieldId } = await createField(fixture.workspaceId, fixture.ordinaryEntityTypeId, {
      key: "reviewLink", name: "Review Link", type: "relation", position: 2, relatedEntityTypeId: fixture.reviewEntityTypeId,
    });

    const coworkerClient = await authenticatedClient(fixture.coworker);
    const hiddenTargetAttempt = await coworkerClient.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.ordinaryEntityTypeId, p_values: { [fixture.ordinaryNameFieldKey]: "x" },
      p_relations: [{ field_definition_id: linkFieldId, target_entity_type_id: fixture.reviewEntityTypeId, target_record_id: hiddenReviewId }],
    });
    const nonexistentTargetAttempt = await coworkerClient.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.ordinaryEntityTypeId, p_values: { [fixture.ordinaryNameFieldKey]: "x" },
      p_relations: [{ field_definition_id: linkFieldId, target_entity_type_id: fixture.reviewEntityTypeId, target_record_id: randomUUID() }],
    });
    expect(hiddenTargetAttempt.error?.message).toBe(nonexistentTargetAttempt.error?.message);
  });

  it("bulk creation applies the same target-visibility rule", async () => {
    const hiddenReviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const admin = createSupabaseTestClient();
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: hiddenReviewId,
      field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId,
    });
    const { id: linkFieldId } = await createField(fixture.workspaceId, fixture.ordinaryEntityTypeId, {
      key: `bulkReviewLink${randomUUID().slice(0, 6)}`, name: "Bulk Review Link", type: "relation", position: 3, relatedEntityTypeId: fixture.reviewEntityTypeId,
    });
    const coworkerClient = await authenticatedClient(fixture.coworker);
    const result = await coworkerClient.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.ordinaryEntityTypeId, p_import_id: randomUUID(),
      p_rows: [{ values: { [fixture.ordinaryNameFieldKey]: "bulk" }, relations: [{ field_definition_id: linkFieldId, target_entity_type_id: fixture.reviewEntityTypeId, target_record_id: hiddenReviewId }] }],
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/active record/i);
  });

  it("creating a sensitive record establishes the subject relation atomically -- no transient subject-less visible window", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const result = await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
      { field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.reviewerPersonRecordId },
    ]);
    expect(result.error).toBeNull();
    const reviewId = result.data as string;
    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const visible = await subjectClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle();
    expect(visible.data?.id).toBe(reviewId);
  });
});

// ---------------------------------------------------------------------------
// 9. Read leakage: search, relations
// ---------------------------------------------------------------------------
describe("read leakage prevention", () => {
  it("a hidden sensitive record does not appear in search, including exact-title search", async () => {
    const uniqueTitle = `Ultra-Unique-Title-${randomUUID()}`;
    const builderClient = await authenticatedClient(fixture.builder);
    await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
    ], { [fixture.scoreFieldKey]: uniqueTitle });

    const coworkerClient = await authenticatedClient(fixture.coworker);
    const result = await coworkerClient.rpc("search_workspace_records_authorized", {
      p_workspace_id: fixture.workspaceId, p_query: uniqueTitle, p_entity_type_id: null, p_limit_per_type: 20,
    });
    expect(result.error).toBeNull();
    expect(result.data ?? []).toHaveLength(0);

    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const subjectResult = await subjectClient.rpc("search_workspace_records_authorized", {
      p_workspace_id: fixture.workspaceId, p_query: uniqueTitle, p_entity_type_id: null, p_limit_per_type: 20,
    });
    expect((subjectResult.data ?? []).length).toBeGreaterThan(0);
  });

  it("relation rows involving a hidden sensitive record are invisible from either side", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const admin = createSupabaseTestClient();
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: reviewId,
      field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId,
    });

    const coworkerClient = await authenticatedClient(fixture.coworker);
    // From the review's own (hidden) side.
    const fromReview = await coworkerClient.from("entity_record_relation_values").select("*").eq("source_record_id", reviewId);
    expect(fromReview.data ?? []).toHaveLength(0);

    // From the ordinary, visible Person's side (reverse/"Related" direction) --
    // this is exactly the leak that would let a coworker infer the hidden
    // review's existence merely by opening the ordinary Person record.
    const fromPerson = await coworkerClient.from("entity_record_relation_values").select("*").eq("target_record_id", fixture.subjectPersonRecordId).eq("field_definition_id", fixture.subjectFieldId);
    expect(fromPerson.data ?? []).toHaveLength(0);

    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const subjectFromPerson = await subjectClient.from("entity_record_relation_values").select("*").eq("target_record_id", fixture.subjectPersonRecordId).eq("field_definition_id", fixture.subjectFieldId).eq("source_record_id", reviewId);
    expect(subjectFromPerson.data ?? []).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10. Comments and Input Requests
// ---------------------------------------------------------------------------
describe("comments and input requests reject hidden parent records", () => {
  it("all secured RPCs treat a hidden sensitive parent record as nonexistent", async () => {
    const reviewId = await createRecordDirect(fixture.workspaceId, fixture.reviewEntityTypeId, {});
    const admin = createSupabaseTestClient();
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: fixture.reviewEntityTypeId, source_record_id: reviewId,
      field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId,
    });
    const coworkerClient = await authenticatedClient(fixture.coworker);

    const listComments = await coworkerClient.rpc("list_record_comments_authorized", { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: reviewId, p_limit: 10 });
    expect(listComments.error?.message).toMatch(/record not found/i);

    const createComment = await coworkerClient.rpc("create_record_comment_authorized", { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: reviewId, p_body: "hi" });
    expect(createComment.error?.message).toMatch(/record not found/i);

    const createWithMentions = await coworkerClient.rpc("create_record_comment_with_mentions_authorized", { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: reviewId, p_body: "hi", p_mentioned_user_ids: [] });
    expect(createWithMentions.error?.message).toMatch(/record not found/i);

    const listRequests = await coworkerClient.rpc("list_record_input_requests_authorized", { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: reviewId, p_limit: 10 });
    expect(listRequests.error?.message).toMatch(/record not found/i);

    const createRequest = await coworkerClient.rpc("create_record_input_request_authorized", { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: reviewId, p_recipient_user_id: fixture.subjectUser.id, p_body: "please respond" });
    expect(createRequest.error?.message).toMatch(/record not found/i);

    // tombstone / respond / cancel: build a comment/request as the SUBJECT
    // (who can see it), then attempt the mutation as the coworker.
    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const subjectComment = await subjectClient.rpc("create_record_comment_authorized", { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: reviewId, p_body: "subject comment" });
    expect(subjectComment.error).toBeNull();
    const tombstone = await coworkerClient.rpc("tombstone_record_comment_authorized", { p_workspace_id: fixture.workspaceId, p_comment_id: subjectComment.data });
    expect(tombstone.error?.message).toMatch(/comment not found/i);

    // Recipient is the coworker themselves -- so the RPC's own "only the
    // recipient can respond" check passes, isolating the visibility check
    // as the actual reason this must still be rejected.
    const subjectRequest = await subjectClient.rpc("create_record_input_request_authorized", { p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: reviewId, p_recipient_user_id: fixture.coworker.id, p_body: "req" });
    expect(subjectRequest.error).toBeNull();
    const respond = await coworkerClient.rpc("respond_record_input_request_authorized", { p_workspace_id: fixture.workspaceId, p_request_id: subjectRequest.data, p_body: "resp" });
    expect(respond.error?.message).toMatch(/record not found/i);
    const cancel = await coworkerClient.rpc("cancel_record_input_request_authorized", { p_workspace_id: fixture.workspaceId, p_request_id: subjectRequest.data });
    expect(cancel.error?.message).toMatch(/request not found/i);
  });
});

// ---------------------------------------------------------------------------
// 11. Public API
// ---------------------------------------------------------------------------
describe("public API refuses people-sensitive types", () => {
  async function issueApiKey(client: SupabaseClient) {
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const { data, error } = await client.rpc("create_api_key_authorized", { p_workspace_id: fixture.workspaceId, p_name: "Security Suite Key", p_key_hash: keyHash, p_key_preview: apiKeyPreview(rawKey) });
    if (error || !data?.[0]) throw new Error(error?.message ?? "create_api_key_authorized returned no row.");
    return keyHash;
  }

  it("list_objects_for_api_key excludes the sensitive type; get/list/get-record refuse it consistently", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const keyHash = await issueApiKey(builderClient);
    const admin = createSupabaseTestClient();

    const reviewId = (await createReview(builderClient, fixture.reviewEntityTypeId, [
      { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId },
    ])).data as string;

    const objects = await admin.rpc("list_objects_for_api_key", { p_key_hash: keyHash, p_limit: 200 });
    expect(objects.error).toBeNull();
    expect((objects.data ?? []).some((o: { id: string }) => o.id === fixture.reviewEntityTypeId)).toBe(false);
    expect((objects.data ?? []).some((o: { id: string }) => o.id === fixture.ordinaryEntityTypeId)).toBe(true);

    const object = await admin.rpc("get_object_for_api_key", { p_key_hash: keyHash, p_entity_type_id: fixture.reviewEntityTypeId });
    expect(object.data ?? []).toHaveLength(0);

    const records = await admin.rpc("list_records_for_api_key", { p_key_hash: keyHash, p_entity_type_id: fixture.reviewEntityTypeId, p_limit: 50 });
    expect(records.data ?? []).toHaveLength(0);

    const record = await admin.rpc("get_record_for_api_key", { p_key_hash: keyHash, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId });
    expect(record.data ?? []).toHaveLength(0);
  });
});
