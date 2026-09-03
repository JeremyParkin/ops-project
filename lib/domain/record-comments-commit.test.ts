// DB/RPC-level verification for Phase 10.1 record Comments. Requires
// migration 0085 applied. Covers: create/list validation, workspace and
// target isolation, impersonation attribution, archived-record behavior,
// tombstoning authority/audit semantics, safe-delete blocking, and the
// closed raw-table write posture.
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
  otherRecordId: string;
  worker: User;
  otherWorker: User;
  secondWorker: User;
  administrator: User;
  readOnly: User;
  deactivatedMember: User;
};

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixture: Fixture;
let administratorClientPromise: Promise<SupabaseClient> | undefined;

function uniqueEmail(label: string) {
  return `e2e-record-comments-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `RecordComments-${randomUUID()}!`;
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
    key: "name",
    name: "Name",
    slug: "name",
    type: "text",
    required: true,
    position: 1,
  });
  if (fieldError) throw new Error(fieldError.message);

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

async function createComment(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  recordId: string,
  body: string,
) {
  const { data, error } = await client.rpc("create_record_comment_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_entity_record_id: recordId,
    p_body: body,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

async function createCommentWithMentions(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  recordId: string,
  body: string,
  mentionedUserIds: string[],
) {
  const { data, error } = await client.rpc("create_record_comment_with_mentions_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_entity_record_id: recordId,
    p_body: body,
    p_mentioned_user_ids: mentionedUserIds,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

async function listComments(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  recordId: string,
) {
  const { data, error } = await client.rpc("list_record_comments_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_entity_record_id: recordId,
    p_limit: 100,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    body: string | null;
    author_user_id: string;
    author_label: string;
    real_actor_user_id: string | null;
    real_actor_label: string | null;
    created_at: string;
    tombstoned_at: string | null;
    tombstoned_by_user_id: string | null;
    tombstoned_by_label: string | null;
    tombstoned_by_real_actor_user_id: string | null;
    tombstoned_by_real_actor_label: string | null;
  }>;
}

async function endAnyActiveSession(client: SupabaseClient) {
  const { data } = await client.rpc("get_active_impersonation_authorized");
  const row = (data ?? [])[0] as { session_id: string } | undefined;
  if (row) await client.rpc("end_impersonation_session_authorized", { p_session_id: row.session_id });
}

async function createFixture(): Promise<Fixture> {
  const admin = createSupabaseTestClient();
  const workspaceId = await createWorkspace("E2E Record Comments");
  const otherWorkspaceId = await createWorkspace("E2E Record Comments Other");

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
  const otherWorker = await createUser("other-worker");
  const secondWorker = await createUser("second-worker");
  const administrator = await createUser("administrator");
  const readOnly = await createUser("read-only");
  const deactivatedMember = await createUser("deactivated");

  await addMembership(workspaceId, worker.id, workerRoleId);
  await addMembership(workspaceId, secondWorker.id, workerRoleId);
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

  const entityTypeId = await createEntityType(workspaceId, `Record Comment Object ${workspaceId.slice(0, 6)}`);
  const otherEntityTypeId = await createEntityType(otherWorkspaceId, `Record Comment Other Object ${otherWorkspaceId.slice(0, 6)}`);
  const recordId = await createRecord(workspaceId, entityTypeId, "Primary record");
  const otherRecordId = await createRecord(otherWorkspaceId, otherEntityTypeId, "Other record");

  return {
    workspaceId,
    otherWorkspaceId,
    entityTypeId,
    otherEntityTypeId,
    recordId,
    otherRecordId,
    worker,
    otherWorker,
    secondWorker,
    administrator,
    readOnly,
    deactivatedMember,
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
    throw new Error(`record-comments-commit afterAll cleanup: ${failures.length} failure(s):\n${failures.join("\n")}`);
  }
}, 30_000);

describe("record comment create/read RPCs", () => {
  it("creates trimmed comments, rejects invalid bodies, orders oldest-first with id tiebreaking, and enforces workspace/target boundaries", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const readOnlyClient = await authenticatedClient(fixture.readOnly);
    const admin = createSupabaseTestClient();

    const commentId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      "  Trimmed body  ",
    );

    const stored = await admin
      .from("record_comments")
      .select("body, author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", commentId)
      .single();
    expect(stored.error).toBeNull();
    expect(stored.data).toEqual({
      body: "Trimmed body",
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
      real_actor_user_id: null,
      real_actor_label: null,
    });

    const spacesOnly = await workerClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "   ",
    });
    expect(spacesOnly.error?.message).toContain("Comment body is required");

    const tabsAndNewlinesOnly = await workerClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "\n\t\n",
    });
    expect(tabsAndNewlinesOnly.error?.message).toContain("Comment body is required");

    const multilineCommentId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      " \n\tFirst line\n\n\t  Second line\t\n ",
    );
    const multilineStored = await admin
      .from("record_comments")
      .select("body")
      .eq("id", multilineCommentId)
      .single();
    expect(multilineStored.error).toBeNull();
    expect(multilineStored.data?.body).toBe("First line\n\n\t  Second line");

    const tooLong = await workerClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "x".repeat(4001),
    });
    expect(tooLong.error?.message).toContain("4000 characters or fewer");

    const trimmedToLimitId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      `\n${"x".repeat(4000)}\t`,
    );
    const trimmedToLimitStored = await admin
      .from("record_comments")
      .select("body")
      .eq("id", trimmedToLimitId)
      .single();
    expect(trimmedToLimitStored.error).toBeNull();
    expect(trimmedToLimitStored.data?.body).toBe("x".repeat(4000));

    const tooLongAfterTrim = await workerClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: `\n${"x".repeat(4001)}\t`,
    });
    expect(tooLongAfterTrim.error?.message).toContain("4000 characters or fewer");

    const readOnlyCreate = await readOnlyClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "Not permitted",
    });
    expect(readOnlyCreate.error?.message).toContain("records.operate");

    const foreignWorkspace = await otherWorkerClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "Foreign workspace",
    });
    expect(foreignWorkspace.error).not.toBeNull();

    const wrongEntityType = await workerClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.otherEntityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "Wrong entity type",
    });
    expect(wrongEntityType.error?.message).toContain("Record not found or archived");

    const nonexistentRecord = await workerClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: randomUUID(),
      p_body: "Missing record",
    });
    expect(nonexistentRecord.error?.message).toContain("Record not found or archived");

    const sameTimestamp = "2026-01-01T00:00:00.000Z";
    const tieIds = [randomUUID(), randomUUID()].sort();
    const { error: tieInsertError } = await admin.from("record_comments").insert([
      {
        id: tieIds[1],
        workspace_id: fixture.workspaceId,
        entity_type_id: fixture.entityTypeId,
        entity_record_id: fixture.recordId,
        body: "Tie B",
        author_user_id: fixture.worker.id,
        author_label: fixture.worker.email,
        created_at: sameTimestamp,
      },
      {
        id: tieIds[0],
        workspace_id: fixture.workspaceId,
        entity_type_id: fixture.entityTypeId,
        entity_record_id: fixture.recordId,
        body: "Tie A",
        author_user_id: fixture.worker.id,
        author_label: fixture.worker.email,
        created_at: sameTimestamp,
      },
    ]);
    expect(tieInsertError).toBeNull();

    const comments = await listComments(workerClient, fixture.workspaceId, fixture.entityTypeId, fixture.recordId);
    expect(comments.slice(0, 2).map((comment) => comment.id)).toEqual(tieIds);
    expect(comments.map((comment) => comment.id)).toContain(commentId);

    const isolatedRead = await otherWorkerClient.rpc("list_record_comments_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_limit: 100,
    });
    expect(isolatedRead.error?.message).toContain("Workspace access denied");
  });
});

describe("record comment mentions and notifications", () => {
  it("creates mentions and notifications atomically from stable active member ids", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const secondWorkerClient = await authenticatedClient(fixture.secondWorker);
    const otherWorkerClient = await authenticatedClient(fixture.otherWorker);
    const admin = createSupabaseTestClient();

    const plainCommentId = await createCommentWithMentions(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      "Plain comment through 10.2 RPC",
      [],
    );
    const plainComment = await admin
      .from("record_comments")
      .select("body")
      .eq("id", plainCommentId)
      .single();
    expect(plainComment.error).toBeNull();
    expect(plainComment.data?.body).toBe("Plain comment through 10.2 RPC");
    const plainMentions = await admin
      .from("record_comment_mentions")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", plainCommentId);
    expect(plainMentions.error).toBeNull();
    expect(plainMentions.data).toEqual([]);

    const multiMentionId = await createCommentWithMentions(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      `Looping in @${fixture.secondWorker.email} and @${fixture.administrator.email}`,
      [fixture.secondWorker.id, fixture.administrator.id],
    );
    const multiNotifications = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, record_comment_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", multiMentionId)
      .order("recipient_user_id", { ascending: true });
    expect(multiNotifications.error).toBeNull();
    expect(multiNotifications.data).toEqual([
      {
        recipient_user_id: fixture.administrator.id,
        event_type: "record_comment_mentioned",
        record_comment_id: multiMentionId,
      },
      {
        recipient_user_id: fixture.secondWorker.id,
        event_type: "record_comment_mentioned",
        record_comment_id: multiMentionId,
      },
    ].sort((a, b) => a.recipient_user_id.localeCompare(b.recipient_user_id)));

    const commentId = await createCommentWithMentions(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      ` Heads up @${fixture.secondWorker.email}\n\nStill plain text. `,
      [fixture.secondWorker.id, fixture.secondWorker.id, fixture.worker.id],
    );

    const stored = await admin
      .from("record_comments")
      .select("body, author_user_id, real_actor_user_id")
      .eq("id", commentId)
      .single();
    expect(stored.error).toBeNull();
    expect(stored.data).toEqual({
      body: `Heads up @${fixture.secondWorker.email}\n\nStill plain text.`,
      author_user_id: fixture.worker.id,
      real_actor_user_id: null,
    });

    const mentions = await admin
      .from("record_comment_mentions")
      .select("record_comment_id, mentioned_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId)
      .order("mentioned_user_id", { ascending: true });
    expect(mentions.error).toBeNull();
    expect(mentions.data).toEqual([
      { record_comment_id: commentId, mentioned_user_id: fixture.secondWorker.id },
      { record_comment_id: commentId, mentioned_user_id: fixture.worker.id },
    ].sort((a, b) => a.mentioned_user_id.localeCompare(b.mentioned_user_id)));

    const notifications = await admin
      .from("notifications")
      .select("recipient_user_id, event_type, record_comment_id, entity_type_id, entity_record_id, title, destination_href, dedup_key, read_at")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId);
    expect(notifications.error).toBeNull();
    expect(notifications.data).toEqual([
      {
        recipient_user_id: fixture.secondWorker.id,
        event_type: "record_comment_mentioned",
        record_comment_id: commentId,
        entity_type_id: fixture.entityTypeId,
        entity_record_id: fixture.recordId,
        title: `${fixture.worker.email} mentioned you`,
        destination_href: `/entities/${fixture.entityTypeId}/records/${fixture.recordId}#comment-${commentId}`,
        dedup_key: `record_comment_mention:${commentId}:${fixture.secondWorker.id}`,
        read_at: null,
      },
    ]);

    const recipientVisible = await secondWorkerClient
      .from("notifications")
      .select("recipient_user_id, record_comment_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId);
    expect(recipientVisible.error).toBeNull();
    expect(recipientVisible.data).toEqual([
      { recipient_user_id: fixture.secondWorker.id, record_comment_id: commentId },
    ]);

    const authorVisible = await workerClient
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId);
    expect(authorVisible.error).toBeNull();
    expect(authorVisible.data).toEqual([]);

    const invalidMention = await workerClient.rpc("create_record_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "Invalid recipient should roll back",
      p_mentioned_user_ids: [fixture.otherWorker.id],
    });
    expect(invalidMention.error?.message).toContain("Mention recipients must be active workspace members");

    const nonexistentMention = await workerClient.rpc("create_record_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "Nonexistent recipient should roll back",
      p_mentioned_user_ids: [randomUUID()],
    });
    expect(nonexistentMention.error?.message).toContain("Mention recipients must be active workspace members");

    const deactivatedMention = await workerClient.rpc("create_record_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "Deactivated recipient should roll back",
      p_mentioned_user_ids: [fixture.deactivatedMember.id],
    });
    expect(deactivatedMention.error?.message).toContain("Mention recipients must be active workspace members");

    const invalidStored = await admin
      .from("record_comments")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .in("body", [
        "Invalid recipient should roll back",
        "Nonexistent recipient should roll back",
        "Deactivated recipient should roll back",
      ]);
    expect(invalidStored.error).toBeNull();
    expect(invalidStored.data).toEqual([]);

    const rawMentionInsert = await workerClient.from("record_comment_mentions").insert({
      workspace_id: fixture.workspaceId,
      record_comment_id: commentId,
      mentioned_user_id: fixture.secondWorker.id,
    });
    expect(rawMentionInsert.error).not.toBeNull();

    const rawMentionUpdate = await workerClient
      .from("record_comment_mentions")
      .update({ mentioned_user_id: fixture.worker.id })
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId);
    expect(rawMentionUpdate.error).not.toBeNull();

    const rawMentionDelete = await workerClient
      .from("record_comment_mentions")
      .delete()
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId);
    expect(rawMentionDelete.error).not.toBeNull();

    const rawNotificationInsert = await workerClient.from("notifications").insert({
      workspace_id: fixture.workspaceId,
      recipient_user_id: fixture.secondWorker.id,
      event_type: "record_comment_mentioned",
      record_comment_id: commentId,
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      title: "Forged mention",
      destination_href: `/entities/${fixture.entityTypeId}/records/${fixture.recordId}#comment-${commentId}`,
      dedup_key: `forged:${randomUUID()}`,
    });
    expect(rawNotificationInsert.error).not.toBeNull();

    const tombstone = await workerClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: commentId,
    });
    expect(tombstone.error).toBeNull();

    const mentionsAfterTombstone = await admin
      .from("record_comment_mentions")
      .select("mentioned_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId);
    expect(mentionsAfterTombstone.error).toBeNull();
    expect(mentionsAfterTombstone.data).toHaveLength(2);

    const notificationAfterTombstone = await admin
      .from("notifications")
      .select("record_comment_id, recipient_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId);
    expect(notificationAfterTombstone.error).toBeNull();
    expect(notificationAfterTombstone.data).toHaveLength(1);

    const foreignWorkspaceCreate = await otherWorkerClient.rpc("create_record_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: fixture.recordId,
      p_body: "Foreign workspace mention",
      p_mentioned_user_ids: [fixture.secondWorker.id],
    });
    expect(foreignWorkspaceCreate.error).not.toBeNull();
  });

  it("keeps notification recipient reads auth.uid-scoped, including during impersonation", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const secondWorkerClient = await authenticatedClient(fixture.secondWorker);
    const adminClient = await administratorClient();

    const commentId = await createCommentWithMentions(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      `Recipient visibility @${fixture.secondWorker.email}`,
      [fixture.secondWorker.id],
    );

    const admin = createSupabaseTestClient();
    const notification = await admin
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId)
      .single();
    expect(notification.error).toBeNull();
    const notificationId = notification.data!.id;

    const workerRead = await workerClient
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", notificationId);
    expect(workerRead.error).toBeNull();
    expect(workerRead.data).toEqual([]);

    const workerMark = await workerClient.rpc("mark_notification_read_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_notification_id: notificationId,
    });
    expect(workerMark.error).toBeNull();
    const stillUnread = await admin
      .from("notifications")
      .select("read_at")
      .eq("id", notificationId)
      .single();
    expect(stillUnread.data?.read_at).toBeNull();

    const recipientMark = await secondWorkerClient.rpc("mark_notification_read_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_notification_id: notificationId,
    });
    expect(recipientMark.error).toBeNull();
    const nowRead = await admin
      .from("notifications")
      .select("read_at")
      .eq("id", notificationId)
      .single();
    expect(nowRead.data?.read_at).not.toBeNull();

    const impersonationStart = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.secondWorker.id,
    });
    expect(impersonationStart.error).toBeNull();

    const impersonatedRecipientRead = await adminClient
      .from("notifications")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("id", notificationId);
    expect(impersonatedRecipientRead.error).toBeNull();
    expect(impersonatedRecipientRead.data).toEqual([]);

    await endAnyActiveSession(adminClient);
  });

  it("keeps mention notifications navigable after tombstone and archive while blocking new archived comments", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const admin = createSupabaseTestClient();
    const archivalRecordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Mention archive target");

    const commentId = await createCommentWithMentions(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      archivalRecordId,
      `Archive-safe mention @${fixture.secondWorker.email}`,
      [fixture.secondWorker.id],
    );

    const tombstone = await workerClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: commentId,
    });
    expect(tombstone.error).toBeNull();

    const archive = await workerClient.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_record_ids: [archivalRecordId],
      p_archived: true,
    });
    expect(archive.error).toBeNull();

    const notification = await admin
      .from("notifications")
      .select("title, destination_href, record_comment_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId)
      .single();
    expect(notification.error).toBeNull();
    expect(notification.data).toEqual({
      title: `${fixture.worker.email} mentioned you`,
      destination_href: `/entities/${fixture.entityTypeId}/records/${archivalRecordId}#comment-${commentId}`,
      record_comment_id: commentId,
    });
    expect(notification.data?.title).not.toContain("Archive-safe mention");

    const listed = await listComments(workerClient, fixture.workspaceId, fixture.entityTypeId, archivalRecordId);
    const listedComment = listed.find((comment) => comment.id === commentId);
    expect(listedComment?.body).toBeNull();

    const mentionsAfterArchive = await admin
      .from("record_comment_mentions")
      .select("mentioned_user_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("record_comment_id", commentId);
    expect(mentionsAfterArchive.error).toBeNull();
    expect(mentionsAfterArchive.data).toEqual([{ mentioned_user_id: fixture.secondWorker.id }]);

    const deniedCreate = await workerClient.rpc("create_record_comment_with_mentions_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: archivalRecordId,
      p_body: `Archived mention @${fixture.secondWorker.email}`,
      p_mentioned_user_ids: [fixture.secondWorker.id],
    });
    expect(deniedCreate.error?.message).toContain("Record not found or archived");
  });

  it("stores effective author and real actor for impersonated mention comments", async () => {
    const adminClient = await administratorClient();

    const startImpersonating = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.worker.id,
    });
    expect(startImpersonating.error).toBeNull();

    const commentId = await createCommentWithMentions(
      adminClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      `Impersonated ping @${fixture.secondWorker.email}`,
      [fixture.secondWorker.id],
    );

    const [commentStorage, notificationStorage] = await Promise.all([
      createSupabaseTestClient()
        .from("record_comments")
        .select("author_user_id, author_label, real_actor_user_id, real_actor_label")
        .eq("id", commentId)
        .single(),
      createSupabaseTestClient()
        .from("notifications")
        .select("recipient_user_id, title")
        .eq("workspace_id", fixture.workspaceId)
        .eq("record_comment_id", commentId)
        .single(),
    ]);

    expect(commentStorage.error).toBeNull();
    expect(commentStorage.data).toEqual({
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
      real_actor_user_id: fixture.administrator.id,
      real_actor_label: fixture.administrator.email,
    });
    expect(notificationStorage.error).toBeNull();
    expect(notificationStorage.data).toEqual({
      recipient_user_id: fixture.secondWorker.id,
      title: `${fixture.worker.email} mentioned you`,
    });

    await endAnyActiveSession(adminClient);
  });
});

describe("record comment impersonation and tombstones", () => {
  it("records effective and real actors distinctly, ignores caller-supplied identity by construction, and tombstones with deliberate idempotency", async () => {
    const adminClient = await administratorClient();
    const workerClient = await authenticatedClient(fixture.worker);
    const secondWorkerClient = await authenticatedClient(fixture.secondWorker);

    const ordinaryCommentId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      "Worker-authored comment",
    );

    const startImpersonating = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.worker.id,
    });
    expect(startImpersonating.error).toBeNull();

    const impersonatedCommentId = await createComment(
      adminClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      "Impersonated worker comment",
    );
    const impersonatedStorage = await createSupabaseTestClient()
      .from("record_comments")
      .select("body, author_user_id, author_label, real_actor_user_id, real_actor_label")
      .eq("id", impersonatedCommentId)
      .single();
    expect(impersonatedStorage.error).toBeNull();
    expect(impersonatedStorage.data).toEqual({
      body: "Impersonated worker comment",
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
      real_actor_user_id: fixture.administrator.id,
      real_actor_label: fixture.administrator.email,
    });

    await endAnyActiveSession(adminClient);

    const deniedTombstone = await secondWorkerClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: ordinaryCommentId,
    });
    expect(deniedTombstone.error?.message).toContain("only remove your own comments");

    const createdBeforeTombstone = await createSupabaseTestClient()
      .from("record_comments")
      .select("body, author_user_id, created_at")
      .eq("id", ordinaryCommentId)
      .single();
    expect(createdBeforeTombstone.error).toBeNull();

    const ownTombstone = await workerClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: ordinaryCommentId,
    });
    expect(ownTombstone.error).toBeNull();

    const afterOwnTombstone = await createSupabaseTestClient()
      .from("record_comments")
      .select("body, author_user_id, created_at, tombstoned_at, tombstoned_by_user_id, tombstoned_by_label, tombstoned_by_real_actor_user_id")
      .eq("id", ordinaryCommentId)
      .single();
    expect(afterOwnTombstone.error).toBeNull();
    expect(afterOwnTombstone.data?.body).toBe(createdBeforeTombstone.data?.body);
    expect(afterOwnTombstone.data?.author_user_id).toBe(createdBeforeTombstone.data?.author_user_id);
    expect(afterOwnTombstone.data?.created_at).toBe(createdBeforeTombstone.data?.created_at);
    expect(afterOwnTombstone.data?.tombstoned_at).not.toBeNull();
    expect(afterOwnTombstone.data?.tombstoned_by_user_id).toBe(fixture.worker.id);
    expect(afterOwnTombstone.data?.tombstoned_by_label).toBe(fixture.worker.email);
    expect(afterOwnTombstone.data?.tombstoned_by_real_actor_user_id).toBeNull();

    const listAfterTombstone = await listComments(workerClient, fixture.workspaceId, fixture.entityTypeId, fixture.recordId);
    expect(listAfterTombstone.find((comment) => comment.id === ordinaryCommentId)?.body).toBeNull();

    const secondOwnTombstone = await workerClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: ordinaryCommentId,
    });
    expect(secondOwnTombstone.error).toBeNull();
    const afterSecondTombstone = await createSupabaseTestClient()
      .from("record_comments")
      .select("tombstoned_at, tombstoned_by_user_id")
      .eq("id", ordinaryCommentId)
      .single();
    expect(afterSecondTombstone.data).toEqual({
      tombstoned_at: afterOwnTombstone.data?.tombstoned_at,
      tombstoned_by_user_id: fixture.worker.id,
    });

    const administratorTombstone = await adminClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: impersonatedCommentId,
    });
    expect(administratorTombstone.error).toBeNull();

    const startAdminAsWorker = await adminClient.rpc("start_impersonation_session_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_target_user_id: fixture.worker.id,
    });
    expect(startAdminAsWorker.error).toBeNull();
    const workerCommentId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      "Real deleter audit target",
    );
    const impersonatedDelete = await adminClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: workerCommentId,
    });
    expect(impersonatedDelete.error).toBeNull();

    const deleterStorage = await createSupabaseTestClient()
      .from("record_comments")
      .select("tombstoned_by_user_id, tombstoned_by_label, tombstoned_by_real_actor_user_id, tombstoned_by_real_actor_label")
      .eq("id", workerCommentId)
      .single();
    expect(deleterStorage.data).toEqual({
      tombstoned_by_user_id: fixture.worker.id,
      tombstoned_by_label: fixture.worker.email,
      tombstoned_by_real_actor_user_id: fixture.administrator.id,
      tombstoned_by_real_actor_label: fixture.administrator.email,
    });

    await endAnyActiveSession(adminClient);
  });

  it("keeps archived-record discussion readable, denies new comments, and permits authorized tombstoning", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const archivedRecordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Archived target");
    const commentId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      archivedRecordId,
      "Discussion before archive",
    );

    const { error: archiveError } = await createSupabaseTestClient()
      .from("entity_records")
      .update({ archived_at: new Date().toISOString() })
      .eq("workspace_id", fixture.workspaceId)
      .eq("entity_type_id", fixture.entityTypeId)
      .eq("id", archivedRecordId);
    expect(archiveError).toBeNull();

    const readable = await listComments(workerClient, fixture.workspaceId, fixture.entityTypeId, archivedRecordId);
    expect(readable.map((comment) => comment.body)).toEqual(["Discussion before archive"]);

    const deniedCreate = await workerClient.rpc("create_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_entity_type_id: fixture.entityTypeId,
      p_entity_record_id: archivedRecordId,
      p_body: "After archive",
    });
    expect(deniedCreate.error?.message).toContain("Record not found or archived");

    const allowedTombstone = await workerClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: commentId,
    });
    expect(allowedTombstone.error).toBeNull();
  });
});

describe("record comment delete safety and raw-table posture", () => {
  it("blocks hard deletion for active and tombstoned comments without cascading rows", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const activeCommentRecordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Active comment delete safety");
    const tombstonedCommentRecordId = await createRecord(fixture.workspaceId, fixture.entityTypeId, "Tombstoned comment delete safety");
    const activeCommentId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      activeCommentRecordId,
      "Blocks delete while active",
    );
    const tombstonedCommentId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      tombstonedCommentRecordId,
      "Blocks delete after tombstone",
    );

    const tombstone = await workerClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: tombstonedCommentId,
    });
    expect(tombstone.error).toBeNull();

    const activeDelete = await workerClient
      .rpc("delete_entity_record_if_unreferenced_authorized", {
        p_workspace_id: fixture.workspaceId,
        p_entity_type_id: fixture.entityTypeId,
        p_record_id: activeCommentRecordId,
      })
      .single<{ deleted: boolean; comment_count: number }>();
    expect(activeDelete.error).toBeNull();
    expect(activeDelete.data).toEqual(expect.objectContaining({ deleted: false, comment_count: 1 }));

    const tombstonedDelete = await workerClient
      .rpc("delete_entity_record_if_unreferenced_authorized", {
        p_workspace_id: fixture.workspaceId,
        p_entity_type_id: fixture.entityTypeId,
        p_record_id: tombstonedCommentRecordId,
      })
      .single<{ deleted: boolean; comment_count: number }>();
    expect(tombstonedDelete.error).toBeNull();
    expect(tombstonedDelete.data).toEqual(expect.objectContaining({ deleted: false, comment_count: 1 }));

    const { data: commentsStillExist, error } = await createSupabaseTestClient()
      .from("record_comments")
      .select("id")
      .in("id", [activeCommentId, tombstonedCommentId]);
    expect(error).toBeNull();
    expect(commentsStillExist).toHaveLength(2);
  });

  it("keeps raw INSERT/UPDATE/DELETE unavailable to authenticated clients; authorized RPCs are the write boundary", async () => {
    const workerClient = await authenticatedClient(fixture.worker);
    const rawInsert = await workerClient.from("record_comments").insert({
      workspace_id: fixture.workspaceId,
      entity_type_id: fixture.entityTypeId,
      entity_record_id: fixture.recordId,
      body: "Raw insert",
      author_user_id: fixture.worker.id,
      author_label: fixture.worker.email,
    });
    expect(rawInsert.error).not.toBeNull();

    const rawUpdate = await workerClient
      .from("record_comments")
      .update({ body: "Raw update" })
      .eq("workspace_id", fixture.workspaceId);
    expect(rawUpdate.error).not.toBeNull();

    const rawDelete = await workerClient
      .from("record_comments")
      .delete()
      .eq("workspace_id", fixture.workspaceId);
    expect(rawDelete.error).not.toBeNull();

    const rpcCreateId = await createComment(
      workerClient,
      fixture.workspaceId,
      fixture.entityTypeId,
      fixture.recordId,
      "RPC create still works",
    );
    const rpcTombstone = await workerClient.rpc("tombstone_record_comment_authorized", {
      p_workspace_id: fixture.workspaceId,
      p_comment_id: rpcCreateId,
    });
    expect(rpcTombstone.error).toBeNull();
  });
});
