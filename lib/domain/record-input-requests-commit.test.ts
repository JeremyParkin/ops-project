// DB/RPC-level verification for Phase 10.4 record Request for Input.
// Requires migration 0089 applied. Covers: request creation/linkage,
// recipient authority, explicit response/cancel state, notification shape,
// archive behavior, impersonation attribution, validation, terminal-state
// failures, and the closed raw-table write posture.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient, deleteE2eUsers } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  entityTypeId: string;
  otherEntityTypeId: string;
  recordId: string;
  archivedRecordId: string;
  otherRecordId: string;
  worker: User;
  secondWorker: User;
  thirdWorker: User;
  administrator: User;
  readOnly: User;
  deactivatedMember: User;
  otherWorker: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
let administratorClientPromise: Promise<SupabaseClient> | undefined;

function uniqueEmail(label: string) {
  return `e2e-record-input-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `RecordInput-${randomUUID()}!`;
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
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

function administratorClient() {
  administratorClientPromise ??= authenticatedClient(fixture.administrator);
  return administratorClientPromise;
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
  const { error: roleError } = await admin.from("workspace_roles").insert({
    id: roleId,
    workspace_id: workspaceId,
    name,
  });
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
  const fieldId = randomUUID();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: entityTypeId,
    workspace_id: workspaceId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${entityTypeId.slice(0, 8)}`,
  });
  if (entityError) throw new Error(entityError.message);

  const { error: fieldError } = await admin.from("field_definitions").insert({
    id: fieldId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    key: `name_${entityTypeId.replace(/-/g, "_")}`,
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);

  const { error: displayError } = await admin.rpc("set_entity_display_field", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_field_definition_id: fieldId,
  });
  if (displayError) throw new Error(displayError.message);

  return entityTypeId;
}

async function createRecord(workspaceId: string, entityTypeId: string, name: string, archived = false) {
  const admin = createSupabaseTestClient();
  const recordId = randomUUID();
  const { error } = await admin.from("entity_records").insert({
    id: recordId,
    workspace_id: workspaceId,
    entity_type_id: entityTypeId,
    values: { name },
    archived_at: archived ? new Date().toISOString() : null,
  });
  if (error) throw new Error(error.message);
  return recordId;
}

async function createRequest(
  client: SupabaseClient,
  recipientUserId: string,
  body = "Please add the missing detail.",
  recordId = fixture.recordId,
) {
  const { data, error } = await client.rpc("create_record_input_request_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_entity_type_id: fixture.entityTypeId,
    p_entity_record_id: recordId,
    p_recipient_user_id: recipientUserId,
    p_body: body,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

async function respondRequest(client: SupabaseClient, requestId: string, body = "Here is the answer.") {
  const { data, error } = await client.rpc("respond_record_input_request_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_request_id: requestId,
    p_body: body,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

async function cancelRequest(client: SupabaseClient, requestId: string) {
  const { error } = await client.rpc("cancel_record_input_request_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
}

async function listRequests(client: SupabaseClient, recordId = fixture.recordId) {
  const { data, error } = await client.rpc("list_record_input_requests_authorized", {
    p_workspace_id: fixture.workspaceId,
    p_entity_type_id: fixture.entityTypeId,
    p_entity_record_id: recordId,
    p_limit: 100,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    origin_record_comment_id: string;
    recipient_user_id: string;
    recipient_label: string;
    response_record_comment_id: string | null;
    cancelled_at: string | null;
    cancelled_by_user_id: string | null;
    cancelled_by_real_actor_user_id: string | null;
    origin_author_user_id: string;
    origin_author_label: string;
    origin_real_actor_user_id: string | null;
    origin_real_actor_label: string | null;
    origin_created_at: string;
    response_author_user_id: string | null;
    response_author_label: string | null;
    response_real_actor_user_id: string | null;
    response_real_actor_label: string | null;
    response_created_at: string | null;
  }>;
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = await createWorkspace("E2E Record Input");
  const otherWorkspaceId = await createWorkspace("E2E Record Input Other");

  const administratorRoleId = await createRole(workspaceId, "Administrator", [
    "workspace.manage_members",
    "workspace.manage_roles",
    "schema.manage",
    "records.operate",
    "workspace.impersonate_users",
  ]);
  const workerRoleId = await createRole(workspaceId, "Worker", ["records.operate"]);
  const readOnlyRoleId = await createRole(workspaceId, "Read only", []);
  const otherWorkerRoleId = await createRole(otherWorkspaceId, "Other worker", ["records.operate"]);

  const worker = await createUser("worker");
  const secondWorker = await createUser("second-worker");
  const thirdWorker = await createUser("third-worker");
  const administrator = await createUser("administrator");
  const readOnly = await createUser("read-only");
  const deactivatedMember = await createUser("deactivated");
  const otherWorker = await createUser("other-worker");

  await addMembership(workspaceId, worker.id, workerRoleId);
  await addMembership(workspaceId, secondWorker.id, workerRoleId);
  await addMembership(workspaceId, thirdWorker.id, workerRoleId);
  await addMembership(workspaceId, administrator.id, administratorRoleId);
  await addMembership(workspaceId, readOnly.id, readOnlyRoleId);
  await addMembership(workspaceId, deactivatedMember.id, workerRoleId);
  await addMembership(otherWorkspaceId, otherWorker.id, otherWorkerRoleId);

  const { error: deactivateError } = await admin
    .from("workspace_memberships")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("user_id", deactivatedMember.id);
  if (deactivateError) throw new Error(deactivateError.message);

  const entityTypeId = await createEntityType(workspaceId, `Record Input Object ${workspaceId.slice(0, 6)}`);
  const otherEntityTypeId = await createEntityType(otherWorkspaceId, `Record Input Other Object ${otherWorkspaceId.slice(0, 6)}`);
  const recordId = await createRecord(workspaceId, entityTypeId, "Primary record");
  const archivedRecordId = await createRecord(workspaceId, entityTypeId, "Archived record", true);
  const otherRecordId = await createRecord(otherWorkspaceId, otherEntityTypeId, "Other record");

  return {
    workspaceId,
    otherWorkspaceId,
    entityTypeId,
    otherEntityTypeId,
    recordId,
    archivedRecordId,
    otherRecordId,
    worker,
    secondWorker,
    thirdWorker,
    administrator,
    readOnly,
    deactivatedMember,
    otherWorker,
  };
}

beforeAll(async () => {
  fixture = await createFixture();
}, 30_000);

beforeEach(async () => {
  await endAnyActiveSession(await administratorClient());
});

afterAll(async () => {
  const admin = createSupabaseTestClient();
  const failures: string[] = [];

  if (createdWorkspaceIds.length > 0) {
    const { error: notificationError } = await admin.from("notifications").delete().in("workspace_id", createdWorkspaceIds);
    if (notificationError) failures.push(notificationError.message);
    const { error: requestError } = await admin.from("record_input_requests").delete().in("workspace_id", createdWorkspaceIds);
    if (requestError) failures.push(requestError.message);
    const { error: commentError } = await admin.from("record_comments").delete().in("workspace_id", createdWorkspaceIds);
    if (commentError) failures.push(commentError.message);
    const { error: workspaceError } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (workspaceError) failures.push(workspaceError.message);
  }

  try {
    await deleteE2eUsers(createdUserIds, admin);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) {
    throw new Error(`record-input-requests-commit cleanup failed:\n${failures.join("\n")}`);
  }
}, 30_000);

describe("record input request creation and recipients", () => {
  it("atomically creates the origin comment, lean request row, and recipient notification without copying body into request storage", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const admin = createSupabaseTestClient();
    const body = "Please confirm:\n\n  credit limit and approver.";

    const requestId = await createRequest(workerClient, fixture.secondWorker.id, ` \t${body}\n `);

    const request = await admin
      .from("record_input_requests")
      .select("*")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", requestId)
      .single();
    expect(request.error).toBeNull();
    expect(request.data).toMatchObject({
      workspace_id: fixture.workspaceId,
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      recipient_user_id: fixture.secondWorker.id,
      response_record_comment_id: null,
      cancelled_at: null,
      cancelled_by_user_id: null,
      cancelled_by_real_actor_user_id: null,
    });
    expect(JSON.stringify(request.data)).not.toContain("credit limit");

    const origin = await admin
      .from("record_comments")
      .select("body, author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", request.data!.origin_record_comment_id)
      .single();
    expect(origin.error).toBeNull();
    expect(origin.data).toEqual({
      body,
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
      real_actor_user_id: null,
      real_actor_label: null,
    });

    const notification = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, record_input_request_id, record_comment_id, process_step_run_comment_id, entity_type_id, entity_record_id, title, destination_href, dedup_key, read_at")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_input_request_id", requestId)
      .single();
    expect(notification.error).toBeNull();
    expect(notification.data).toEqual({
      recipient_user_id: fixture.secondWorker.id,
      event_type: "record_input_request_created",
      record_input_request_id: requestId,
      record_comment_id: null,
      process_step_run_comment_id: null,
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      title: `${fixture.worker.email} requested your input`,
      destination_href: `/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${requestId}`,
      dedup_key: `record_input_request_created:${requestId}:${fixture.secondWorker.id}`,
      read_at: null,
    });
    expect(notification.data?.title).not.toContain("credit limit");
    expect(notification.data?.destination_href).not.toContain("credit limit");

    const listed = await listRequests(workerClient);
    const listedRequest = listed.find((row) => row.id === requestId);
    expect(listedRequest).toMatchObject({
      origin_record_comment_id: request.data!.origin_record_comment_id,
      recipient_user_id: fixture.secondWorker.id,
      recipient_label: fixture.secondWorker.email,
      response_record_comment_id: null,
      cancelled_at: null,
      origin_author_user_id: fixture.worker.id,
      origin_author_label: fixture.worker.email,
      response_author_user_id: null,
    });
  });

  it("limits recipient candidates and rejects read-only, foreign-workspace, inactive, self, and unauthorized callers", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const readOnlyClient = await authenticatedClient(fixture.readOnly);
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const admin = createSupabaseTestClient();

    const candidates = await workerClient.rpc("list_record_input_request_recipient_candidates_authorized", {
      p_workspace_id: fixture.workspaceId,
    });
    expect(candidates.error).toBeNull();
    expect((candidates.data ?? []).map((row: { user_id: string }) => row.user_id).sort()).toEqual([
      fixture.administrator.id,
      fixture.secondWorker.id,
      fixture.thirdWorker.id,
      fixture.worker.id,
    ].sort());

    const readOnlyRecipient = await workerClient.rpc("create_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_recipient_user_id: fixture.readOnly.id,
      p_body: "Read-only recipient rollback",
    });
    expect(readOnlyRecipient.error?.message).toContain("records.operate workspace member");

    const foreignRecipient = await workerClient.rpc("create_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_recipient_user_id: fixture.otherWorker.id,
      p_body: "Foreign recipient rollback",
    });
    expect(foreignRecipient.error?.message).toContain("records.operate workspace member");

    const inactiveRecipient = await workerClient.rpc("create_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_recipient_user_id: fixture.deactivatedMember.id,
      p_body: "Inactive recipient rollback",
    });
    expect(inactiveRecipient.error?.message).toContain("records.operate workspace member");

    const selfRecipient = await workerClient.rpc("create_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_recipient_user_id: fixture.worker.id,
      p_body: "Self recipient rollback",
    });
    expect(selfRecipient.error?.message).toContain("cannot request input from yourself");

    const readOnlyRequester = await readOnlyClient.rpc("create_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Read-only requester rollback",
    });
    expect(readOnlyRequester.error?.message).toContain("records.operate");

    const foreignRequester = await otherWorkerClient.rpc("create_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Foreign requester rollback",
    });
    expect(foreignRequester.error).not.toBeNull();

    const rolledBack = await admin
      .from("record_comments")
      .select("body")
      .eq("workspace_id", fixture.workspaceId)
      .in("body", [
        "Read-only recipient rollback",
        "Foreign recipient rollback",
        "Inactive recipient rollback",
        "Self recipient rollback",
        "Read-only requester rollback",
        "Foreign requester rollback",
      ]);
    expect(rolledBack.error).toBeNull();
    expect(rolledBack.data).toEqual([]);
  });
});

describe("record input request response state", () => {
  it("requires the intended effective recipient, leaves ordinary comments inert, creates response comment, and notifies the requester", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);
    const ordinaryUserClient = await authenticatedClient(fixture.thirdWorker);
    const admin = createSupabaseTestClient();

    const requestId = await createRequest(requesterClient, fixture.secondWorker.id, "Need a response, not just chatter.");

    const ordinaryComment = await recipientClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "Ordinary recipient comment",
    });
    expect(ordinaryComment.error).toBeNull();
    let openRequest = await admin.from("record_input_requests").select("response_record_comment_id, cancelled_at").eq("id", requestId).single();
    expect(openRequest.error).toBeNull();
    expect(openRequest.data).toEqual({ response_record_comment_id: null, cancelled_at: null });

    const wrongRecipient = await ordinaryUserClient.rpc("respond_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: requestId,
      p_body: "Wrong person should not close it",
    });
    expect(wrongRecipient.error?.message).toContain("Only the request recipient can respond");

    openRequest = await admin.from("record_input_requests").select("response_record_comment_id, cancelled_at").eq("id", requestId).single();
    expect(openRequest.error).toBeNull();
    expect(openRequest.data).toEqual({ response_record_comment_id: null, cancelled_at: null });

    const responseCommentId = await respondRequest(recipientClient, requestId, " The actual answer.\n\nThanks. ");

    const responseComment = await admin
      .from("record_comments")
      .select("body, author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", responseCommentId)
      .single();
    expect(responseComment.error).toBeNull();
    expect(responseComment.data).toEqual({
      body: "The actual answer.\n\nThanks.",
      author_user_id: fixture.secondWorker.id,
      author_label: fixture.secondWorker.email,
      real_actor_user_id: null,
      real_actor_label: null,
    });

    const respondedRequest = await admin
      .from("record_input_requests")
      .select("response_record_comment_id, cancelled_at, cancelled_by_user_id")
      .eq("id", requestId)
      .single();
    expect(respondedRequest.error).toBeNull();
    expect(respondedRequest.data).toEqual({
      response_record_comment_id: responseCommentId,
      cancelled_at: null,
      cancelled_by_user_id: null,
    });

    const listed = await listRequests(requesterClient);
    expect(listed.find((row) => row.id === requestId)).toMatchObject({
      response_record_comment_id: responseCommentId,
      response_author_user_id: fixture.secondWorker.id,
      response_author_label: fixture.secondWorker.email,
    });

    const notification = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, record_input_request_id, destination_href, title")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_input_request_id", requestId)
      .eq("event_type", "record_input_request_responded")
      .single();
    expect(notification.error).toBeNull();
    expect(notification.data).toEqual({
      recipient_user_id: fixture.worker.id,
      event_type: "record_input_request_responded",
      record_input_request_id: requestId,
      destination_href: `/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${requestId}`,
      title: `${fixture.secondWorker.email} responded to your request`,
    });
    expect(notification.data?.title).not.toContain("actual answer");

    const secondResponse = await recipientClient.rpc("respond_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: requestId,
      p_body: "Second response should fail",
    });
    expect(secondResponse.error?.message).toContain("no longer open");
    const noPartialSecond = await admin
      .from("record_comments")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("body", "Second response should fail");
    expect(noPartialSecond.error).toBeNull();
    expect(noPartialSecond.data).toEqual([]);
  });
});

describe("record input request cancellation state", () => {
  it("allows requester cancellation, rejects ordinary third-party cancellation, allows administrator cancellation, and preserves history", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);
    const ordinaryUserClient = await authenticatedClient(fixture.thirdWorker);
    const adminClient = await administratorClient();
    const admin = createSupabaseTestClient();

    const ownCancelRequestId = await createRequest(requesterClient, fixture.secondWorker.id, "Requester will cancel this.");
    const ownOriginId = (await admin.from("record_input_requests").select("origin_record_comment_id").eq("id", ownCancelRequestId).single()).data!.origin_record_comment_id;
    await cancelRequest(requesterClient, ownCancelRequestId);

    const ownCancelled = await admin
      .from("record_input_requests")
      .select("origin_record_comment_id, response_record_comment_id, cancelled_at, cancelled_by_user_id, cancelled_by_real_actor_user_id")
      .eq("id", ownCancelRequestId)
      .single();
    expect(ownCancelled.error).toBeNull();
    expect(ownCancelled.data?.origin_record_comment_id).toBe(ownOriginId);
    expect(ownCancelled.data?.response_record_comment_id).toBeNull();
    expect(ownCancelled.data?.cancelled_at).not.toBeNull();
    expect(ownCancelled.data?.cancelled_by_user_id).toBe(fixture.worker.id);
    expect(ownCancelled.data?.cancelled_by_real_actor_user_id).toBeNull();

    const originAfterCancel = await admin.from("record_comments").select("id, body").eq("id", ownOriginId).single();
    expect(originAfterCancel.error).toBeNull();
    expect(originAfterCancel.data?.body).toBe("Requester will cancel this.");

    const cancelledNotification = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, record_input_request_id, destination_href")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_input_request_id", ownCancelRequestId)
      .eq("event_type", "record_input_request_cancelled")
      .single();
    expect(cancelledNotification.error).toBeNull();
    expect(cancelledNotification.data).toEqual({
      recipient_user_id: fixture.secondWorker.id,
      event_type: "record_input_request_cancelled",
      record_input_request_id: ownCancelRequestId,
      destination_href: `/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${ownCancelRequestId}`,
    });

    const respondCancelled = await recipientClient.rpc("respond_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: ownCancelRequestId,
      p_body: "Cancelled response should fail",
    });
    expect(respondCancelled.error?.message).toContain("no longer open");

    const secondCancel = await requesterClient.rpc("cancel_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: ownCancelRequestId,
    });
    expect(secondCancel.error?.message).toContain("no longer open");

    const adminCancelRequestId = await createRequest(requesterClient, fixture.secondWorker.id, "Administrator can cancel this.");
    const ordinaryCancel = await ordinaryUserClient.rpc("cancel_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: adminCancelRequestId,
    });
    expect(ordinaryCancel.error?.message).toContain("requester or a workspace administrator");

    await cancelRequest(adminClient, adminCancelRequestId);
    const adminCancelled = await admin
      .from("record_input_requests")
      .select("cancelled_at, cancelled_by_user_id, cancelled_by_real_actor_user_id")
      .eq("id", adminCancelRequestId)
      .single();
    expect(adminCancelled.error).toBeNull();
    expect(adminCancelled.data?.cancelled_at).not.toBeNull();
    expect(adminCancelled.data?.cancelled_by_user_id).toBe(fixture.administrator.id);
    expect(adminCancelled.data?.cancelled_by_real_actor_user_id).toBeNull();
  });

  it("stores effective and real actor for impersonated cancellation", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const adminClient = await administratorClient();
    const admin = createSupabaseTestClient();
    const requestId = await createRequest(requesterClient, fixture.secondWorker.id, "Impersonated requester will cancel.");

    const startImpersonating = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.worker.id,
    });
    expect(startImpersonating.error).toBeNull();

    await cancelRequest(adminClient, requestId);

    const storage = await admin
      .from("record_input_requests")
      .select("cancelled_by_user_id, cancelled_by_real_actor_user_id")
      .eq("id", requestId)
      .single();
    expect(storage.error).toBeNull();
    expect(storage.data).toEqual({
      cancelled_by_user_id: fixture.worker.id,
      cancelled_by_real_actor_user_id: fixture.administrator.id,
    });
  });
});

describe("record input request archive, notification, and raw-table integrity", () => {
  it("keeps archived request history visible, denies new requests and responses on archived records, and still allows cancellation", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);
    const admin = createSupabaseTestClient();

    const activeRecordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Archive after request");
    const requestId = await createRequest(requesterClient, fixture.secondWorker.id, "Archive should not auto-cancel.", activeRecordId);

    const archive = await requesterClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_record_ids: [activeRecordId],
      p_archived: true,
    });
    expect(archive.error).toBeNull();

    const stillOpen = await admin
      .from("record_input_requests")
      .select("response_record_comment_id, cancelled_at")
      .eq("id", requestId)
      .single();
    expect(stillOpen.error).toBeNull();
    expect(stillOpen.data).toEqual({ response_record_comment_id: null, cancelled_at: null });

    const visibleHistory = await listRequests(requesterClient, activeRecordId);
    expect(visibleHistory.find((row) => row.id === requestId)).toMatchObject({
      origin_author_user_id: fixture.worker.id,
      response_record_comment_id: null,
      cancelled_at: null,
    });

    const newArchivedRequest = await requesterClient.rpc("create_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.archivedRecordId,
      p_recipient_user_id: fixture.secondWorker.id,
      p_body: "Archived create denied",
    });
    expect(newArchivedRequest.error?.message).toContain("Record not found or archived");

    const archivedResponse = await recipientClient.rpc("respond_record_input_request_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_request_id: requestId,
      p_body: "Archived response denied",
    });
    expect(archivedResponse.error?.message).toContain("Record not found or archived");

    await cancelRequest(requesterClient, requestId);
    const cancelled = await admin.from("record_input_requests").select("cancelled_at").eq("id", requestId).single();
    expect(cancelled.error).toBeNull();
    expect(cancelled.data?.cancelled_at).not.toBeNull();
  });

  it("enforces notification target shape, auth.uid recipient isolation, mark-read behavior, and closed raw request writes", async () => {
    const requesterClient = await authenticatedClient(fixture.worker);
    const recipientClient = await authenticatedClient(fixture.secondWorker);
    const admin = createSupabaseTestClient();
    const requestId = await createRequest(requesterClient, fixture.secondWorker.id, "Notification integrity request.");

    const createdNotification = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_input_request_id", requestId)
      .eq("event_type", "record_input_request_created")
      .single();
    expect(createdNotification.error).toBeNull();

    const requesterRead = await requesterClient
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", createdNotification.data!.id);
    expect(requesterRead.error).toBeNull();
    expect(requesterRead.data).toEqual([]);

    const recipientRead = await recipientClient
      .from("notifications")
      .select("id, read_at")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", createdNotification.data!.id);
    expect(recipientRead.error).toBeNull();
    expect(recipientRead.data).toEqual([{ id: createdNotification.data!.id, read_at: null }]);

    const requesterMark = await requesterClient.rpc("mark_notification_read_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_notification_id: createdNotification.data!.id,
    });
    expect(requesterMark.error).toBeNull();
    let unread = await admin.from("notifications").select("read_at").eq("id", createdNotification.data!.id).single();
    expect(unread.data?.read_at).toBeNull();

    const recipientMark = await recipientClient.rpc("mark_notification_read_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_notification_id: createdNotification.data!.id,
    });
    expect(recipientMark.error).toBeNull();
    unread = await admin.from("notifications").select("read_at").eq("id", createdNotification.data!.id).single();
    expect(unread.data?.read_at).not.toBeNull();

    const invalidBothTargets = await admin.from("notifications").insert({
      workspace_id: fixture.workspaceId,
      recipient_user_id: fixture.secondWorker.id,
      event_type: "record_input_request_created",
      record_input_request_id: requestId,
      record_comment_id: (await admin.from("record_input_requests").select("origin_record_comment_id").eq("id", requestId).single()).data!.origin_record_comment_id,
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      title: "Invalid shape",
      destination_href: `/entities/${fixture.entityTypeId}/records/${fixture.recordId}#input-request-${requestId}`,
      dedup_key: `invalid-shape:${randomUUID()}`,
    });
    expect(invalidBothTargets.error).not.toBeNull();

    const invalidMissingRequest = await admin.from("notifications").insert({
      workspace_id: fixture.workspaceId,
      recipient_user_id: fixture.secondWorker.id,
      event_type: "record_input_request_created",
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      title: "Invalid missing request",
      destination_href: `/entities/${fixture.entityTypeId}/records/${fixture.recordId}`,
      dedup_key: `invalid-missing:${randomUUID()}`,
    });
    expect(invalidMissingRequest.error).not.toBeNull();

    const invalidRespondedCancelled = await admin
      .from("record_input_requests")
      .update({
        response_record_comment_id: (await admin.from("record_input_requests").select("origin_record_comment_id").eq("id", requestId).single()).data!.origin_record_comment_id,
        cancelled_at: new Date().toISOString(),
        cancelled_by_user_id: fixture.worker.id,
      })
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", requestId);
    expect(invalidRespondedCancelled.error).not.toBeNull();

    const rawInsert = await recipientClient.from("record_input_requests").insert({
      workspace_id: fixture.workspaceId,
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      origin_record_comment_id: randomUUID(),
      recipient_user_id: fixture.secondWorker.id,
    });
    expect(rawInsert.error).not.toBeNull();

    const rawUpdate = await recipientClient
      .from("record_input_requests")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", requestId);
    expect(rawUpdate.error).not.toBeNull();

    const rawDelete = await recipientClient
      .from("record_input_requests")
      .delete()
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", requestId);
    expect(rawDelete.error).not.toBeNull();
  });
});

describe("record input request impersonated authorship", () => {
  it("derives requester and responder attribution from linked comments and prevents identity spoofing by construction", async () => {
    const adminClient = await administratorClient();
    const admin = createSupabaseTestClient();

    const startRequesterImpersonation = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.worker.id,
    });
    expect(startRequesterImpersonation.error).toBeNull();

    const requestId = await createRequest(adminClient, fixture.secondWorker.id, "Impersonated request body.");
    await endAnyActiveSession(adminClient);

    const startResponderImpersonation = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.secondWorker.id,
    });
    expect(startResponderImpersonation.error).toBeNull();

    const responseCommentId = await respondRequest(adminClient, requestId, "Impersonated response body.");
    const listed = await listRequests(adminClient);
    const request = listed.find((row) => row.id === requestId);
    expect(request).toMatchObject({
      origin_author_user_id: fixture.worker.id,
      origin_author_label: fixture.worker.email,
      origin_real_actor_user_id: fixture.administrator.id,
      origin_real_actor_label: fixture.administrator.email,
      response_record_comment_id: responseCommentId,
      response_author_user_id: fixture.secondWorker.id,
      response_author_label: fixture.secondWorker.email,
      response_real_actor_user_id: fixture.administrator.id,
      response_real_actor_label: fixture.administrator.email,
    });

    const storage = await admin
      .from("record_comments")
      .select("id, author_user_id, real_actor_user_id")
      .in("id", [request!.origin_record_comment_id, responseCommentId])
      .order("id", { ascending: true });
    expect(storage.error).toBeNull();
    expect(storage.data).toEqual([
      {
        id: request!.origin_record_comment_id,
        author_user_id: fixture.worker.id,
        real_actor_user_id: fixture.administrator.id,
      },
      {
        id: responseCommentId,
        author_user_id: fixture.secondWorker.id,
        real_actor_user_id: fixture.administrator.id,
      },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });
});
