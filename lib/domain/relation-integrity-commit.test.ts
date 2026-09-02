// DB/RPC-level verification for Phase 9.3's relation-target referential
// integrity correction, migration 0082. Covers the same preserve-vs-assign
// invariant already proven for Choice (0080), applied to relation targets
// at the three canonical write RPCs: create_entity_record_with_relations,
// bulk_create_entity_records_authorized, and
// update_entity_record_with_relations. Also re-proves the 0081 bulk-import
// regression fix (ordinary non-relation import, relation row shape,
// import_batch_id) still holds unchanged after 0082.
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
  const password = `Relation-${randomUUID()}!`;
  const email = `e2e-relation-${label}-${randomUUID()}@example.test`;
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

async function archiveRecord(recordId: string) {
  const admin = createSupabaseTestClient();
  const { error } = await admin
    .from("entity_records")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", recordId);
  if (error) throw new Error(error.message);
}

// Standard fixture: a "Deal" (source) entity type with an OPTIONAL relation
// field "client" pointing to a "Client" (target) entity type, plus one
// active target record. Most CREATE/UPDATE cases build on this; a few build
// their own fixture where field required-ness or a second workspace/type
// matters.
async function setUpFixture(label: string) {
  const workspaceId = await createWorkspace(label);
  const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
  const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
  const targetTypeId = await createEntityType(workspaceId, "Client");
  const sourceTypeId = await createEntityType(workspaceId, "Deal");
  const { data: relationFieldId, error: fieldError } = await builder.rpc("add_field_definition", {
    p_workspace_id: workspaceId,
    p_entity_type_id: sourceTypeId,
    p_name: "Client",
    p_slug: "client",
    p_key: "client",
    p_type: "relation",
    p_required: false,
    p_related_entity_type_id: targetTypeId,
  });
  if (fieldError) throw new Error(fieldError.message);
  const { data: activeTargetId, error: targetError } = await worker.rpc(
    "create_entity_record_with_relations_authorized",
    { p_workspace_id: workspaceId, p_entity_type_id: targetTypeId, p_values: {}, p_relations: [] },
  );
  if (targetError) throw new Error(targetError.message);

  return { workspaceId, builder, worker, targetTypeId, sourceTypeId, relationFieldId, activeTargetId };
}

describe("CREATE: relation target integrity", () => {
  it("succeeds when the relation targets an active record", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Create Active");
    const { data: recordId, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });
    expect(error).toBeNull();
    expect(typeof recordId).toBe("string");

    const admin = createSupabaseTestClient();
    const { data: relationRows } = await admin
      .from("entity_record_relation_values")
      .select("target_record_id")
      .eq("source_record_id", recordId);
    expect(relationRows).toHaveLength(1);
    expect(relationRows?.[0].target_record_id).toBe(activeTargetId);
  });

  it("rejects a relation target that is archived", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Create Archived");
    await archiveRecord(activeTargetId);

    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active record/i);
  });

  it("rejects a target record that belongs to a different workspace", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId } =
      await setUpFixture("Relation Create Foreign Workspace");
    // A second, unrelated workspace with its own real, active record --
    // never anything to do with workspace A's "Client" entity type.
    const otherWorkspaceId = await createWorkspace("Relation Create Foreign Workspace Other");
    const otherWorker = await memberWithCapabilities(otherWorkspaceId, ["records.operate"]);
    const otherTypeId = await createEntityType(otherWorkspaceId, "Vendor");
    const { data: foreignRecordId } = await otherWorker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: otherWorkspaceId,
      p_entity_type_id: otherTypeId,
      p_values: {},
      p_relations: [],
    });

    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      // Spoofed to claim it targets workspace A's own Client type, but the
      // record id actually belongs to a different workspace entirely.
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: foreignRecordId },
      ],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active record/i);
  });

  it("rejects a target from the wrong related entity type", async () => {
    const { worker, builder, workspaceId, sourceTypeId, relationFieldId } =
      await setUpFixture("Relation Create Wrong Type");
    // A second, real, active entity type/record in the SAME workspace, but
    // not what the "client" field is configured to relate to.
    const productTypeId = await createEntityType(workspaceId, "Product");
    const { data: productRecordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: productTypeId,
      p_values: {},
      p_relations: [],
    });

    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: productTypeId, target_record_id: productRecordId },
      ],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference its own configured related object/i);
    void builder;
  });

  it("rejects creating a record that omits a required relation", async () => {
    const workspaceId = await createWorkspace("Relation Create Required Missing");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
    const targetTypeId = await createEntityType(workspaceId, "Client");
    const sourceTypeId = await createEntityType(workspaceId, "Deal");
    // Required field added while the object has zero records -- the only
    // way add_field_definition allows p_required: true.
    const { data: relationFieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_name: "Client",
      p_slug: "client",
      p_key: "client",
      p_type: "relation",
      p_required: true,
      p_related_entity_type_id: targetTypeId,
    });
    expect(typeof relationFieldId).toBe("string");

    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/is required/i);
  });
});

describe("BULK CREATE: relation target integrity", () => {
  it("accepts an active relation target", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Bulk Create Active");
    const { data, error } = await worker.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_import_id: randomUUID(),
      p_rows: [
        {
          values: {},
          relations: [
            { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
          ],
        },
      ],
    });
    expect(error).toBeNull();
    expect(data?.[0]?.imported_row_count).toBe(1);
  });

  it("rejects an archived relation target", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Bulk Create Archived");
    await archiveRecord(activeTargetId);

    const { data, error } = await worker.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_import_id: randomUUID(),
      p_rows: [
        {
          values: {},
          relations: [
            { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
          ],
        },
      ],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active record/i);
  });

  it("rejects a target from the wrong related entity type", async () => {
    const { worker, workspaceId, sourceTypeId, relationFieldId } = await setUpFixture("Relation Bulk Create Wrong Type");
    const productTypeId = await createEntityType(workspaceId, "Product");
    const { data: productRecordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: productTypeId,
      p_values: {},
      p_relations: [],
    });

    const { data, error } = await worker.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_import_id: randomUUID(),
      p_rows: [
        {
          values: {},
          relations: [
            { field_definition_id: relationFieldId, target_entity_type_id: productTypeId, target_record_id: productRecordId },
          ],
        },
      ],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference its own configured related object/i);
  });

  it("leaves ordinary non-relation bulk import behavior intact", async () => {
    const workspaceId = await createWorkspace("Relation Bulk Ordinary Import");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Title",
      p_slug: "title",
      p_key: "title",
      p_type: "text",
      p_required: false,
      p_related_entity_type_id: null,
    });

    const importId = randomUUID();
    const { data, error } = await worker.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_import_id: importId,
      p_rows: [{ values: { title: "First" } }, { values: { title: "Second" } }],
    });
    expect(error).toBeNull();
    expect(data?.[0]?.imported_row_count).toBe(2);

    const admin = createSupabaseTestClient();
    const { data: batch } = await admin
      .from("record_import_batches")
      .select("imported_row_count")
      .eq("id", importId)
      .single();
    expect(batch?.imported_row_count).toBe(2);
  });

  it("preserves 0081's relation insert shape and import_batch_id behavior", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Bulk Shape Preserved");
    const importId = randomUUID();
    const { data, error } = await worker.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_import_id: importId,
      p_rows: [
        {
          values: {},
          relations: [
            { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
          ],
        },
      ],
    });
    expect(error).toBeNull();
    expect(data?.[0]?.imported_row_count).toBe(1);

    const admin = createSupabaseTestClient();
    const { data: records } = await admin
      .from("entity_records")
      .select("id, import_batch_id")
      .eq("workspace_id", workspaceId)
      .eq("entity_type_id", sourceTypeId);
    expect(records).toHaveLength(1);
    expect(records?.[0].import_batch_id).toBe(importId);

    const { data: relationRows } = await admin
      .from("entity_record_relation_values")
      .select("source_entity_type_id, target_entity_type_id, source_record_id, target_record_id")
      .eq("workspace_id", workspaceId)
      .eq("source_record_id", records?.[0].id);
    expect(relationRows).toHaveLength(1);
    expect(relationRows?.[0]).toEqual({
      source_entity_type_id: sourceTypeId,
      target_entity_type_id: targetTypeId,
      source_record_id: records?.[0].id,
      target_record_id: activeTargetId,
    });
  });
});

describe("UPDATE: relation target integrity", () => {
  it("succeeds when reassigning to a different active target", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Update Reassign Active");
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });
    const { data: newTargetId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: targetTypeId,
      p_values: {},
      p_relations: [],
    });

    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_record_id: recordId,
      p_values: {},
      p_relation_field_ids: [relationFieldId],
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: newTargetId },
      ],
    });
    expect(error).toBeNull();

    const admin = createSupabaseTestClient();
    const { data: relationRows } = await admin
      .from("entity_record_relation_values")
      .select("target_record_id")
      .eq("source_record_id", recordId);
    expect(relationRows).toHaveLength(1);
    expect(relationRows?.[0].target_record_id).toBe(newTargetId);
  });

  it("preserves an existing archived relation target when the field is untouched", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Update Preserve Untouched");
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });
    await archiveRecord(activeTargetId);

    // Resubmit the SAME (now-archived) target for this field -- untouched,
    // must be preserved rather than rejected.
    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_record_id: recordId,
      p_values: {},
      p_relation_field_ids: [relationFieldId],
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });
    expect(error).toBeNull();

    const admin = createSupabaseTestClient();
    const { data: relationRows } = await admin
      .from("entity_record_relation_values")
      .select("target_record_id")
      .eq("source_record_id", recordId);
    expect(relationRows).toHaveLength(1);
    expect(relationRows?.[0].target_record_id).toBe(activeTargetId);
  });

  it("rejects explicitly reassigning to a different, archived target", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Update Reject Reassign Archived");
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });
    const { data: otherTargetId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: targetTypeId,
      p_values: {},
      p_relations: [],
    });
    await archiveRecord(otherTargetId);

    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_record_id: recordId,
      p_values: {},
      p_relation_field_ids: [relationFieldId],
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: otherTargetId },
      ],
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active record/i);

    // Confirm the reassignment was actually rejected -- not partially applied.
    const admin = createSupabaseTestClient();
    const { data: relationRows } = await admin
      .from("entity_record_relation_values")
      .select("target_record_id")
      .eq("source_record_id", recordId);
    expect(relationRows).toHaveLength(1);
    expect(relationRows?.[0].target_record_id).toBe(activeTargetId);
  });

  it("allows clearing an optional relation", async () => {
    const { worker, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Update Clear Optional");
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: {},
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });

    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_record_id: recordId,
      p_values: {},
      p_relation_field_ids: [relationFieldId],
      p_relations: [],
    });
    expect(error).toBeNull();

    const admin = createSupabaseTestClient();
    const { data: relationRows } = await admin
      .from("entity_record_relation_values")
      .select("id")
      .eq("source_record_id", recordId);
    expect(relationRows).toHaveLength(0);
  });

  it("rejects clearing a required relation", async () => {
    const workspaceId = await createWorkspace("Relation Update Clear Required Rejected");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
    const targetTypeId = await createEntityType(workspaceId, "Client");
    const sourceTypeId = await createEntityType(workspaceId, "Deal");
    const { data: relationFieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_name: "Client",
      p_slug: "client",
      p_key: "client",
      p_type: "relation",
      p_required: true,
      p_related_entity_type_id: targetTypeId,
    });
    const { data: activeTargetId } = await worker.rpc("create_entity_record_with_relations_authorized", {
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
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });

    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_record_id: recordId,
      p_values: {},
      p_relation_field_ids: [relationFieldId],
      p_relations: [],
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/is required/i);

    const admin = createSupabaseTestClient();
    const { data: relationRows } = await admin
      .from("entity_record_relation_values")
      .select("target_record_id")
      .eq("source_record_id", recordId);
    expect(relationRows).toHaveLength(1);
    expect(relationRows?.[0].target_record_id).toBe(activeTargetId);
  });

  it("does not silently null or reinterpret an existing relation when only primitive fields are updated", async () => {
    const { worker, builder, workspaceId, sourceTypeId, targetTypeId, relationFieldId, activeTargetId } =
      await setUpFixture("Relation Update Untouched By Primitive Edit");
    await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_name: "Notes",
      p_slug: "notes",
      p_key: "notes",
      p_type: "text",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_values: { notes: "Original" },
      p_relations: [
        { field_definition_id: relationFieldId, target_entity_type_id: targetTypeId, target_record_id: activeTargetId },
      ],
    });
    const admin = createSupabaseTestClient();
    const { data: before } = await admin
      .from("entity_record_relation_values")
      .select("id, target_record_id")
      .eq("source_record_id", recordId)
      .single();

    // p_relation_field_ids deliberately empty -- this field is not being
    // touched at all, only an unrelated primitive value.
    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_record_id: recordId,
      p_values: { notes: "Edited" },
      p_relation_field_ids: [],
      p_relations: [],
    });
    expect(error).toBeNull();

    const { data: after } = await admin
      .from("entity_record_relation_values")
      .select("id, target_record_id")
      .eq("source_record_id", recordId)
      .single();
    expect(after).toEqual(before);

    const { data: record } = await admin.from("entity_records").select("values").eq("id", recordId).single();
    expect(record?.values.notes).toBe("Edited");
  });
});
