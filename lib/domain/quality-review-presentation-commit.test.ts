// DB/RPC-level verification for Phase 12.3.2 Person Review History
// Experience (migration 0108, layered on the closed Phase 12.3.1
// foundation). Covers: the presentation configuration RPC (Review Date
// completeness invariant on first designation, change/clear guards once
// Finalized history exists, field-type/foreign-field rejection, field
// archival protection); the Finalize-time Review Date invariant; the
// list_person_quality_reviews_authorized input-security preconditions
// (non-member, nonexistent/wrong-type/foreign/undesignated Person all
// failing identically); the Finalized-only history row matrix (Draft never
// leaking, dynamic manager gain/loss, impersonation suppression, ordering,
// multi-type identity, Result data); and Reviewer-identity redaction when
// the Reviewer's own Person record is independently hidden.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient, deleteE2eUsers } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

type ReviewType = {
  entityTypeId: string;
  subjectFieldId: string;
  reviewerFieldId: string;
  statusFieldId: string;
  statusFieldKey: string;
  draftOptionId: string;
  finalizedOptionId: string;
  dateFieldId: string;
  dateFieldKey: string;
  resultFieldId: string;
  resultFieldKey: string;
  passOptionId: string;
  failOptionId: string;
};

type Fixture = {
  workspaceId: string;
  personEntityTypeId: string;
  reviewType: ReviewType;
  secondReviewType: ReviewType;
  subjectPersonRecordId: string;
  reviewerPersonRecordId: string;
  otherReviewerPersonRecordId: string;
  builder: User;
  privileged: User;
  coworker: User;
  subjectUser: User;
  managerUser: User;
  otherManagerUser: User;
  reviewerUser: User;
  otherReviewerUser: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
const clientCache = new Map<string, Promise<SupabaseClient>>();

function uniqueEmail(label: string) {
  return `e2e-qr-presentation-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `QrPresentation-${randomUUID()}!`;
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

async function configurePresentation(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  opts: { dateFieldId: string | null; resultFieldId: string | null },
) {
  return client.rpc("set_entity_type_quality_review_presentation_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_date_field_id: opts.dateFieldId,
    p_result_field_id: opts.resultFieldId,
  });
}

async function listPersonReviews(client: SupabaseClient, workspaceId: string, personRecordId: string) {
  return client.rpc("list_person_quality_reviews_authorized", {
    p_workspace_id: workspaceId,
    p_person_record_id: personRecordId,
  });
}

async function valueOf(recordId: string, key: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin.from("entity_records").select("values").eq("id", recordId).single();
  if (error) throw new Error(error.message);
  return (data!.values as Record<string, unknown>)[key];
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function impersonate(realActor: SupabaseClient, targetUserId: string, workspaceId: string) {
  await endAnyActiveSession(realActor);
  const result = await realActor.rpc("start_impersonation_session_authorized", {
    p_workspace_id: workspaceId,
    p_target_user_id: targetUserId,
  });
  if (result.error) throw new Error(result.error.message);
}

// Builds one fully-configured (sensitive + QR lifecycle enabled) review
// EntityType wired to an already-designated Person type, with its own
// Date field and a two-option Result Choice field created but NOT yet
// designated as presentation metadata -- each describe block designates
// them itself so the "first designation" invariant is exercised for real.
async function createReviewType(
  builderClient: SupabaseClient,
  workspaceId: string,
  personEntityTypeId: string,
  label: string,
): Promise<ReviewType> {
  const entityTypeId = await createEntityType(workspaceId, `${label} ${randomUUID().slice(0, 6)}`);
  const { id: subjectFieldId } = await createField(workspaceId, entityTypeId, {
    key: "subject", name: "Reviewed Employee", type: "relation", position: 1, relatedEntityTypeId: personEntityTypeId,
  });
  const { id: reviewerFieldId } = await createField(workspaceId, entityTypeId, {
    key: "reviewer", name: "Reviewer", type: "relation", position: 2, relatedEntityTypeId: personEntityTypeId,
  });
  const { id: statusFieldId, key: statusFieldKey } = await createField(workspaceId, entityTypeId, {
    key: "status", name: "Status", type: "choice", position: 3,
  });
  const draftOptionId = await addChoiceOption(builderClient, workspaceId, statusFieldId, "Draft");
  const finalizedOptionId = await addChoiceOption(builderClient, workspaceId, statusFieldId, "Finalized");
  const { id: dateFieldId, key: dateFieldKey } = await createField(workspaceId, entityTypeId, {
    key: "reviewDate", name: "Review Date", type: "date", position: 4,
  });
  const { id: resultFieldId, key: resultFieldKey } = await createField(workspaceId, entityTypeId, {
    key: "result", name: "Overall Result", type: "choice", position: 5,
  });
  const passOptionId = await addChoiceOption(builderClient, workspaceId, resultFieldId, "Pass");
  const failOptionId = await addChoiceOption(builderClient, workspaceId, resultFieldId, "Fail");

  const sensitiveResult = await configureSensitive(builderClient, workspaceId, entityTypeId, {
    subjectFieldId, authorFieldId: reviewerFieldId, authorCanView: true,
  });
  if (sensitiveResult.error) throw new Error(`configure sensitive: ${sensitiveResult.error.message}`);
  const lifecycleResult = await configureLifecycle(builderClient, workspaceId, entityTypeId, {
    quality_review: true, statusFieldId, draftOptionId, finalizedOptionId,
  });
  if (lifecycleResult.error) throw new Error(`configure lifecycle: ${lifecycleResult.error.message}`);

  return {
    entityTypeId, subjectFieldId, reviewerFieldId, statusFieldId, statusFieldKey,
    draftOptionId, finalizedOptionId, dateFieldId, dateFieldKey, resultFieldId, resultFieldKey,
    passOptionId, failOptionId,
  };
}

async function createReview(
  client: SupabaseClient,
  workspaceId: string,
  reviewType: ReviewType,
  opts: { reviewerPersonId: string; subjectPersonId: string; personEntityTypeId: string; values?: Record<string, unknown> },
) {
  const relations = [
    { field_definition_id: reviewType.reviewerFieldId, target_entity_type_id: opts.personEntityTypeId, target_record_id: opts.reviewerPersonId },
    { field_definition_id: reviewType.subjectFieldId, target_entity_type_id: opts.personEntityTypeId, target_record_id: opts.subjectPersonId },
  ];
  const result = await client.rpc("create_entity_record_with_relations_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: reviewType.entityTypeId,
    p_values: opts.values ?? {},
    p_relations: relations,
  });
  if (result.error) throw new Error(result.error.message);
  return result.data as string;
}

async function finalizeReview(reviewerClient: SupabaseClient, workspaceId: string, reviewType: ReviewType, reviewId: string) {
  return reviewerClient.rpc("finalize_quality_review_authorized", {
    p_workspace_id: workspaceId, p_entity_type_id: reviewType.entityTypeId, p_record_id: reviewId,
  });
}

async function createFinalizedReview(
  builderClient: SupabaseClient,
  reviewerClient: SupabaseClient,
  workspaceId: string,
  reviewType: ReviewType,
  opts: { reviewerPersonId: string; subjectPersonId: string; personEntityTypeId: string; values?: Record<string, unknown> },
) {
  const reviewId = await createReview(builderClient, workspaceId, reviewType, opts);
  const finalized = await finalizeReview(reviewerClient, workspaceId, reviewType, reviewId);
  if (finalized.error) throw new Error(finalized.error.message);
  return reviewId;
}

async function createFixture(): Promise<Fixture> {
  const workspaceId = await createWorkspace("E2E QR Presentation");

  const builder = await memberWithCapabilities(workspaceId, "builder", [
    "schema.manage", "workspace.manage_members", "workspace.manage_roles",
    "workspace.impersonate_users", "people_data.view_all", "records.operate",
  ]);
  const privileged = await memberWithCapabilities(workspaceId, "privileged", ["records.operate", "people_data.view_all"]);
  const coworker = await memberWithCapabilities(workspaceId, "coworker", ["records.operate"]);
  const subjectUser = await memberWithCapabilities(workspaceId, "subject", ["records.operate"]);
  const managerUser = await memberWithCapabilities(workspaceId, "manager", ["records.operate"]);
  const otherManagerUser = await memberWithCapabilities(workspaceId, "other-manager", ["records.operate"]);
  const reviewerUser = await memberWithCapabilities(workspaceId, "reviewer", ["records.operate"]);
  const otherReviewerUser = await memberWithCapabilities(workspaceId, "other-reviewer", ["records.operate"]);

  const personEntityTypeId = await createEntityType(workspaceId, `Person ${workspaceId.slice(0, 6)}`);
  const { key: personNameFieldKey } = await createField(workspaceId, personEntityTypeId, { key: "name", name: "Name", type: "text", position: 1 });

  const builderClient = await authenticatedClient(builder);
  const designate = await builderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: personEntityTypeId });
  if (designate.error) throw new Error(`designate person type: ${designate.error.message}`);

  const subjectPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Subject Person" });
  const reviewerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Reviewer Person" });
  const otherReviewerPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, { [personNameFieldKey]: "Other Reviewer Person" });
  await setPersonLink(workspaceId, personEntityTypeId, subjectPersonRecordId, subjectUser.id);
  await setPersonLink(workspaceId, personEntityTypeId, reviewerPersonRecordId, reviewerUser.id);
  await setPersonLink(workspaceId, personEntityTypeId, otherReviewerPersonRecordId, otherReviewerUser.id);
  await setPrimaryManager(workspaceId, subjectUser.id, managerUser.id);

  const reviewType = await createReviewType(builderClient, workspaceId, personEntityTypeId, "Quality Review");
  const secondReviewType = await createReviewType(builderClient, workspaceId, personEntityTypeId, "Second Quality Review");

  return {
    workspaceId, personEntityTypeId, reviewType, secondReviewType,
    subjectPersonRecordId, reviewerPersonRecordId, otherReviewerPersonRecordId,
    builder, privileged, coworker, subjectUser, managerUser, otherManagerUser, reviewerUser, otherReviewerUser,
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
      quality_review_date_field_id: null, quality_review_result_field_id: null,
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
    throw new Error(`quality-review-presentation-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// PRESENTATION CONFIG
// ---------------------------------------------------------------------------
describe("quality review presentation configuration", () => {
  it("requires Quality Review lifecycle to already be enabled", async () => {
    const workspaceId = await createWorkspace("QR Presentation No Lifecycle");
    const scratchBuilder = await memberWithCapabilities(workspaceId, "scratch-builder", ["schema.manage"]);
    const client = await authenticatedClient(scratchBuilder);
    const entityTypeId = await createEntityType(workspaceId, "Scratch");
    const { id: dateFieldId } = await createField(workspaceId, entityTypeId, { key: "date", name: "Date", type: "date", position: 1 });
    const result = await configurePresentation(client, workspaceId, entityTypeId, { dateFieldId, resultFieldId: null });
    expect(result.error?.message).toMatch(/enable quality review lifecycle/i);
  });

  it("Review date field must be an active Date field on this exact object; Overall result field must be an active Choice field", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Config Type Checks");

    const wrongDateType = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.resultFieldId, resultFieldId: null,
    });
    expect(wrongDateType.error?.message).toMatch(/active date field/i);

    const wrongResultType = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: null, resultFieldId: reviewType.dateFieldId,
    });
    expect(wrongResultType.error?.message).toMatch(/active choice field/i);

    const otherType = await createEntityType(fixture.workspaceId, `Unrelated ${randomUUID().slice(0, 6)}`);
    const { id: foreignDateField } = await createField(fixture.workspaceId, otherType, { key: "date", name: "Date", type: "date", position: 1 });
    const foreignField = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: foreignDateField, resultFieldId: null,
    });
    expect(foreignField.error?.message).toMatch(/active date field/i);
  });

  it("first Review Date designation succeeds when every existing Finalized review already has a valid date", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "First Designation OK");

    await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-01-15" },
    });

    const result = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: null,
    });
    expect(result.error).toBeNull();
  });

  it("first Review Date designation rejects with a truthful invalid-record count for missing, malformed, and impossible dates, and never rewrites a record", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "First Designation Rejected");

    const missing = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
    });
    const malformed = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "not-a-date" },
    });
    const impossible = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-02-30" },
    });

    const result = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: null,
    });
    expect(result.error?.message).toMatch(/3 existing finalized review\(s\) do not have a valid review date/i);

    expect(await valueOf(missing, reviewType.dateFieldKey)).toBeUndefined();
    expect(await valueOf(malformed, reviewType.dateFieldKey)).toBe("not-a-date");
    expect(await valueOf(impossible, reviewType.dateFieldKey)).toBe("2026-02-30");

    const { data: entityType } = await createSupabaseTestClient()
      .from("entity_types").select("quality_review_date_field_id").eq("id", reviewType.entityTypeId).single();
    expect(entityType?.quality_review_date_field_id).toBeNull();
  });

  it("Overall Result has no completeness requirement on first designation -- a Finalized review with no Result value is fine", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Result No Completeness");

    await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-01-15" },
    });

    const result = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: reviewType.resultFieldId,
    });
    expect(result.error).toBeNull();
  });

  it("changing or clearing an already-designated Review Date or Overall Result is rejected once any Finalized review exists, and allowed when none exist", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Change Clear Guard");

    const firstDesignation = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: reviewType.resultFieldId,
    });
    expect(firstDesignation.error).toBeNull();

    // No Finalized records yet -- change and clear both freely allowed.
    const secondDateField = await createField(fixture.workspaceId, reviewType.entityTypeId, { key: "altDate", name: "Alt Date", type: "date", position: 6 });
    const changeFreely = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: secondDateField.id, resultFieldId: reviewType.resultFieldId,
    });
    expect(changeFreely.error).toBeNull();
    const clearFreely = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: secondDateField.id, resultFieldId: null,
    });
    expect(clearFreely.error).toBeNull();

    // Re-designate the original date field, then Finalize a review.
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: reviewType.resultFieldId,
    });
    await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-01-15", [reviewType.resultFieldKey]: reviewType.passOptionId },
    });

    const changeDateBlocked = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: secondDateField.id, resultFieldId: reviewType.resultFieldId,
    });
    expect(changeDateBlocked.error?.message).toMatch(/review date field cannot be changed or cleared/i);

    const clearDateBlocked = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: null, resultFieldId: reviewType.resultFieldId,
    });
    expect(clearDateBlocked.error?.message).toMatch(/review date field cannot be changed or cleared/i);

    const altResultField = await createField(fixture.workspaceId, reviewType.entityTypeId, { key: "altResult", name: "Alt Result", type: "choice", position: 7 });
    const changeResultBlocked = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: altResultField.id,
    });
    expect(changeResultBlocked.error?.message).toMatch(/overall result field cannot be changed or cleared/i);

    const clearResultBlocked = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: null,
    });
    expect(clearResultBlocked.error?.message).toMatch(/overall result field cannot be changed or cleared/i);

    // Resave with the identical, already-designated values -- a no-op, not a change, so it succeeds.
    const noOp = await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: reviewType.resultFieldId,
    });
    expect(noOp.error).toBeNull();
  });

  it("a designated Review Date or Overall Result field cannot be archived while designated", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Archive Guard");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: reviewType.resultFieldId,
    });

    const admin = createSupabaseTestClient();
    const dateArchive = await admin.from("field_definitions").update({ archived_at: new Date().toISOString() }).eq("id", reviewType.dateFieldId);
    expect(dateArchive.error?.message).toMatch(/designated for sensitive-record access/i);

    const resultArchive = await admin.from("field_definitions").update({ archived_at: new Date().toISOString() }).eq("id", reviewType.resultFieldId);
    expect(resultArchive.error?.message).toMatch(/designated for sensitive-record access/i);
  });
});

// ---------------------------------------------------------------------------
// FINALIZE-TIME REVIEW DATE INVARIANT
// ---------------------------------------------------------------------------
describe("finalize-time review date invariant", () => {
  it("a Draft is not required to carry a date even once the Review Date field is configured", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Draft No Date Required");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: null,
    });

    const reviewId = await createReview(builderClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
    });

    const update = await reviewerClient.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: fixture.workspaceId, p_entity_type_id: reviewType.entityTypeId, p_record_id: reviewId,
      p_values: { [reviewType.statusFieldKey]: reviewType.draftOptionId }, p_relation_field_ids: [], p_relations: [],
    });
    expect(update.error).toBeNull();
  });

  it("Finalize is rejected without a valid Review Date once one is configured, and succeeds once the Draft has one", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Finalize Date Required");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: null,
    });

    const missingDateReview = await createReview(builderClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
    });
    const missingResult = await finalizeReview(reviewerClient, fixture.workspaceId, reviewType, missingDateReview);
    expect(missingResult.error?.message).toMatch(/cannot be finalized without a valid review date/i);

    const malformedDateReview = await createReview(builderClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-13-40" },
    });
    const malformedResult = await finalizeReview(reviewerClient, fixture.workspaceId, reviewType, malformedDateReview);
    expect(malformedResult.error?.message).toMatch(/cannot be finalized without a valid review date/i);

    const validDateReview = await createReview(builderClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-03-10" },
    });
    const validResult = await finalizeReview(reviewerClient, fixture.workspaceId, reviewType, validDateReview);
    expect(validResult.error).toBeNull();
  });

  it("a Quality Review type with no Review Date field configured finalizes exactly as Phase 12.3.1, unaffected by this invariant", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "No Date Designated");

    const reviewId = await createReview(builderClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
    });
    const result = await finalizeReview(reviewerClient, fixture.workspaceId, reviewType, reviewId);
    expect(result.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RPC INPUT SECURITY
// ---------------------------------------------------------------------------
describe("list_person_quality_reviews_authorized input security", () => {
  it("a non-member is rejected outright", async () => {
    const outsider = await createUser("outsider");
    const outsiderClient = await authenticatedClient(outsider);
    const result = await listPersonReviews(outsiderClient, fixture.workspaceId, fixture.subjectPersonRecordId);
    expect(result.error?.message).toMatch(/workspace access denied/i);
  });

  it("a nonexistent Person id returns an empty result, not an error", async () => {
    const client = await authenticatedClient(fixture.coworker);
    const result = await listPersonReviews(client, fixture.workspaceId, randomUUID());
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("a record that is not of the workspace's designated Person type returns an empty result", async () => {
    const client = await authenticatedClient(fixture.coworker);
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewId = await createReview(builderClient, fixture.workspaceId, fixture.reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
    });
    const result = await listPersonReviews(client, fixture.workspaceId, reviewId);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("a Person record from a different workspace returns an empty result", async () => {
    const otherWorkspaceId = await createWorkspace("QR Presentation Foreign Person");
    const otherBuilder = await memberWithCapabilities(otherWorkspaceId, "foreign-builder", ["schema.manage"]);
    const otherBuilderClient = await authenticatedClient(otherBuilder);
    const otherPersonType = await createEntityType(otherWorkspaceId, "Foreign Person");
    await otherBuilderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: otherWorkspaceId, p_entity_type_id: otherPersonType });
    const foreignPersonId = await createRecordDirect(otherWorkspaceId, otherPersonType, {});

    const client = await authenticatedClient(fixture.coworker);
    const result = await listPersonReviews(client, fixture.workspaceId, foreignPersonId);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("a workspace with no current Person type designation returns an empty result for any id", async () => {
    const workspaceId = await createWorkspace("QR Presentation No Person Type");
    const member = await memberWithCapabilities(workspaceId, "member", ["records.operate"]);
    const client = await authenticatedClient(member);
    const result = await listPersonReviews(client, workspaceId, randomUUID());
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HISTORY ROWS
// ---------------------------------------------------------------------------
describe("list_person_quality_reviews_authorized history rows", () => {
  it("Draft never appears in history for Subject, Manager, Reviewer, or a privileged viewer -- only Finalized rows ever show, with no count leakage", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Draft Never Leaks");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, { dateFieldId: reviewType.dateFieldId, resultFieldId: null });

    const draftId = await createReview(builderClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-04-01" },
    });
    const finalizedId = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-04-02" },
    });

    for (const viewer of [fixture.subjectUser, fixture.managerUser, fixture.reviewerUser, fixture.privileged]) {
      const client = await authenticatedClient(viewer);
      const result = await listPersonReviews(client, fixture.workspaceId, fixture.subjectPersonRecordId);
      expect(result.error).toBeNull();
      const rows = (result.data ?? []) as Array<{ review_record_id: string }>;
      expect(rows.some((row) => row.review_record_id === finalizedId)).toBe(true);
      expect(rows.some((row) => row.review_record_id === draftId)).toBe(false);
    }
  });

  it("Finalized rows are visible to Subject and Manager, hidden from an unrelated coworker", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Subject Manager Coworker");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, { dateFieldId: reviewType.dateFieldId, resultFieldId: null });
    const reviewId = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-04-05" },
    });

    const subjectRows = ((await listPersonReviews(await authenticatedClient(fixture.subjectUser), fixture.workspaceId, fixture.subjectPersonRecordId)).data ?? []) as Array<{ review_record_id: string }>;
    expect(subjectRows.some((row) => row.review_record_id === reviewId)).toBe(true);

    const managerRows = ((await listPersonReviews(await authenticatedClient(fixture.managerUser), fixture.workspaceId, fixture.subjectPersonRecordId)).data ?? []) as Array<{ review_record_id: string }>;
    expect(managerRows.some((row) => row.review_record_id === reviewId)).toBe(true);

    const coworkerRows = ((await listPersonReviews(await authenticatedClient(fixture.coworker), fixture.workspaceId, fixture.subjectPersonRecordId)).data ?? []) as Array<{ review_record_id: string }>;
    expect(coworkerRows.some((row) => row.review_record_id === reviewId)).toBe(false);
  });

  it("manager access is dynamic -- a former manager loses history access and a new manager gains it immediately", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Dynamic Manager");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, { dateFieldId: reviewType.dateFieldId, resultFieldId: null });
    const reviewId = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-04-06" },
    });

    await setPrimaryManager(fixture.workspaceId, fixture.subjectUser.id, fixture.otherManagerUser.id);

    const oldManagerRows = ((await listPersonReviews(await authenticatedClient(fixture.managerUser), fixture.workspaceId, fixture.subjectPersonRecordId)).data ?? []) as Array<{ review_record_id: string }>;
    expect(oldManagerRows.some((row) => row.review_record_id === reviewId)).toBe(false);

    const newManagerRows = ((await listPersonReviews(await authenticatedClient(fixture.otherManagerUser), fixture.workspaceId, fixture.subjectPersonRecordId)).data ?? []) as Array<{ review_record_id: string }>;
    expect(newManagerRows.some((row) => row.review_record_id === reviewId)).toBe(true);

    // Restore for subsequent tests in this file that rely on fixture.managerUser.
    await setPrimaryManager(fixture.workspaceId, fixture.subjectUser.id, fixture.managerUser.id);
  });

  it("the privileged override disappears while impersonating a user without access", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Privileged Impersonation");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, { dateFieldId: reviewType.dateFieldId, resultFieldId: null });
    const reviewId = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-04-07" },
    });

    const visibleBefore = ((await listPersonReviews(builderClient, fixture.workspaceId, fixture.subjectPersonRecordId)).data ?? []) as Array<{ review_record_id: string }>;
    expect(visibleBefore.some((row) => row.review_record_id === reviewId)).toBe(true);

    await impersonate(builderClient, fixture.coworker.id, fixture.workspaceId);
    const hiddenDuringImpersonation = ((await listPersonReviews(builderClient, fixture.workspaceId, fixture.subjectPersonRecordId)).data ?? []) as Array<{ review_record_id: string }>;
    expect(hiddenDuringImpersonation.some((row) => row.review_record_id === reviewId)).toBe(false);
    await endAnyActiveSession(builderClient);
  });

  it("complete history is ordered newest Review Date first with a record-id tie break, and multiple Quality Review types each report their own identity", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Ordering Primary");
    const secondType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Ordering Secondary");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, { dateFieldId: reviewType.dateFieldId, resultFieldId: null });
    await configurePresentation(builderClient, fixture.workspaceId, secondType.entityTypeId, { dateFieldId: secondType.dateFieldId, resultFieldId: null });

    const earlier = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-01-01" },
    });
    const laterSameDateA = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-06-01" },
    });
    const laterSameDateB = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, secondType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [secondType.dateFieldKey]: "2026-06-01" },
    });

    const client = await authenticatedClient(fixture.subjectUser);
    const result = await listPersonReviews(client, fixture.workspaceId, fixture.subjectPersonRecordId);
    expect(result.error).toBeNull();
    const rows = (result.data ?? []) as Array<{ review_record_id: string; review_entity_type_id: string; review_entity_type_name: string }>;

    const relevantIds = new Set([earlier, laterSameDateA, laterSameDateB]);
    const relevantRows = rows.filter((row) => relevantIds.has(row.review_record_id));
    expect(relevantRows).toHaveLength(3);
    // Newest date first; the two 2026-06-01 rows are tie-broken by record id descending.
    const tiedPair = [laterSameDateA, laterSameDateB].sort().reverse();
    expect(relevantRows.map((row) => row.review_record_id)).toEqual([...tiedPair, earlier]);

    const secondTypeRow = relevantRows.find((row) => row.review_record_id === laterSameDateB);
    expect(secondTypeRow?.review_entity_type_id).toBe(secondType.entityTypeId);
    expect(secondTypeRow?.review_entity_type_name).not.toBe(rows.find((row) => row.review_record_id === laterSameDateA)?.review_entity_type_name);
  });

  it("Result label/color resolve correctly, an archived historical Result option remains displayable, and a missing Result is allowed", async () => {
    const builderClient = await authenticatedClient(fixture.builder);
    const reviewerClient = await authenticatedClient(fixture.reviewerUser);
    const reviewType = await createReviewType(builderClient, fixture.workspaceId, fixture.personEntityTypeId, "Result Data");
    await configurePresentation(builderClient, fixture.workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: reviewType.resultFieldId,
    });

    const withResult = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-05-01", [reviewType.resultFieldKey]: reviewType.passOptionId },
    });
    const withoutResult = await createFinalizedReview(builderClient, reviewerClient, fixture.workspaceId, reviewType, {
      reviewerPersonId: fixture.reviewerPersonRecordId, subjectPersonId: fixture.subjectPersonRecordId, personEntityTypeId: fixture.personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-05-02" },
    });

    await builderClient.rpc("archive_field_choice_option", {
      p_workspace_id: fixture.workspaceId, p_field_definition_id: reviewType.resultFieldId, p_option_id: reviewType.passOptionId,
    });

    const client = await authenticatedClient(fixture.subjectUser);
    const rows = ((await listPersonReviews(client, fixture.workspaceId, fixture.subjectPersonRecordId)).data ?? []) as Array<{
      review_record_id: string; result_option_id: string | null; result_label: string | null; result_color: string | null;
    }>;

    const withResultRow = rows.find((row) => row.review_record_id === withResult);
    expect(withResultRow?.result_option_id).toBe(reviewType.passOptionId);
    expect(withResultRow?.result_label).toBe("Pass");
    expect(withResultRow?.result_color).toBe("gray");

    const withoutResultRow = rows.find((row) => row.review_record_id === withoutResult);
    expect(withoutResultRow?.result_option_id).toBeNull();
    expect(withoutResultRow?.result_label).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REVIEWER IDENTITY REDACTION
// ---------------------------------------------------------------------------
// A Reviewer's own Person record can only ever be independently hidden if
// the Person EntityType itself is also configured people_sensitive -- the
// common case leaves it non-sensitive, where every Person record is
// trivially visible. This isolated fixture configures that (unusual but
// not structurally prevented) self-referential case for real, rather than
// asserting the redaction branch is merely unreachable.
describe("reviewer identity redaction", () => {
  it("a Reviewer whose own Person record is independently hidden is redacted, while the review itself still appears", async () => {
    const workspaceId = await createWorkspace("QR Presentation Reviewer Redaction");
    const builder = await memberWithCapabilities(workspaceId, "redaction-builder", [
      "schema.manage", "workspace.manage_members", "workspace.manage_roles", "people_data.view_all", "records.operate",
    ]);
    // subjectUser doubles as the ordinary viewer who must be able to see
    // the review itself (as its Subject) while the Reviewer's own Person
    // record stays hidden from them. anchorUser is subjectUser's manager
    // (satisfying the review's own manager_can_view branch) and separately
    // holds the one relation that makes the Reviewer's Person record
    // visible -- two independent visibility questions, deliberately kept
    // independent in this fixture.
    const subjectUser = await memberWithCapabilities(workspaceId, "redaction-subject", ["records.operate"]);
    const reviewerUser = await memberWithCapabilities(workspaceId, "redaction-reviewer", ["records.operate"]);
    const anchorUser = await memberWithCapabilities(workspaceId, "redaction-anchor", ["records.operate"]);
    const builderClient = await authenticatedClient(builder);

    const personEntityTypeId = await createEntityType(workspaceId, "Redaction Person");
    await builderClient.rpc("set_person_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: personEntityTypeId });

    // The Person type itself is made sensitive via two self-relation
    // fields: whoever the "viewer anchor" relation resolves to (through
    // its own Person link) may see this specific Person record.
    const { id: viewerAnchorFieldId } = await createField(workspaceId, personEntityTypeId, {
      key: "viewerAnchor", name: "Viewer Anchor", type: "relation", position: 2, relatedEntityTypeId: personEntityTypeId,
    });
    const { id: authorAnchorFieldId } = await createField(workspaceId, personEntityTypeId, {
      key: "authorAnchor", name: "Author Anchor", type: "relation", position: 3, relatedEntityTypeId: personEntityTypeId,
    });
    const sensitivePerson = await configureSensitive(builderClient, workspaceId, personEntityTypeId, {
      subjectFieldId: viewerAnchorFieldId, authorFieldId: authorAnchorFieldId, authorCanView: true,
    });
    if (sensitivePerson.error) throw new Error(`configure sensitive person type: ${sensitivePerson.error.message}`);

    const admin = createSupabaseTestClient();

    // Subject Person record: its viewerAnchor relation points at ITSELF,
    // resolving `linked_user_id` to subjectUser -- which grants subjectUser
    // visibility of their own Person record via the subject branch, and
    // grants subjectUser's manager (anchorUser, set below) visibility via
    // the manager branch, from that identical relation.
    const subjectPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, {});
    await setPersonLink(workspaceId, personEntityTypeId, subjectPersonRecordId, subjectUser.id);
    await admin.from("entity_record_relation_values").insert({
      workspace_id: workspaceId, source_entity_type_id: personEntityTypeId, source_record_id: subjectPersonRecordId,
      field_definition_id: viewerAnchorFieldId, target_entity_type_id: personEntityTypeId, target_record_id: subjectPersonRecordId,
    });
    await setPrimaryManager(workspaceId, subjectUser.id, anchorUser.id);

    // The Reviewer's own Person record: visible only to whoever the
    // separate anchor Person resolves to (anchorUser) -- no author-anchor
    // relation is set at all, so the author branch cannot apply to it for
    // anyone.
    const anchorPersonRecordId = await createRecordDirect(workspaceId, personEntityTypeId, {});
    await setPersonLink(workspaceId, personEntityTypeId, anchorPersonRecordId, anchorUser.id);
    const reviewerPersonRecordId = randomUUID();
    await admin.from("entity_records").insert({ id: reviewerPersonRecordId, workspace_id: workspaceId, entity_type_id: personEntityTypeId, values: {} });
    await admin.from("entity_record_relation_values").insert({
      workspace_id: workspaceId, source_entity_type_id: personEntityTypeId, source_record_id: reviewerPersonRecordId,
      field_definition_id: viewerAnchorFieldId, target_entity_type_id: personEntityTypeId, target_record_id: anchorPersonRecordId,
    });
    await setPersonLink(workspaceId, personEntityTypeId, reviewerPersonRecordId, reviewerUser.id);

    const reviewType = await createReviewType(builderClient, workspaceId, personEntityTypeId, "Redaction Review");
    await configurePresentation(builderClient, workspaceId, reviewType.entityTypeId, {
      dateFieldId: reviewType.dateFieldId, resultFieldId: null,
    });
    const reviewerClient = await authenticatedClient(reviewerUser);
    const reviewId = await createFinalizedReview(builderClient, reviewerClient, workspaceId, reviewType, {
      reviewerPersonId: reviewerPersonRecordId, subjectPersonId: subjectPersonRecordId, personEntityTypeId,
      values: { [reviewType.dateFieldKey]: "2026-04-01" },
    });

    // subjectUser: sees the Finalized review (as its own Subject) but the
    // Reviewer's identity is redacted -- they have no relation at all to
    // the Reviewer's Person record.
    const subjectClient = await authenticatedClient(subjectUser);
    const subjectRows = ((await listPersonReviews(subjectClient, workspaceId, subjectPersonRecordId)).data ?? []) as Array<{
      review_record_id: string; reviewer_person_record_id: string | null; reviewer_label: string | null;
    }>;
    const subjectRow = subjectRows.find((row) => row.review_record_id === reviewId);
    expect(subjectRow).toBeDefined();
    expect(subjectRow?.reviewer_person_record_id).toBeNull();
    expect(subjectRow?.reviewer_label).toBeNull();

    // anchorUser: sees the same review (as subjectUser's manager) AND sees
    // the Reviewer's identity, since they independently hold the one
    // relation that makes the Reviewer's Person record visible.
    const anchorClient = await authenticatedClient(anchorUser);
    const anchorRows = ((await listPersonReviews(anchorClient, workspaceId, subjectPersonRecordId)).data ?? []) as Array<{
      review_record_id: string; reviewer_person_record_id: string | null; reviewer_label: string | null;
    }>;
    const anchorRow = anchorRows.find((row) => row.review_record_id === reviewId);
    expect(anchorRow).toBeDefined();
    expect(anchorRow?.reviewer_person_record_id).toBe(reviewerPersonRecordId);
    expect(anchorRow?.reviewer_label).toBeTruthy();

    // workspaceId (via createWorkspace) and all four users (via
    // memberWithCapabilities/createUser) are already registered in the
    // shared createdWorkspaceIds/createdUserIds lists, so the file's own
    // afterAll cleans this workspace and these users up exactly like every
    // other scratch workspace in this file -- no inline cleanup needed
    // here (and duplicating it would race the shared afterAll's delete).
  }, 30_000);
});
