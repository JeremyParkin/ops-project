// DB/RPC-level verification for Phase 9.5's bulk archive/restore RPC
// (migration 0083, set_entity_records_archived_authorized). The central
// property under test is genuine all-or-nothing atomicity: a batch that
// mixes valid record ids with even one invalid one must change nothing,
// not silently apply to the valid subset -- verified directly by querying
// the valid records' archived_at afterward, not merely by checking that an
// error was returned.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  if (createdWorkspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) throw new Error(error.message);
  }
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}, 30_000);

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `Bulk-${randomUUID()}!`;
  const email = `e2e-bulk-${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
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
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function memberWithCapabilities(workspaceId: string, capabilities: string[]) {
  const user = await createUser(capabilities.length ? "with-cap" : "no-cap");
  const roleId = await createRole(workspaceId, `Role ${randomUUID().slice(0, 8)}`, capabilities);
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: user.id, role_id: roleId });
  if (error) throw new Error(error.message);
  return authenticatedClient(user);
}

async function createEntityType(workspaceId: string, name: string) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error } = await admin.from("entity_types").insert({
    id,
    workspace_id: workspaceId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);
  return id;
}

async function createRecords(worker: SupabaseClient, workspaceId: string, entityTypeId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: {},
      p_relations: [],
    });
    if (error) throw new Error(error.message);
    ids.push(data as string);
  }
  return ids;
}

async function getArchivedAtByIds(recordIds: string[]) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("entity_records")
    .select("id, archived_at")
    .in("id", recordIds);
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((row) => [row.id as string, row.archived_at as string | null]));
}

async function setUpFixture(label: string, recordCount = 3) {
  const workspaceId = await createWorkspace(label);
  const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
  const entityTypeId = await createEntityType(workspaceId, "Item");
  const recordIds = await createRecords(worker, workspaceId, entityTypeId, recordCount);
  return { workspaceId, worker, entityTypeId, recordIds };
}

describe("set_entity_records_archived_authorized: input validation", () => {
  it("rejects a null p_archived value rather than treating it as restore", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Null Archived");
    const { data, error } = await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: recordIds,
      p_archived: null,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/p_archived must not be null/i);

    const after = await getArchivedAtByIds(recordIds);
    recordIds.forEach((id) => expect(after.get(id)).toBeNull());
  });

  it("rejects an empty p_record_ids array", async () => {
    const { worker, workspaceId, entityTypeId } = await setUpFixture("Bulk Empty Ids");
    const { data, error } = await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: [],
      p_archived: true,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/non-empty array/i);
  });

  it("rejects a p_record_ids array containing a null element, not just an indirect count mismatch", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Null Element");
    const { data, error } = await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: [recordIds[0], null],
      p_archived: true,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must not contain null elements/i);

    const after = await getArchivedAtByIds(recordIds);
    expect(after.get(recordIds[0])).toBeNull();
  });
});

describe("set_entity_records_archived_authorized: bulk archive", () => {
  it("archives a full valid batch in one call and returns the updated count", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Archive Full");
    const { data, error } = await worker
      .rpc("set_entity_records_archived_authorized", {
        p_workspace_id: workspaceId,
        p_entity_type_id: entityTypeId,
        p_record_ids: recordIds,
        p_archived: true,
      })
      .single<{ updated_record_count: number }>();
    expect(error).toBeNull();
    expect(data?.updated_record_count).toBe(recordIds.length);

    const after = await getArchivedAtByIds(recordIds);
    recordIds.forEach((id) => expect(after.get(id)).not.toBeNull());
  });

  it("normalizes duplicate ids in the same batch rather than rejecting them", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Archive Duplicates", 1);
    const { data, error } = await worker
      .rpc("set_entity_records_archived_authorized", {
        p_workspace_id: workspaceId,
        p_entity_type_id: entityTypeId,
        p_record_ids: [recordIds[0], recordIds[0], recordIds[0]],
        p_archived: true,
      })
      .single<{ updated_record_count: number }>();
    expect(error).toBeNull();
    expect(data?.updated_record_count).toBe(1);
  });

  it("is idempotent: an already-archived record inside the batch does not block the rest, and its own archived_at is not rewritten", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Archive Idempotent", 2);
    await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: [recordIds[0]],
      p_archived: true,
    });
    const beforeSecondCall = await getArchivedAtByIds([recordIds[0]]);
    const originalArchivedAt = beforeSecondCall.get(recordIds[0]);
    expect(originalArchivedAt).not.toBeNull();

    // A real (small) delay so a timestamp bump, if it happened, would be
    // detectable rather than coincidentally identical.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const { data, error } = await worker
      .rpc("set_entity_records_archived_authorized", {
        p_workspace_id: workspaceId,
        p_entity_type_id: entityTypeId,
        p_record_ids: recordIds,
        p_archived: true,
      })
      .single<{ updated_record_count: number }>();
    expect(error).toBeNull();
    expect(data?.updated_record_count).toBe(2);

    const after = await getArchivedAtByIds(recordIds);
    recordIds.forEach((id) => expect(after.get(id)).not.toBeNull());
    // The already-archived record's own archived_at is untouched -- a
    // no-op member of the batch doesn't have its history rewritten to
    // look like it changed just now.
    expect(after.get(recordIds[0])).toBe(originalArchivedAt);
  });

  it("is idempotent on restore: an already-active record inside the batch does not block the rest, and its updated_at is not rewritten", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Restore Idempotent", 2);
    // recordIds[0] stays active throughout; recordIds[1] is archived first
    // so the restore batch below is genuinely mixed-state.
    await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: [recordIds[1]],
      p_archived: true,
    });

    const admin = createSupabaseTestClient();
    const { data: beforeRow } = await admin
      .from("entity_records")
      .select("updated_at")
      .eq("id", recordIds[0])
      .single();
    const originalUpdatedAt = beforeRow?.updated_at;
    expect(originalUpdatedAt).toBeTruthy();

    // A real (small) delay so a timestamp bump, if it happened, would be
    // detectable rather than coincidentally identical.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const { data, error } = await worker
      .rpc("set_entity_records_archived_authorized", {
        p_workspace_id: workspaceId,
        p_entity_type_id: entityTypeId,
        p_record_ids: recordIds,
        p_archived: false,
      })
      .single<{ updated_record_count: number }>();
    expect(error).toBeNull();
    expect(data?.updated_record_count).toBe(2);

    const after = await getArchivedAtByIds(recordIds);
    recordIds.forEach((id) => expect(after.get(id)).toBeNull());

    const { data: afterRow } = await admin
      .from("entity_records")
      .select("updated_at")
      .eq("id", recordIds[0])
      .single();
    // The already-active record's own updated_at is untouched -- a no-op
    // member of the restore batch doesn't have its history rewritten to
    // look like it changed just now.
    expect(afterRow?.updated_at).toBe(originalUpdatedAt);
  });

  it("is atomic: a batch mixing valid ids with a nonexistent id changes nothing", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Archive Nonexistent", 3);
    const { data, error } = await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: [...recordIds, randomUUID()],
      p_archived: true,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/could not be found/i);

    const after = await getArchivedAtByIds(recordIds);
    recordIds.forEach((id) => expect(after.get(id)).toBeNull());
  });

  it("is atomic: a batch mixing valid ids with a foreign-workspace id changes nothing", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Archive Foreign Workspace A", 3);
    const other = await setUpFixture("Bulk Archive Foreign Workspace B", 1);

    const { data, error } = await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: [...recordIds, other.recordIds[0]],
      p_archived: true,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/could not be found/i);

    const after = await getArchivedAtByIds(recordIds);
    recordIds.forEach((id) => expect(after.get(id)).toBeNull());
    const otherAfter = await getArchivedAtByIds(other.recordIds);
    expect(otherAfter.get(other.recordIds[0])).toBeNull();
  });

  it("is atomic: a batch mixing valid ids with a wrong-entity-type id (same workspace) changes nothing", async () => {
    const { worker, workspaceId, entityTypeId, recordIds } = await setUpFixture("Bulk Archive Wrong Type", 3);
    const otherEntityTypeId = await createEntityType(workspaceId, "Other");
    const [otherTypeRecordId] = await createRecords(worker, workspaceId, otherEntityTypeId, 1);

    const { data, error } = await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: [...recordIds, otherTypeRecordId],
      p_archived: true,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/could not be found/i);

    const after = await getArchivedAtByIds(recordIds);
    recordIds.forEach((id) => expect(after.get(id)).toBeNull());
  });
});

describe("set_entity_records_archived_authorized: bulk restore", () => {
  it("restores a full valid batch, preserving id/values/relations exactly", async () => {
    const workspaceId = await createWorkspace("Bulk Restore Identity");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
    const targetTypeId = await createEntityType(workspaceId, "Client");
    const sourceTypeId = await createEntityType(workspaceId, "Deal");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_name: "Client",
      p_slug: "client",
      p_key: "client",
      p_type: "relation",
      p_required: false,
      p_related_entity_type_id: targetTypeId,
    });
    const { data: targetRecordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: targetTypeId,
      p_values: {},
      p_relations: [],
    });
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: fieldId, target_entity_type_id: targetTypeId, target_record_id: targetRecordId },
      ],
    });

    const admin = createSupabaseTestClient();
    const { data: before } = await admin
      .from("entity_records")
      .select("id, values, created_at")
      .eq("id", recordId)
      .single();
    const { data: relationsBefore } = await admin
      .from("entity_record_relation_values")
      .select("field_definition_id, target_record_id")
      .eq("source_record_id", recordId);

    await worker.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_record_ids: [recordId],
      p_archived: true,
    });
    const { data: mid } = await admin.from("entity_records").select("archived_at").eq("id", recordId).single();
    expect(mid?.archived_at).not.toBeNull();

    const { error: restoreError, data: restoreData } = await worker
      .rpc("set_entity_records_archived_authorized", {
        p_workspace_id: workspaceId,
        p_entity_type_id: sourceTypeId,
        p_record_ids: [recordId],
        p_archived: false,
      })
      .single<{ updated_record_count: number }>();
    expect(restoreError).toBeNull();
    expect(restoreData?.updated_record_count).toBe(1);

    const { data: after } = await admin
      .from("entity_records")
      .select("id, values, created_at, archived_at")
      .eq("id", recordId)
      .single();
    expect(after?.archived_at).toBeNull();
    expect(after?.id).toBe(before?.id);
    expect(after?.values).toEqual(before?.values);
    expect(after?.created_at).toBe(before?.created_at);

    const { data: relationsAfter } = await admin
      .from("entity_record_relation_values")
      .select("field_definition_id, target_record_id")
      .eq("source_record_id", recordId);
    expect(relationsAfter).toEqual(relationsBefore);
  });
});

describe("set_entity_records_archived_authorized: authorization", () => {
  it("rejects a caller without records.operate; target records remain unchanged", async () => {
    const workspaceId = await createWorkspace("Bulk No Capability");
    const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
    const viewer = await memberWithCapabilities(workspaceId, []);
    const entityTypeId = await createEntityType(workspaceId, "Item");
    const recordIds = await createRecords(worker, workspaceId, entityTypeId, 2);

    const { data, error } = await viewer.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_ids: recordIds,
      p_archived: true,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied/i);

    const after = await getArchivedAtByIds(recordIds);
    recordIds.forEach((id) => expect(after.get(id)).toBeNull());
  });
});
