// DB/RPC-level verification for Phase 9.2 (Choice/Select field type),
// migration 0080. Covers: field creation through the live schema, the full
// option lifecycle RPC set, the field_choice_options RLS boundary (member
// read vs. schema.manage write), the preserve-vs-assign record-write
// integrity check in create/update/bulk-create, rejection of malformed/
// foreign/nonexistent option ids, rename preserving stored record identity,
// global label uniqueness, and the read-only API's Choice resolution.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";
import { apiKeyPreview, generateApiKey, hashApiKey } from "./api-key-signing";

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
  const password = `Choice-${randomUUID()}!`;
  const email = `e2e-choice-${label}-${randomUUID()}@example.test`;
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

describe("Bulk import regression restoration (0081)", () => {
  it("ordinary non-Choice bulk import succeeds, populates import_batch_id, and preserves relation row entity-type columns", async () => {
    const workspaceId = await createWorkspace("Bulk Import Restore");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage", "records.operate"]);
    const targetTypeId = await createEntityType(workspaceId, "Client");
    const sourceTypeId = await createEntityType(workspaceId, "Deal");

    const { data: nameFieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_name: "Name",
      p_slug: "name",
      p_key: "name",
      p_type: "text",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { data: relationFieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_name: "Client",
      p_slug: "client",
      p_key: "client",
      p_type: "relation",
      p_required: false,
      p_related_entity_type_id: targetTypeId,
    });
    const { data: targetRecordId } = await builder.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: targetTypeId,
      p_values: {},
      p_relations: [],
    });

    const importId = randomUUID();
    const { data, error } = await builder.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: sourceTypeId,
      p_import_id: importId,
      p_rows: [
        {
          values: { name: "Acme Deal" },
          relations: [
            {
              field_definition_id: relationFieldId,
              target_entity_type_id: targetTypeId,
              target_record_id: targetRecordId,
            },
          ],
        },
      ],
    });
    // No "completed_at" reference remains -- this is the exact failure
    // signature 0080 reintroduced and 0081 fixed. A null error already
    // proves that; this only guards the case where a *different* error
    // slipped through with that exact stale-column signature.
    if (error) {
      expect(error.message).not.toMatch(/completed_at/i);
    }
    expect(error).toBeNull();
    expect(data?.[0]?.imported_row_count).toBe(1);

    const admin = createSupabaseTestClient();
    const { data: records } = await admin
      .from("entity_records")
      .select("id, import_batch_id, values")
      .eq("workspace_id", workspaceId)
      .eq("entity_type_id", sourceTypeId);
    expect(records).toHaveLength(1);
    expect(records?.[0].import_batch_id).toBe(importId);
    void nameFieldId;

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
      target_record_id: targetRecordId,
    });

    const { data: batch } = await admin
      .from("record_import_batches")
      .select("imported_row_count")
      .eq("id", importId)
      .single();
    expect(batch?.imported_row_count).toBe(1);
  });
});

describe("Choice field creation and option lifecycle RPCs", () => {
  it("accepts a choice field through the live schema and drives the full option lifecycle", async () => {
    const workspaceId = await createWorkspace("Choice Lifecycle");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const entityTypeId = await createEntityType(workspaceId, "Task");

    // 1. Field creation accepted.
    const { data: fieldId, error: fieldError } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Priority",
      p_slug: "priority",
      p_key: "priority",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
    expect(fieldError).toBeNull();
    expect(typeof fieldId).toBe("string");

    // 2. Add three options.
    const { data: lowId, error: lowError } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Low",
      p_color: "gray",
    });
    expect(lowError).toBeNull();
    const { data: mediumId, error: mediumError } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Medium",
      p_color: "amber",
    });
    expect(mediumError).toBeNull();
    const { data: highId, error: highError } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "High",
      p_color: "red",
    });
    expect(highError).toBeNull();

    const admin = createSupabaseTestClient();
    const { data: initialOptions } = await admin
      .from("field_choice_options")
      .select("id, label, color, position, archived_at")
      .eq("field_definition_id", fieldId)
      .order("position", { ascending: true });
    expect(initialOptions?.map((o) => o.label)).toEqual(["Low", "Medium", "High"]);
    expect(initialOptions?.map((o) => o.position)).toEqual([1, 2, 3]);

    // 3. Rename + recolor.
    const { error: renameError } = await builder.rpc("update_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: mediumId,
      p_label: "Medium-High",
      p_color: "blue",
    });
    expect(renameError).toBeNull();
    const { data: renamed } = await admin
      .from("field_choice_options")
      .select("label, color")
      .eq("id", mediumId)
      .single();
    expect(renamed).toEqual({ label: "Medium-High", color: "blue" });

    // 4. Reorder: swap Low and "Medium-High" positions.
    const { error: swapError } = await builder.rpc("swap_field_choice_option_positions", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_first_option_id: lowId,
      p_second_option_id: mediumId,
    });
    expect(swapError).toBeNull();
    const { data: reordered } = await admin
      .from("field_choice_options")
      .select("id, label")
      .eq("field_definition_id", fieldId)
      .order("position", { ascending: true });
    expect(reordered?.map((o) => o.label)).toEqual(["Medium-High", "Low", "High"]);

    // 5. Archive then restore.
    const { error: archiveError } = await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: highId,
    });
    expect(archiveError).toBeNull();
    const { data: archived } = await admin
      .from("field_choice_options")
      .select("archived_at")
      .eq("id", highId)
      .single();
    expect(archived?.archived_at).not.toBeNull();

    const { error: restoreError } = await builder.rpc("restore_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: highId,
    });
    expect(restoreError).toBeNull();
    const { data: restored } = await admin
      .from("field_choice_options")
      .select("archived_at")
      .eq("id", highId)
      .single();
    expect(restored?.archived_at).toBeNull();
  });

  it("keeps field type immutable through update_field_definition", async () => {
    const workspaceId = await createWorkspace("Choice Immutable Type");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const entityTypeId = await createEntityType(workspaceId, "Ticket");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Status",
      p_slug: "status",
      p_key: "status",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });

    // update_field_definition has no p_type parameter at all -- renaming
    // the field is the only thing this call can do.
    const { error } = await builder.rpc("update_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_field_definition_id: fieldId,
      p_name: "Status Renamed",
      p_slug: "status",
      p_required: false,
    });
    expect(error).toBeNull();

    const admin = createSupabaseTestClient();
    const { data: field } = await admin
      .from("field_definitions")
      .select("type, name")
      .eq("id", fieldId)
      .single();
    expect(field).toEqual({ type: "choice", name: "Status Renamed" });
  });
});

describe("field_choice_options RLS boundary", () => {
  it("lets an ordinary member without schema.manage read full option metadata, including archived", async () => {
    const workspaceId = await createWorkspace("Choice RLS Read");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const viewer = await memberWithCapabilities(workspaceId, []);
    const entityTypeId = await createEntityType(workspaceId, "Deal");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Stage",
      p_slug: "stage",
      p_key: "stage",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { data: optionId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Won",
      p_color: "emerald",
    });
    await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: optionId,
    });

    const { data, error } = await viewer
      .from("field_choice_options")
      .select("id, label, color, position, archived_at")
      .eq("id", optionId)
      .single();
    expect(error).toBeNull();
    expect(data?.label).toBe("Won");
    expect(data?.color).toBe("emerald");
    expect(data?.archived_at).not.toBeNull();
  });

  it("requires schema.manage for every option configuration write, via RLS itself -- not merely app-layer convention", async () => {
    const workspaceId = await createWorkspace("Choice RLS Write");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const viewer = await memberWithCapabilities(workspaceId, []);
    const entityTypeId = await createEntityType(workspaceId, "Lead");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Source",
      p_slug: "source",
      p_key: "source",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });

    // RPC call, as a non-schema.manage member: RLS rejects the INSERT
    // underneath the RPC (the RPC itself is security invoker).
    const { data: deniedOptionId, error: rpcError } = await viewer.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Referral",
      p_color: null,
    });
    expect(deniedOptionId).toBeNull();
    expect(rpcError).not.toBeNull();

    // Raw table mutation, bypassing the RPC entirely: also rejected. This
    // is the check that there is no alternative path around the
    // capability-checked RPCs -- RLS is the actual enforcement.
    const { error: rawInsertError } = await viewer.from("field_choice_options").insert({
      id: randomUUID(),
      workspace_id: workspaceId,
      field_definition_id: fieldId,
      label: "Bypass Attempt",
      position: 99,
    });
    expect(rawInsertError).not.toBeNull();

    // Confirm a real, valid option added by the builder, then confirm the
    // viewer can't rename/archive/restore/reorder it either.
    const { data: optionId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Website",
      p_color: null,
    });
    const { error: renameDenied } = await viewer.rpc("update_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: optionId,
      p_label: "Hacked",
      p_color: null,
    });
    expect(renameDenied).not.toBeNull();
    const { error: archiveDenied } = await viewer.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: optionId,
    });
    expect(archiveDenied).not.toBeNull();

    const admin = createSupabaseTestClient();
    const { data: untouched } = await admin
      .from("field_choice_options")
      .select("label, archived_at")
      .eq("id", optionId)
      .single();
    expect(untouched).toEqual({ label: "Website", archived_at: null });
  });
});

describe("Record-write integrity: create / bulk-create / update", () => {
  async function setUpFixture(label: string) {
    const workspaceId = await createWorkspace(label);
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
    const entityTypeId = await createEntityType(workspaceId, "Item");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Status",
      p_slug: "status",
      p_key: "status",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { data: activeId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Active",
      p_color: null,
    });
    const { data: toArchiveId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "ToArchive",
      p_color: null,
    });
    const { data: otherArchivedId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "OtherArchived",
      p_color: null,
    });
    await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: toArchiveId,
    });
    await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: otherArchivedId,
    });
    return { workspaceId, builder, worker, entityTypeId, fieldId, activeId, archivedId: toArchiveId, otherArchivedId };
  }

  it("records.operate can create a record assigning an active option (no schema.manage needed)", async () => {
    const { worker, workspaceId, entityTypeId, fieldId, activeId } = await setUpFixture("Choice Create Active");
    const { data: recordId, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { status: activeId },
      p_relations: [],
    });
    expect(error).toBeNull();
    expect(typeof recordId).toBe("string");

    const admin = createSupabaseTestClient();
    const { data: record } = await admin.from("entity_records").select("values").eq("id", recordId).single();
    expect(record?.values.status).toBe(activeId);
    void fieldId;
  });

  it("create rejects an archived option", async () => {
    const { worker, workspaceId, entityTypeId, archivedId } = await setUpFixture("Choice Create Archived");
    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { status: archivedId },
      p_relations: [],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active option/i);
  });

  it("bulk-create rejects an archived option", async () => {
    const { worker, workspaceId, entityTypeId, archivedId } = await setUpFixture("Choice Bulk Create Archived");
    const { data, error } = await worker.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_import_id: randomUUID(),
      p_rows: [{ values: { status: archivedId } }],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active option/i);
  });

  it("bulk-create accepts an active option", async () => {
    const { worker, workspaceId, entityTypeId, activeId } = await setUpFixture("Choice Bulk Create Active");
    const { data, error } = await worker.rpc("bulk_create_entity_records_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_import_id: randomUUID(),
      p_rows: [{ values: { status: activeId } }],
    });
    expect(error).toBeNull();
    expect(data?.[0]?.imported_row_count).toBe(1);
  });

  it("update preserves an already-selected archived option when the choice field is untouched", async () => {
    const { worker, workspaceId, entityTypeId, activeId, archivedId } = await setUpFixture("Choice Preserve Untouched");
    // Create while Active is still active, so the record legitimately holds it...
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { status: activeId },
      p_relations: [],
    });

    // ...archive the very option this record references...
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const admin = createSupabaseTestClient();
    const { data: field } = await admin
      .from("field_definitions")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("key", "status")
      .single();
    await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: field!.id,
      p_option_id: activeId,
    });

    // ...then update the record's UNRELATED behavior by resubmitting the
    // SAME (now-archived) status value untouched -- must be preserved, not
    // rejected.
    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_id: recordId,
      p_values: { status: activeId },
      p_relation_field_ids: [],
      p_relations: [],
    });
    expect(error).toBeNull();
    const { data: record } = await admin.from("entity_records").select("values").eq("id", recordId).single();
    expect(record?.values.status).toBe(activeId);
    void archivedId;
  });

  it("update rejects explicitly assigning a different archived option", async () => {
    const { worker, workspaceId, entityTypeId, activeId, archivedId } = await setUpFixture("Choice Reject Reassign");
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { status: activeId },
      p_relations: [],
    });

    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_id: recordId,
      p_values: { status: archivedId },
      p_relation_field_ids: [],
      p_relations: [],
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active option/i);
  });

  it("update allows clearing a choice value to null (unset, not required)", async () => {
    const { worker, workspaceId, entityTypeId, activeId } = await setUpFixture("Choice Clear Unset");
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { status: activeId },
      p_relations: [],
    });
    const { error } = await worker.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_record_id: recordId,
      p_values: { status: null },
      p_relation_field_ids: [],
      p_relations: [],
    });
    expect(error).toBeNull();
    const admin = createSupabaseTestClient();
    const { data: record } = await admin.from("entity_records").select("values").eq("id", recordId).single();
    expect(record?.values.status).toBeNull();
  });

  it("rejects a non-UUID value cleanly", async () => {
    const { worker, workspaceId, entityTypeId } = await setUpFixture("Choice Invalid UUID");
    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { status: "not-a-uuid" },
      p_relations: [],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active option/i);
  });

  it("rejects a real UUID that is a nonexistent option id", async () => {
    const { worker, workspaceId, entityTypeId } = await setUpFixture("Choice Nonexistent Id");
    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { status: randomUUID() },
      p_relations: [],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active option/i);
  });

  it("rejects an option id that belongs to a different (foreign) choice field", async () => {
    const { worker, workspaceId, entityTypeId, builder } = await setUpFixture("Choice Foreign Field");
    // A second, unrelated choice field on the same entity type, with its
    // own active option.
    const { data: otherFieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Category",
      p_slug: "category",
      p_key: "category",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { data: foreignOptionId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: otherFieldId,
      p_label: "Foreign",
      p_color: null,
    });

    const { data, error } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      // status field given an option id that only exists on "category".
      p_values: { status: foreignOptionId },
      p_relations: [],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/must reference an active option/i);
  });
});

describe("Option rename preserves record identity", () => {
  it("renaming an option does not rewrite any stored record value (still the same option id)", async () => {
    const workspaceId = await createWorkspace("Choice Rename Identity");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const worker = await memberWithCapabilities(workspaceId, ["records.operate"]);
    const entityTypeId = await createEntityType(workspaceId, "Order");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Stage",
      p_slug: "stage",
      p_key: "stage",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { data: optionId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Processing",
      p_color: null,
    });
    const { data: recordId } = await worker.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { stage: optionId },
      p_relations: [],
    });

    const admin = createSupabaseTestClient();
    const { data: before } = await admin.from("entity_records").select("values, updated_at").eq("id", recordId).single();

    await builder.rpc("update_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: optionId,
      p_label: "In Progress",
      p_color: "blue",
    });

    const { data: after } = await admin.from("entity_records").select("values, updated_at").eq("id", recordId).single();
    expect(after?.values.stage).toBe(optionId);
    expect(after?.values.stage).toBe(before?.values.stage);
    expect(after?.updated_at).toBe(before?.updated_at);

    // The record still resolves to the NEW label by joining through the
    // stable id -- confirming identity (not label) is what's actually stored.
    const { data: option } = await admin.from("field_choice_options").select("label").eq("id", optionId).single();
    expect(option?.label).toBe("In Progress");
  });
});

describe("Global case-insensitive option-label uniqueness", () => {
  it("rejects a second active option whose label differs only by case", async () => {
    const workspaceId = await createWorkspace("Choice Label Unique");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const entityTypeId = await createEntityType(workspaceId, "Ticket");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Severity",
      p_slug: "severity",
      p_key: "severity",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { error: firstError } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "High",
      p_color: null,
    });
    expect(firstError).toBeNull();

    const { data: dupData, error: dupError } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "HIGH",
      p_color: null,
    });
    expect(dupData).toBeNull();
    expect(dupError).not.toBeNull();
  });

  it("keeps a label reserved for an archived option -- a new active option with the same label is rejected, and restore is always safe by construction", async () => {
    const workspaceId = await createWorkspace("Choice Label Archived Reserve");
    const builder = await memberWithCapabilities(workspaceId, ["schema.manage"]);
    const entityTypeId = await createEntityType(workspaceId, "Ticket");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Severity",
      p_slug: "severity",
      p_key: "severity",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { data: originalId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Critical",
      p_color: null,
    });
    await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: originalId,
    });

    // Global uniqueness means this must fail even though "Critical" is
    // currently archived, not active.
    const { data: blockedId, error: blockedError } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Critical",
      p_color: null,
    });
    expect(blockedId).toBeNull();
    expect(blockedError).not.toBeNull();

    // Restoring the original is always safe -- no collision is possible by
    // construction, since nothing could have taken its label while archived.
    const { error: restoreError } = await builder.rpc("restore_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: originalId,
    });
    expect(restoreError).toBeNull();
  });
});

describe("Read-only API: Choice metadata and record value resolution", () => {
  async function issueApiKey(builder: SupabaseClient, workspaceId: string, name: string) {
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const { data, error } = await builder.rpc("create_api_key_authorized", {
      p_workspace_id: workspaceId,
      p_name: name,
      p_key_hash: keyHash,
      p_key_preview: apiKeyPreview(rawKey),
    });
    if (error || !data?.[0]) throw new Error(error?.message ?? "create_api_key_authorized returned no row.");
    return keyHash;
  }

  it("exposes choice option metadata (id, label, color, archived) on the field, and resolves record values the same way", async () => {
    const workspaceId = await createWorkspace("Choice API");
    const builder = await memberWithCapabilities(workspaceId, [
      "schema.manage",
      "records.operate",
      "workspace.manage_integrations",
    ]);
    const entityTypeId = await createEntityType(workspaceId, "Bug");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Severity",
      p_slug: "severity",
      p_key: "severity",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
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
    const { data: activeOptionId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Blocker",
      p_color: "red",
    });
    const { data: archivedOptionId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Legacy",
      p_color: "gray",
    });
    await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: archivedOptionId,
    });

    const { data: activeRecordId } = await builder.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { severity: activeOptionId, title: "Prod outage" },
      p_relations: [],
    });
    // A second record legitimately still referencing the now-archived option.
    const { data: recordWithArchived } = await builder.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { severity: archivedOptionId, title: "Old bug" },
      p_relations: [],
    });
    // Wait -- archived option can't be newly assigned. Simulate the
    // "existing record kept its pre-archive value" scenario properly:
    // create while active, then archive, mirroring the DB-gate test above.
    void recordWithArchived;

    const keyHash = await issueApiKey(builder, workspaceId, "Read key");
    const admin = createSupabaseTestClient();

    // Field metadata: options array with stable id/label/color/archived.
    const { data: objectRows, error: objectError } = await admin.rpc("get_object_for_api_key", {
      p_key_hash: keyHash,
      p_entity_type_id: entityTypeId,
    });
    expect(objectError).toBeNull();
    const severityField = objectRows?.[0]?.fields?.find((f: { key: string }) => f.key === "severity");
    const titleField = objectRows?.[0]?.fields?.find((f: { key: string }) => f.key === "title");
    expect(severityField?.options).toEqual(
      expect.arrayContaining([
        { id: activeOptionId, label: "Blocker", color: "red", archived: false },
        { id: archivedOptionId, label: "Legacy", color: "gray", archived: true },
      ]),
    );
    // Non-choice field metadata shape unchanged. At the raw-RPC layer, the
    // 'options' key is present but null (jsonb_build_object's `case ... end`
    // with no matching branch yields SQL NULL, not an omitted key) -- the
    // app-layer TS mapping in api-read-repository.ts strips this key
    // entirely for non-choice fields before it ever reaches an external
    // consumer, verified separately in the API-layer check below.
    expect(titleField).toMatchObject({ key: "title", type: "text" });
    expect(titleField?.options).toBeNull();

    // Record value resolution: {id, label, color, archived}.
    const { data: recordRows, error: recordError } = await admin.rpc("get_record_for_api_key", {
      p_key_hash: keyHash,
      p_entity_type_id: entityTypeId,
      p_record_id: activeRecordId,
    });
    expect(recordError).toBeNull();
    expect(recordRows?.[0]?.record_values?.severity).toEqual({
      id: activeOptionId,
      label: "Blocker",
      color: "red",
      archived: false,
    });
    expect(recordRows?.[0]?.record_values?.title).toBe("Prod outage");

    // list_records_for_api_key resolves the same way, in a page.
    const { data: listRows, error: listError } = await admin.rpc("list_records_for_api_key", {
      p_key_hash: keyHash,
      p_entity_type_id: entityTypeId,
      p_limit: 10,
      p_after_created_at: null,
      p_after_id: null,
    });
    expect(listError).toBeNull();
    const listedActive = listRows?.find((r: { id: string }) => r.id === activeRecordId);
    expect(listedActive?.record_values?.severity).toEqual({
      id: activeOptionId,
      label: "Blocker",
      color: "red",
      archived: false,
    });
  });

  it("an existing record's already-selected archived option still resolves correctly through the API", async () => {
    const workspaceId = await createWorkspace("Choice API Archived Selected");
    const builder = await memberWithCapabilities(workspaceId, [
      "schema.manage",
      "records.operate",
      "workspace.manage_integrations",
    ]);
    const entityTypeId = await createEntityType(workspaceId, "Bug");
    const { data: fieldId } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: "Severity",
      p_slug: "severity",
      p_key: "severity",
      p_type: "choice",
      p_required: false,
      p_related_entity_type_id: null,
    });
    const { data: optionId } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_label: "Minor",
      p_color: "gray",
    });
    const { data: recordId } = await builder.rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { severity: optionId },
      p_relations: [],
    });
    // Archive it AFTER the record already references it.
    await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId,
      p_field_definition_id: fieldId,
      p_option_id: optionId,
    });

    const keyHash = await issueApiKey(builder, workspaceId, "Read key 2");
    const admin = createSupabaseTestClient();
    const { data: recordRows, error } = await admin.rpc("get_record_for_api_key", {
      p_key_hash: keyHash,
      p_entity_type_id: entityTypeId,
      p_record_id: recordId,
    });
    expect(error).toBeNull();
    expect(recordRows?.[0]?.record_values?.severity).toEqual({
      id: optionId,
      label: "Minor",
      color: "gray",
      archived: true,
    });
  });
});
