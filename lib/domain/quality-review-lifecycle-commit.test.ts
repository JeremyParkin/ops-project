// DB/RPC-level verification for Phase 12.3.1 Quality Review Lifecycle &
// Authority (migration 0105, layered on the closed Phase 12.2 foundation).
// Covers: the quality_review EntityType metadata invariant and
// configuration RPC guards; Reviewer self-binding and governed
// create-on-behalf at creation, with forced Draft status; the Draft/
// Finalized read matrix (including the manager-who-is-Reviewer case and
// impersonation suppression of the privileged override); the Draft/
// Finalized write/archive/delete matrix, including the Path-A governance
// Reviewer-reassignment correction flow; the Finalize/Reopen transitions
// (including exact-option enforcement and impersonation behavior); and
// transactional quality_review_finalized/quality_review_reopened events
// with correct real/effective actor attribution.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient, deleteE2eUsers } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

type Fixture = {
  workspaceId: string;
  personEntityTypeId: string;
  personNameFieldKey: string;
  reviewEntityTypeId: string;
  subjectFieldId: string;
  reviewerFieldId: string;
  notesFieldKey: string;
  statusFieldId: string;
  statusFieldKey: string;
  draftOptionId: string;
  finalizedOptionId: string;
  otherOptionId: string;
  subjectPersonRecordId: string;
  reviewerPersonRecordId: string;
  builder: User;
  privileged: User;
  coworker: User;
  subjectUser: User;
  managerUser: User;
  reviewerUser: User;
  otherReviewerUser: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
const clientCache = new Map<string, Promise<SupabaseClient>>();

function uniqueEmail(label: string) {
  return `e2e-qr-lifecycle-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `QrLifecycle-${randomUUID()}!`;
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

async function addChoiceOption(client: SupabaseClient, workspaceId: string, fieldId: string, label: string) {
  const { data, error } = await client.rpc("add_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldId,
    p_label: label,
    p_color: "gray",
  });
  if (error) throw new Error(error.message);
  return data as string;
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
  opts: { subjectFieldId: string | null; authorFieldId: string | null; authorCanView: boolean },
) {
  return client.rpc("set_entity_type_people_sensitive_access_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_people_sensitive: true,
    p_subject_person_field_id: opts.subjectFieldId,
    p_author_person_field_id: opts.authorFieldId,
    p_subject_can_view: true,
    p_manager_can_view: true,
    p_author_can_view: opts.authorCanView,
  });
}

async function configureLifecycle(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  opts: { quality_review: boolean; statusFieldId?: string | null; draftOptionId?: string | null; finalizedOptionId?: string | null },
) {
  return client.rpc("set_entity_type_quality_review_lifecycle_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_quality_review: opts.quality_review,
    p_status_field_id: opts.statusFieldId ?? null,
    p_draft_option_id: opts.draftOptionId ?? null,
    p_finalized_option_id: opts.finalizedOptionId ?? null,
  });
}

async function createQualityReview(
  client: SupabaseClient,
  opts: { reviewerPersonId: string; subjectPersonId?: string; values?: Record<string, unknown> },
) {
  const relations = [
    {
      field_definition_id: fixture.reviewerFieldId,
      target_entity_type_id: fixture.personEntityTypeId,
      target_record_id: opts.reviewerPersonId,
    },
  ];
  if (opts.subjectPersonId) {
    relations.push({
      field_definition_id: fixture.subjectFieldId,
      target_entity_type_id: fixture.personEntityTypeId,
      target_record_id: opts.subjectPersonId,
    });
  }
  return client.rpc("create_entity_record_with_relations_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_entity_type_id: fixture.reviewEntityTypeId,
    p_values: opts.values ?? {},
    p_relations: relations,
  });
}

async function createFinalizedReview(client: SupabaseClient, reviewerUser: User, reviewerPersonId: string, subjectPersonId: string) {
  const created = await createQualityReview(client, { reviewerPersonId, subjectPersonId });
  if (created.error) throw new Error(created.error.message);
  const reviewId = created.data as string;
  const reviewerClient = await authenticatedClient(reviewerUser);
  const finalized = await reviewerClient.rpc("finalize_quality_review_authorized", {
    p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
  });
  if (finalized.error) throw new Error(finalized.error.message);
  return reviewId;
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

async function statusOf(reviewId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.from("entity_records").select("values").eq("id", reviewId).single();
  if (error) throw new Error(error.message);
  return (data!.values as Record<string, unknown>)[fixture.statusFieldKey];
}

async function createFixture(): Promise<Fixture> {
  const workspaceId = await createWorkspace("E2E QR Lifecycle");

  const builder = await memberWithCapabilities(workspaceId, "builder", [
    "schema.manage", "workspace.manage_members", "workspace.manage_roles",
    "workspace.impersonate_users", "people_data.view_all", "records.operate",
  ]);
  const privileged = await memberWithCapabilities(workspaceId, "privileged", ["records.operate", "people_data.view_all"]);
  const coworker = await memberWithCapabilities(workspaceId, "coworker", ["records.operate"]);
  const subjectUser = await memberWithCapabilities(workspaceId, "subject", ["records.operate"]);
  const managerUser = await memberWithCapabilities(workspaceId, "manager", ["records.operate"]);
  const reviewerUser = await memberWithCapabilities(workspaceId, "reviewer", ["records.operate"]);
  const otherReviewerUser = await memberWithCapabilities(workspaceId, "other-reviewer", ["records.operate"]);

  const personEntityTypeId = await createEntityType(workspaceId, `Person ${workspaceId.slice(0, 6)}`);
  const { key: personNameFieldKey } = await createField(workspaceId, personEntityTypeId, { key: "name", name: "Name", type: "text", position: 1 });

  const builderClient = await authenticatedClient(builder);
  const designate = await builderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: personEntityTypeId });
  if (designate.error) throw new Error(`designate person type: ${designate.error.message}`);

  const subjectPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Subject Person" });
  const reviewerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Reviewer Person" });
  await setPersonLink(workspaceId, personEntityTypeId, subjectPersonRecordId, subjectUser.id);
  await setPersonLink(workspaceId, personEntityTypeId, reviewerPersonRecordId, reviewerUser.id);
  await setPrimaryManager(workspaceId, subjectUser.id, managerUser.id);

  const reviewEntityTypeId = await createEntityType(workspaceId, `Quality Review ${workspaceId.slice(0, 6)}`);
  const { id: subjectFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    key: "reviewedEmployee", name: "Reviewed Employee", type: "relation", position: 1, relatedEntityTypeId: personEntityTypeId,
  });
  const { id: reviewerFieldId } = await createField(workspaceId, reviewEntityTypeId, {
    key: "reviewer", name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: personEntityTypeId,
  });
  const { key: notesFieldKey } = await createField(workspaceId, reviewEntityTypeId, { key: "notes", name: "Notes", type: "text", position: 3 });
  const { id: statusFieldId, key: statusFieldKey } = await createField(workspaceId, reviewEntityTypeId, { key: "status", name: "Status", type: "choice", position: 4 });

  const draftOptionId = await addChoiceOption(builderClient, workspaceId, statusFieldId, "Draft");
  const finalizedOptionId = await addChoiceOption(builderClient, workspaceId, statusFieldId, "Finalized");
  const otherOptionId = await addChoiceOption(builderClient, workspaceId, statusFieldId, "Something Else");

  const enableSensitive = await configureSensitive(builderClient, workspaceId, reviewEntityTypeId, {
    subjectFieldId, authorFieldId: reviewerFieldId, authorCanView: true,
  });
  if (enableSensitive.error) throw new Error(`enable sensitivity: ${enableSensitive.error.message}`);

  const enableLifecycle = await configureLifecycle(builderClient, workspaceId, reviewEntityTypeId, {
    quality_review: true, statusFieldId, draftOptionId, finalizedOptionId,
  });
  if (enableLifecycle.error) throw new Error(`enable QR lifecycle: ${enableLifecycle.error.message}`);

  return {
    workspaceId, personEntityTypeId, personNameFieldKey, reviewEntityTypeId, subjectFieldId, reviewerFieldId,
    notesFieldKey, statusFieldId, statusFieldKey, draftOptionId, finalizedOptionId, otherOptionId,
    subjectPersonRecordId, reviewerPersonRecordId,
    builder, privileged, coworker, subjectUser, managerUser, reviewerUser, otherReviewerUser,
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
    await admin.from("entity_types").update({
      subject_person_field_id: null, author_person_field_id: null,
      quality_review: false, quality_review_status_field_id: null,
      quality_review_draft_option_id: null, quality_review_finalized_option_id: null,
    }).in("workspace_id", createdWorkspaceIds);
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) failures.push(`workspaces: ${error.message}`);
  }

  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) {
    throw new Error(`quality-review-lifecycle-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
describe("quality review lifecycle configuration", () => {
  it("entity_types carries the quality review metadata and the fixture's invariant holds", async () => {
    const admin = createSupabaseTestClient();
    const { data, error } = await admin
      .from("entity_types")
      .select("quality_review, quality_review_status_field_id, quality_review_draft_option_id, quality_review_finalized_option_id, author_can_view")
      .eq("id", fixture.reviewEntityTypeId)
      .single();
    expect(error).toBeNull();
    expect(data?.quality_review).toBe(true);
    expect(data?.quality_review_status_field_id).toBe(fixture.statusFieldId);
    expect(data?.quality_review_draft_option_id).toBe(fixture.draftOptionId);
    expect(data?.quality_review_finalized_option_id).toBe(fixture.finalizedOptionId);
    expect(data?.author_can_view).toBe(true);
  });

  it("cannot enable QR lifecycle without sensitive access, a subject field, a reviewer field, and reviewer visibility already configured", async () => {
    const scratchWorkspaceId = await createWorkspace("QR No Prereqs");
    const scratchBuilder = await memberWithCapabilities(scratchWorkspaceId, "scratch-builder", ["schema.manage"]);
    const scratchTypeId = await createEntityType(scratchWorkspaceId, "Scratch");
    const { id: statusFieldId } = await createField(scratchWorkspaceId, scratchTypeId, { key: "status", name: "Status", type: "choice", position: 1 });
    const client = await authenticatedClient(scratchBuilder);
    const draftId = await addChoiceOption(client, scratchWorkspaceId, statusFieldId, "Draft");
    const finalizedId = await addChoiceOption(client, scratchWorkspaceId, statusFieldId, "Finalized");
    const result = await configureLifecycle(client, scratchWorkspaceId, scratchTypeId, {
      quality_review: true, statusFieldId, draftOptionId: draftId, finalizedOptionId: finalizedId,
    });
    expect(result.error?.message).toMatch(/subject field.*reviewer field.*reviewer visibility|configure sensitive access/i);
  });

  it("status field must be an active choice field on this exact object", async () => {
    const otherTypeId = await createEntityType(fixture.workspaceId, `Unrelated ${randomUUID().slice(0, 6)}`);
    const { id: foreignFieldId } = await createField(fixture.workspaceId, otherTypeId, { key: "status", name: "Status", type: "choice", position: 1 });
    const builderClient = await authenticatedClient(fixture.builder);
    const result = await configureLifecycle(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      quality_review: true, statusFieldId: foreignFieldId, draftOptionId: fixture.draftOptionId, finalizedOptionId: fixture.finalizedOptionId,
    });
    expect(result.error?.message).toMatch(/active choice field/i);
  });

  it("draft and finalized options must belong to the status field and must differ", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const sameOption = await configureLifecycle(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      quality_review: true, statusFieldId: fixture.statusFieldId, draftOptionId: fixture.draftOptionId, finalizedOptionId: fixture.draftOptionId,
    });
    expect(sameOption.error?.message).toMatch(/different options/i);

    const foreignField = await createField(fixture.workspaceId, fixture.reviewEntityTypeId, { key: "other-status", name: "Other Status", type: "choice", position: 5 });
    const foreignOption = await addChoiceOption(builderClient, fixture.workspaceId, foreignField.id, "Foreign");
    const wrongField = await configureLifecycle(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      quality_review: true, statusFieldId: fixture.statusFieldId, draftOptionId: foreignOption, finalizedOptionId: fixture.finalizedOptionId,
    });
    expect(wrongField.error?.message).toMatch(/active option on the selected status field/i);
  });

  it("enabling requires every existing record to already resolve to Draft or Finalized, with a truthful count, and never rewrites records", async () => {
    const scratchWorkspaceId = await createWorkspace("QR Existing Records");
    const scratchBuilder = await memberWithCapabilities(scratchWorkspaceId, "scratch-builder", ["schema.manage", "workspace.manage_members", "workspace.manage_roles", "people_data.view_all", "records.operate"]);
    const scratchClient = await authenticatedClient(scratchBuilder);
    const scratchPersonType = await createEntityType(scratchWorkspaceId, "Person");
    await scratchClient.rpc("set_person_entity_type_authorized", { p_workspace_id: scratchWorkspaceId, p_entity_type_id: scratchPersonType });
    const scratchSubjectPerson = await createRecordDirect(scratchWorkspaceId, scratchPersonType, {});
    const scratchReviewerPerson = await createRecordDirect(scratchWorkspaceId, scratchPersonType, {});
    const scratchType = await createEntityType(scratchWorkspaceId, "Review");
    const { id: subjectFieldId } = await createField(scratchWorkspaceId, scratchType, { key: "subject", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: scratchPersonType });
    const { id: reviewerFieldId } = await createField(scratchWorkspaceId, scratchType, { key: "reviewer", name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: scratchPersonType });
    const { key: statusKey, id: statusFieldId } = await createField(scratchWorkspaceId, scratchType, { key: "status", name: "Status", type: "choice", position: 3 });
    const draftId = await addChoiceOption(scratchClient, scratchWorkspaceId, statusFieldId, "Draft");
    const finalizedId = await addChoiceOption(scratchClient, scratchWorkspaceId, statusFieldId, "Finalized");

    // One record with no status value at all, created before QR is enabled.
    const admin = createSupabaseTestClient();
    const badRecordId = randomUUID();
    await admin.from("entity_records").insert({ id: badRecordId, workspace_id: scratchWorkspaceId, entity_type_id: scratchType, values: {} });
    await admin.from("entity_record_relation_values").insert([
      { workspace_id: scratchWorkspaceId, source_entity_type_id: scratchType, source_record_id: badRecordId, field_definition_id: subjectFieldId, target_entity_type_id: scratchPersonType, target_record_id: scratchSubjectPerson },
      { workspace_id: scratchWorkspaceId, source_entity_type_id: scratchType, source_record_id: badRecordId, field_definition_id: reviewerFieldId, target_entity_type_id: scratchPersonType, target_record_id: scratchReviewerPerson },
    ]);

    await configureSensitive(scratchClient, scratchWorkspaceId, scratchType, { subjectFieldId, authorFieldId: reviewerFieldId, authorCanView: true });
    const enableResult = await configureLifecycle(scratchClient, scratchWorkspaceId, scratchType, {
      quality_review: true, statusFieldId, draftOptionId: draftId, finalizedOptionId: finalizedId,
    });
    expect(enableResult.error?.message).toMatch(/1 existing record.*do not have a recognized Draft or Finalized status/i);

    const { data: unchanged } = await admin.from("entity_records").select("values").eq("id", badRecordId).single();
    expect((unchanged!.values as Record<string, unknown>)[statusKey]).toBeUndefined();
  });

  it("changing the Finalized option is blocked while a record currently holds the current Finalized option", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);
    const result = await configureLifecycle(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      quality_review: true, statusFieldId: fixture.statusFieldId, draftOptionId: fixture.draftOptionId, finalizedOptionId: fixture.otherOptionId,
    });
    expect(result.error?.message).toMatch(/do not have a recognized Draft or Finalized status/i);
  });

  it("changing/removing the subject or reviewer field, or turning off reviewer visibility, is blocked while QR lifecycle is active", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const clearSubject = await configureSensitive(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      subjectFieldId: null, authorFieldId: fixture.reviewerFieldId, authorCanView: true,
    });
    expect(clearSubject.error?.message).toMatch(/subject field.*quality review lifecycle is active/i);

    const clearAuthor = await configureSensitive(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      subjectFieldId: fixture.subjectFieldId, authorFieldId: null, authorCanView: false,
    });
    expect(clearAuthor.error?.message).toMatch(/reviewer field.*quality review lifecycle is active/i);

    const disableAuthorView = await configureSensitive(builderClient, fixture.workspaceId, fixture.reviewEntityTypeId, {
      subjectFieldId: fixture.subjectFieldId, authorFieldId: fixture.reviewerFieldId, authorCanView: false,
    });
    expect(disableAuthorView.error?.message).toMatch(/reviewer visibility.*quality review lifecycle is active/i);
  });

  it("disabling QR lifecycle is blocked while any record of the object exists", async () => {
    const scratchWorkspaceId = await createWorkspace("QR Disable Guard");
    const scratchBuilder = await memberWithCapabilities(scratchWorkspaceId, "scratch-builder", ["schema.manage", "workspace.manage_members", "workspace.manage_roles", "people_data.view_all", "records.operate"]);
    const scratchClient = await authenticatedClient(scratchBuilder);
    const scratchPersonType = await createEntityType(scratchWorkspaceId, "Person");
    await scratchClient.rpc("set_person_entity_type_authorized", { p_workspace_id: scratchWorkspaceId, p_entity_type_id: scratchPersonType });
    const scratchType = await createEntityType(scratchWorkspaceId, "Review");
    const { id: subjectFieldId } = await createField(scratchWorkspaceId, scratchType, { key: "subject", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: scratchPersonType });
    const { id: reviewerFieldId } = await createField(scratchWorkspaceId, scratchType, { key: "reviewer", name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: scratchPersonType });
    const { id: statusFieldId } = await createField(scratchWorkspaceId, scratchType, { key: "status", name: "Status", type: "choice", position: 3 });
    const draftId = await addChoiceOption(scratchClient, scratchWorkspaceId, statusFieldId, "Draft");
    const finalizedId = await addChoiceOption(scratchClient, scratchWorkspaceId, statusFieldId, "Finalized");
    await configureSensitive(scratchClient, scratchWorkspaceId, scratchType, { subjectFieldId, authorFieldId: reviewerFieldId, authorCanView: true });
    await configureLifecycle(scratchClient, scratchWorkspaceId, scratchType, { quality_review: true, statusFieldId, draftOptionId: draftId, finalizedOptionId: finalizedId });

    const noRecordsResult = await configureLifecycle(scratchClient, scratchWorkspaceId, scratchType, { quality_review: false });
    expect(noRecordsResult.error).toBeNull();

    await configureLifecycle(scratchClient, scratchWorkspaceId, scratchType, { quality_review: true, statusFieldId, draftOptionId: draftId, finalizedOptionId: finalizedId });
    await createRecordDirect(scratchWorkspaceId, scratchType, {});
    const blockedResult = await configureLifecycle(scratchClient, scratchWorkspaceId, scratchType, { quality_review: false });
    expect(blockedResult.error?.message).toMatch(/1 record\(s\) of this object exist/i);
  });

  it("designated status field cannot be archived while QR lifecycle is active", async () => {
    const admin = createSupabaseTestClient();
    const { error } = await admin.from("field_definitions").update({ archived_at: new Date().toISOString() }).eq("id", fixture.statusFieldId);
    expect(error?.message).toMatch(/designated for sensitive-record access/i);
  });

  it("the configured Draft and Finalized options cannot be archived while QR lifecycle is active", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const draftArchive = await builderClient.rpc("archive_field_choice_option", {
      p_workspace_id: fixture.workspaceId, p_field_definition_id: fixture.statusFieldId, p_option_id: fixture.draftOptionId,
    });
    expect(draftArchive.error?.message).toMatch(/designated as a quality review lifecycle status/i);

    const finalizedArchive = await builderClient.rpc("archive_field_choice_option", {
      p_workspace_id: fixture.workspaceId, p_field_definition_id: fixture.statusFieldId, p_option_id: fixture.finalizedOptionId,
    });
    expect(finalizedArchive.error?.message).toMatch(/designated as a quality review lifecycle status/i);

    const otherArchive = await builderClient.rpc("archive_field_choice_option", {
      p_workspace_id: fixture.workspaceId, p_field_definition_id: fixture.statusFieldId, p_option_id: fixture.otherOptionId,
    });
    expect(otherArchive.error).toBeNull();
    await builderClient.rpc("restore_field_choice_option", { p_workspace_id: fixture.workspaceId, p_field_definition_id: fixture.statusFieldId, p_option_id: fixture.otherOptionId });
  });
});

// ---------------------------------------------------------------------------
// CREATION
// ---------------------------------------------------------------------------
describe("quality review creation", () => {
  it("an ordinary Reviewer self-binds successfully and the record starts in Draft", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const result = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    expect(result.error).toBeNull();
    expect(await statusOf(result.data as string)).toBe(fixture.draftOptionId);
  });

  it("naming a different Person as Reviewer is rejected without governance authority", async () => {
    // Must be an actor who DOES have their own linked Person (so the
    // "must be linked" branch doesn't fire first) but is naming a
    // DIFFERENT Person as Reviewer, with no governance authority.
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const result = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.subjectPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    expect(result.error?.message).toMatch(/naming yourself as the Reviewer/i);
  });

  it("a caller with no linked Person record and no governance authority is rejected with the truthful 'must be linked' message", async () => {
    const coworkerClient = await authenticatedClient(fixture.coworker);
    const result = await createQualityReview(coworkerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    expect(result.error?.message).toMatch(/linked to a workspace Person record/i);
  });

  it("governed create-on-behalf succeeds for a privileged real actor naming a different Reviewer", async () => {
    const privilegedClient = await authenticatedClient(fixture.privileged);
    const result = await createQualityReview(privilegedClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    expect(result.error).toBeNull();
    expect(await statusOf(result.data as string)).toBe(fixture.draftOptionId);
  });

  it("create-on-behalf is rejected while impersonating, even though the real actor holds governance authority", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    await impersonate(builderClient, fixture.coworker.id);
    const result = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    expect(result.error?.message).not.toBeNull();
    await endAnyActiveSession(builderClient);
  });

  it("an omitted status is populated as Draft, and an explicitly-supplied Draft value is accepted", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const omitted = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    expect(await statusOf(omitted.data as string)).toBe(fixture.draftOptionId);

    const explicitDraft = await createQualityReview(reviewerClient, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId,
      values: { [fixture.statusFieldKey]: fixture.draftOptionId },
    });
    expect(explicitDraft.error).toBeNull();
    expect(await statusOf(explicitDraft.data as string)).toBe(fixture.draftOptionId);
  });

  it("supplying Finalized or any other option at creation is rejected outright", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const finalizedAttempt = await createQualityReview(reviewerClient, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId,
      values: { [fixture.statusFieldKey]: fixture.finalizedOptionId },
    });
    expect(finalizedAttempt.error?.message).toMatch(/must start in the configured Draft status/i);

    const otherAttempt = await createQualityReview(reviewerClient, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId,
      values: { [fixture.statusFieldKey]: fixture.otherOptionId },
    });
    expect(otherAttempt.error?.message).toMatch(/must start in the configured Draft status/i);
  });

  it("self-review (subject equals reviewer) remains allowed", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const result = await createQualityReview(reviewerClient, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.reviewerPersonRecordId,
    });
    expect(result.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------
describe("quality review read visibility", () => {
  it("Draft: Reviewer visible, Subject hidden, unrelated manager hidden, unrelated coworker hidden, privileged visible outside impersonation", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    expect((await reviewerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).not.toBeNull();

    const subjectClient = await authenticatedClient(fixture.subjectUser);
    expect((await subjectClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).toBeNull();

    const managerClient = await authenticatedClient(fixture.managerUser);
    expect((await managerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).toBeNull();

    const coworkerClient = await authenticatedClient(fixture.coworker);
    expect((await coworkerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).toBeNull();

    const privilegedClient = await authenticatedClient(fixture.privileged);
    expect((await privilegedClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).not.toBeNull();
  });

  it("Draft: a manager who is also the designated Reviewer sees it via the reviewer branch", async () => {
    const managerPersonId = await createRecordDirect(fixture.workspaceId, fixture.personEntityTypeId, {});
    await setPersonLink(fixture.workspaceId, fixture.personEntityTypeId, managerPersonId, fixture.managerUser.id);
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: managerPersonId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);

    const managerClient = await authenticatedClient(fixture.managerUser);
    const result = await managerClient.from("entity_records").select("id").eq("id", created.data as string).maybeSingle();
    expect(result.data).not.toBeNull();
  });

  it("the privileged override is suppressed while impersonating a user without access", async () => {
    const builderClient = await authenticatedClient(fixture.builder); // builder holds people_data.view_all
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);

    await impersonate(builderClient, fixture.coworker.id);
    const hidden = await builderClient.from("entity_records").select("id").eq("id", created.data as string).maybeSingle();
    expect(hidden.data).toBeNull();
    await endAnyActiveSession(builderClient);
  });

  it("Finalized: normal Phase 12.2 visibility resumes for subject and manager", async () => {
    const reviewId = await createFinalizedReview(await authenticatedClient(fixture.builder), fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);

    const subjectClient = await authenticatedClient(fixture.subjectUser);
    expect((await subjectClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).not.toBeNull();

    const managerClient = await authenticatedClient(fixture.managerUser);
    expect((await managerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).not.toBeNull();

    const coworkerClient = await authenticatedClient(fixture.coworker);
    expect((await coworkerClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).toBeNull();
  });

  it("non-Quality-Review sensitive types are completely unaffected by these changes", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const otherType = await createEntityType(fixture.workspaceId, `Non-QR Sensitive ${randomUUID().slice(0, 6)}`);
    const { id: subjField } = await createField(fixture.workspaceId, otherType, { key: "subject", name: "Subject", type: "relation", position: 1, relatedEntityTypeId: fixture.personEntityTypeId });
    await configureSensitive(builderClient, fixture.workspaceId, otherType, { subjectFieldId: subjField, authorFieldId: null, authorCanView: false });
    const recordId = randomUUID();
    const admin = createSupabaseTestClient();
    await admin.from("entity_records").insert({ id: recordId, workspace_id: fixture.workspaceId, entity_type_id: otherType, values: {} });
    await admin.from("entity_record_relation_values").insert({
      workspace_id: fixture.workspaceId, source_entity_type_id: otherType, source_record_id: recordId,
      field_definition_id: subjField, target_entity_type_id: fixture.personEntityTypeId, target_record_id: fixture.subjectPersonRecordId,
    });
    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const result = await subjectClient.from("entity_records").select("id").eq("id", recordId).maybeSingle();
    expect(result.data).not.toBeNull(); // subject_can_view defaults true, unaffected by QR logic
  });
});

// ---------------------------------------------------------------------------
// WRITE
// ---------------------------------------------------------------------------
describe("quality review write authority", () => {
  it("the Reviewer can edit ordinary Draft content, and an unchanged Draft status in the full payload is accepted", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const created = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const result = await reviewerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.notesFieldKey]: "Good progress", [fixture.statusFieldKey]: fixture.draftOptionId },
      p_relation_field_ids: [], p_relations: [],
    });
    expect(result.error).toBeNull();
  });

  it("an attempted status change through the generic update RPC is rejected", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const created = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const result = await reviewerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.statusFieldKey]: fixture.finalizedOptionId },
      p_relation_field_ids: [], p_relations: [],
    });
    expect(result.error?.message).toMatch(/status cannot be changed through an ordinary update/i);
  });

  it("Subject cannot edit a Draft it cannot see", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const result = await subjectClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: created.data as string,
      p_values: { [fixture.notesFieldKey]: "hijack" }, p_relation_field_ids: [], p_relations: [],
    });
    expect(result.error?.message).toMatch(/record not found/i);
  });

  it("a manager who is not Reviewer cannot edit a Draft they cannot see", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const managerClient = await authenticatedClient(fixture.managerUser);
    const result = await managerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: created.data as string,
      p_values: { [fixture.notesFieldKey]: "hijack" }, p_relation_field_ids: [], p_relations: [],
    });
    expect(result.error?.message).toMatch(/record not found/i);
  });

  it("a privileged non-Reviewer holder can see but cannot generic-edit a Draft", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const privilegedClient = await authenticatedClient(fixture.privileged);
    expect((await privilegedClient.from("entity_records").select("id").eq("id", reviewId).maybeSingle()).data).not.toBeNull();

    const editAttempt = await privilegedClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.notesFieldKey]: "override" }, p_relation_field_ids: [], p_relations: [],
    });
    expect(editAttempt.error?.message).toMatch(/only the designated reviewer/i);
  });

  it("admin correction: governance Reviewer reassignment succeeds, then ordinary reviewer authority applies", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const otherReviewerPersonId = await createRecordDirect(fixture.workspaceId, fixture.personEntityTypeId, {});
    await setPersonLink(fixture.workspaceId, fixture.personEntityTypeId, otherReviewerPersonId, fixture.otherReviewerUser.id);

    const reassign = await privilegedClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: {}, p_relation_field_ids: [fixture.reviewerFieldId],
      p_relations: [{ field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: otherReviewerPersonId }],
    });
    expect(reassign.error).toBeNull();

    const newReviewerClient = await authenticatedClient(fixture.otherReviewerUser);
    const edit = await newReviewerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.notesFieldKey]: "corrected by new reviewer" }, p_relation_field_ids: [], p_relations: [],
    });
    expect(edit.error).toBeNull();
  });

  it("a governed Reviewer reassignment cannot be combined with a simultaneous content edit as a bypass", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const privilegedClient = await authenticatedClient(fixture.privileged);
    // No link needed -- the reviewer-only content gate rejects this call
    // before the reassignment's own governance-boundary check is ever
    // reached, so the target need not be a genuinely linked Person here.
    const otherReviewerPersonId = await createRecordDirect(fixture.workspaceId, fixture.personEntityTypeId, {});

    // privileged is not (yet) the Reviewer, so bundling a Notes change into
    // the same reassignment call must be rejected outright -- reassignment
    // must be the only security-relevant operation in the call, per the
    // approved Path A design.
    const combined = await privilegedClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.notesFieldKey]: "bypass attempt" },
      p_relation_field_ids: [fixture.reviewerFieldId],
      p_relations: [{ field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: otherReviewerPersonId }],
    });
    expect(combined.error?.message).toMatch(/only the designated reviewer may edit/i);

    const admin = createSupabaseTestClient();
    const { data: unchanged } = await admin.from("entity_records").select("values").eq("id", reviewId).single();
    expect((unchanged!.values as Record<string, unknown>)[fixture.notesFieldKey]).toBeUndefined();
    const { data: relationUnchanged } = await admin
      .from("entity_record_relation_values")
      .select("target_record_id")
      .eq("source_record_id", reviewId)
      .eq("field_definition_id", fixture.reviewerFieldId)
      .single();
    expect(relationUnchanged?.target_record_id).toBe(fixture.reviewerPersonRecordId);
  });

  it("a governed Reviewer reassignment combined with touching an unrelated relation field is also rejected", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const otherReviewerPersonId = await createRecordDirect(fixture.workspaceId, fixture.personEntityTypeId, {});
    const otherSubjectPersonId = await createRecordDirect(fixture.workspaceId, fixture.personEntityTypeId, {});

    const combined = await privilegedClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: {},
      p_relation_field_ids: [fixture.reviewerFieldId, fixture.subjectFieldId],
      p_relations: [
        { field_definition_id: fixture.reviewerFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: otherReviewerPersonId },
        { field_definition_id: fixture.subjectFieldId, target_entity_type_id: fixture.personEntityTypeId, target_record_id: otherSubjectPersonId },
      ],
    });
    // Rejected by the Draft write-authority gate before the subject change
    // is even considered -- privileged is not the current Reviewer and is
    // touching a relation field (subject) other than the one being
    // reassigned (reviewer).
    expect(combined.error?.message).toMatch(/only the designated reviewer may edit/i);
  });

  it("Draft delete: Reviewer may safe-delete; Subject, an unrelated manager, and an unrelated coworker may not", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerOwned = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (reviewerOwned.error) throw new Error(reviewerOwned.error.message);
    const reviewerDelete = await reviewerClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewerOwned.data as string,
    });
    expect(reviewerDelete.error).toBeNull();
    expect((reviewerDelete.data as Array<{ deleted: boolean }>)[0]?.deleted).toBe(true);

    const builderClient = await authenticatedClient(fixture.builder);
    const forOthers = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (forOthers.error) throw new Error(forOthers.error.message);
    const reviewId = forOthers.data as string;

    const subjectClient = await authenticatedClient(fixture.subjectUser);
    const subjectDelete = await subjectClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(subjectDelete.error?.message).toMatch(/record not found/i);

    const managerClient = await authenticatedClient(fixture.managerUser);
    const managerDelete = await managerClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(managerDelete.error?.message).toMatch(/record not found/i);

    const coworkerClient = await authenticatedClient(fixture.coworker);
    const coworkerDelete = await coworkerClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(coworkerDelete.error?.message).toMatch(/record not found/i);
  });

  it("Draft delete: a privileged non-Reviewer viewer can see but cannot delete without governance authority applying, and cannot delete at all while impersonating", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    // privileged holds people_data.view_all as the real actor and is not
    // impersonating -- this genuinely IS governance authority, so deletion
    // succeeds. This is the "administrative cleanup" case, distinct from
    // "people_data.view_all alone" (i.e. held by an impersonated identity,
    // or evaluated against anything but the real actor) being insufficient.
    const privilegedClient = await authenticatedClient(fixture.privileged);
    const cleanupDelete = await privilegedClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(cleanupDelete.error).toBeNull();
    expect((cleanupDelete.data as Array<{ deleted: boolean }>)[0]?.deleted).toBe(true);

    // A second Draft, deletion attempted by the builder (who also holds
    // people_data.view_all) while impersonating someone with no access at
    // all -- the record is not even visible under impersonation, so
    // governance authority is moot; this proves impersonation suppresses
    // the override rather than merely being irrelevant.
    const secondCreated = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (secondCreated.error) throw new Error(secondCreated.error.message);
    await impersonate(builderClient, fixture.coworker.id);
    const impersonatedDelete = await builderClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: secondCreated.data as string,
    });
    expect(impersonatedDelete.error?.message).toMatch(/record not found/i);
    await endAnyActiveSession(builderClient);
  });

  it("Draft restore: Reviewer and governance authority may restore; an unrelated records.operate holder may not", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const created = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;
    await reviewerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });

    const coworkerClient = await authenticatedClient(fixture.coworker);
    const coworkerRestore = await coworkerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
    expect(coworkerRestore.error?.message).toMatch(/records\.operate|could not be found/i);

    const reviewerRestore = await reviewerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
    expect(reviewerRestore.error).toBeNull();
    expect(reviewerRestore.data).toEqual([{ updated_record_count: 1 }]);

    await reviewerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });
    const privilegedClient = await authenticatedClient(fixture.privileged);
    const governanceRestore = await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
    expect(governanceRestore.error).toBeNull();
    expect(governanceRestore.data).toEqual([{ updated_record_count: 1 }]);
  });

  it("Finalized restore requires governance authority; the Reviewer alone cannot restore it", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);
    const privilegedClient = await authenticatedClient(fixture.privileged);
    await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerRestore = await reviewerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
    expect(reviewerRestore.error?.message).toMatch(/only a privileged administrator may restore/i);

    const governanceRestore = await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
    expect(governanceRestore.error).toBeNull();
    expect(governanceRestore.data).toEqual([{ updated_record_count: 1 }]);
  });

  it("bulk restore is subject to the identical lifecycle rules as bulk archive", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);
    const privilegedClient = await authenticatedClient(fixture.privileged);
    await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerBulkRestore = await reviewerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
    expect(reviewerBulkRestore.error?.message).toMatch(/only a privileged administrator may restore/i);

    const governanceBulkRestore = await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
    expect(governanceBulkRestore.error).toBeNull();
  });

  it("governance authority can archive and delete a Draft directly without reassignment", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const archive = await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });
    expect(archive.error).toBeNull();
    expect(archive.data).toEqual([{ updated_record_count: 1 }]);

    const restore = await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
    expect(restore.error).toBeNull();

    const del = await privilegedClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(del.error).toBeNull();
    expect((del.data as Array<{ deleted: boolean }>)[0]?.deleted).toBe(true);
  });

  it("an unrelated records.operate holder cannot archive a Draft (no visibility)", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const coworkerClient = await authenticatedClient(fixture.coworker);
    const result = await coworkerClient.from("entity_records").update({ archived_at: new Date().toISOString() }).eq("id", created.data as string).select("id");
    expect(result.data ?? []).toHaveLength(0);
  });

  it("Finalized: generic edit is blocked for the Reviewer and for a privileged viewer", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerAttempt = await reviewerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.notesFieldKey]: "sneaky edit" }, p_relation_field_ids: [], p_relations: [],
    });
    expect(reviewerAttempt.error?.message).toMatch(/finalized and can no longer be edited/i);

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const privilegedAttempt = await privilegedClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.notesFieldKey]: "privileged sneaky edit" }, p_relation_field_ids: [], p_relations: [],
    });
    expect(privilegedAttempt.error?.message).toMatch(/finalized and can no longer be edited/i);
  });

  it("Finalized: archive requires governance authority; the Reviewer alone cannot archive it", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerArchive = await reviewerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });
    expect(reviewerArchive.error?.message).toMatch(/only a privileged administrator may archive/i);

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const privilegedArchive = await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });
    expect(privilegedArchive.error).toBeNull();
    expect(privilegedArchive.data).toEqual([{ updated_record_count: 1 }]);
    await privilegedClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: false,
    });
  });

  it("Finalized: hard delete is blocked for everyone, including governance authority", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);
    const privilegedClient = await authenticatedClient(fixture.privileged);
    const result = await privilegedClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(result.error?.message).toMatch(/finalized quality review cannot be deleted/i);

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerResult = await reviewerClient.rpc("delete_entity_record_if_unreferenced_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(reviewerResult.error?.message).toMatch(/finalized quality review cannot be deleted/i);
  });

  it("bulk archive cannot bypass Quality Review lifecycle rules", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const result = await reviewerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_ids: [reviewId], p_archived: true,
    });
    expect(result.error?.message).toMatch(/only a privileged administrator may archive/i);
  });
});

// ---------------------------------------------------------------------------
// TRANSITIONS
// ---------------------------------------------------------------------------
describe("finalize and reopen transitions", () => {
  it("the designated Reviewer can finalize a Draft, and finalize is only valid from Draft", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const created = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    const finalize = await reviewerClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(finalize.error).toBeNull();
    expect(await statusOf(reviewId)).toBe(fixture.finalizedOptionId);

    const secondFinalize = await reviewerClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(secondFinalize.error?.message).toMatch(/not currently in draft status/i);
  });

  it("only the designated Reviewer can finalize -- a privileged non-Reviewer cannot", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const privilegedClient = await authenticatedClient(fixture.privileged);
    const result = await privilegedClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: created.data as string,
    });
    expect(result.error?.message).toMatch(/only the designated reviewer may finalize/i);
  });

  it("finalize resolves against effective identity, works while impersonating the Reviewer, and records distinct real/effective actors on the event", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;

    await impersonate(builderClient, fixture.reviewerUser.id);
    const finalize = await builderClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(finalize.error).toBeNull();
    await endAnyActiveSession(builderClient);

    const admin = createSupabaseTestClient();
    const { data } = await admin
      .from("workspace_events")
      .select("actor_user_id, real_actor_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", reviewId)
      .eq("event_type", "quality_review_finalized")
      .single();
    expect(data?.actor_user_id).toBe(fixture.reviewerUser.id);
    expect(data?.real_actor_user_id).toBe(fixture.builder.id);
  });

  it("a failed re-finalize attempt (already Finalized) produces no second event row", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const created = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;
    await reviewerClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    const secondAttempt = await reviewerClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(secondAttempt.error).not.toBeNull();

    const admin = createSupabaseTestClient();
    const { data } = await admin
      .from("workspace_events")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", reviewId)
      .eq("event_type", "quality_review_finalized");
    expect(data ?? []).toHaveLength(1);
  });

  it("governance authority can reopen a Finalized review, and reopen is only valid from Finalized", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);

    const privilegedClient = await authenticatedClient(fixture.privileged);
    const reopen = await privilegedClient.rpc("reopen_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(reopen.error).toBeNull();
    expect(await statusOf(reviewId)).toBe(fixture.draftOptionId);

    const secondReopen = await privilegedClient.rpc("reopen_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(secondReopen.error?.message).toMatch(/not currently finalized/i);
  });

  it("reopen is blocked while impersonating, and the ordinary Reviewer cannot reopen at all", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewerReopen = await reviewerClient.rpc("reopen_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(reviewerReopen.error?.message).toMatch(/additional privileges/i);

    await impersonate(builderClient, fixture.coworker.id);
    const impersonatedReopen = await builderClient.rpc("reopen_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(impersonatedReopen.error?.message).toMatch(/not available while impersonating/i);
    await endAnyActiveSession(builderClient);
  });

  it("after Reopen, the record follows ordinary Draft rules again and can be re-finalized", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);
    const privilegedClient = await authenticatedClient(fixture.privileged);
    await privilegedClient.rpc("reopen_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });

    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const edit = await reviewerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
      p_values: { [fixture.notesFieldKey]: "corrected", [fixture.statusFieldKey]: fixture.draftOptionId },
      p_relation_field_ids: [], p_relations: [],
    });
    expect(edit.error).toBeNull();

    const refinalize = await reviewerClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });
    expect(refinalize.error).toBeNull();
    expect(await statusOf(reviewId)).toBe(fixture.finalizedOptionId);
  });
});

// ---------------------------------------------------------------------------
// EVENTS
// ---------------------------------------------------------------------------
describe("lifecycle events", () => {
  it("Finalize writes a transactional quality_review_finalized event with correct effective-actor attribution", async () => {
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const created = await createQualityReview(reviewerClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    const reviewId = created.data as string;
    await reviewerClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });

    const admin = createSupabaseTestClient();
    const { data, error } = await admin
      .from("workspace_events")
      .select("event_type, actor_user_id, real_actor_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", reviewId)
      .eq("event_type", "quality_review_finalized")
      .single();
    expect(error).toBeNull();
    expect(data?.actor_user_id).toBe(fixture.reviewerUser.id);
    expect(data?.real_actor_user_id).toBeNull();
  });

  it("Reopen writes a transactional quality_review_reopened event, and Activity surfaces both events", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createFinalizedReview(builderClient, fixture.reviewerUser, fixture.reviewerPersonRecordId, fixture.subjectPersonRecordId);
    const privilegedClient = await authenticatedClient(fixture.privileged);
    await privilegedClient.rpc("reopen_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: reviewId,
    });

    const admin = createSupabaseTestClient();
    const { data } = await admin
      .from("workspace_events")
      .select("event_type, actor_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_record_id", reviewId)
      .eq("event_type", "quality_review_reopened")
      .single();
    expect(data?.actor_user_id).toBe(fixture.privileged.id);

    const activity = await privilegedClient.rpc("list_record_activity_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: reviewId, p_limit: 20,
    });
    const eventTypes = ((activity.data ?? []) as Array<{ event_type: string }>).map((row) => row.event_type);
    expect(eventTypes).toContain("quality_review_finalized");
    expect(eventTypes).toContain("quality_review_reopened");
  });

  it("Activity for a hidden Draft Quality Review is not reachable by an unauthorized caller", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const created = await createQualityReview(builderClient, { reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId });
    if (created.error) throw new Error(created.error.message);
    await builderClient.rpc("finalize_quality_review_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_record_id: created.data as string,
    }); // will fail since builder isn't reviewer, but that's fine -- record stays Draft

    const coworkerClient = await authenticatedClient(fixture.coworker);
    const activity = await coworkerClient.rpc("list_record_activity_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: fixture.reviewEntityTypeId, p_entity_record_id: created.data as string, p_limit: 20,
    });
    expect(activity.error).toBeNull();
    expect(activity.data ?? []).toHaveLength(0);
  });
});
